import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRecords, enrichStore, readStore, updateRecord, writeStore } from "./lib/player-images.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const PUBLIC_DIR = path.join(__dirname, "public");
const SEED_DATA_DIR = path.join(__dirname, "data");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : SEED_DATA_DIR;
const CACHE_FILE = path.join(DATA_DIR, "cache", "matches.json");
const PLAYER_IMAGES_FILE = path.join(DATA_DIR, "player-images.json");
const OWNERSHIP_FILE = process.env.OWNERSHIP_FILE
  ? path.resolve(process.env.OWNERSHIP_FILE)
  : path.join(DATA_DIR, "ownership.json");

const API_FOOTBALL_BASE_URL = process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io";
const API_FOOTBALL_LEAGUE_ID = process.env.API_FOOTBALL_LEAGUE_ID || "1";
const API_FOOTBALL_SEASON = process.env.API_FOOTBALL_SEASON || "2026";
const AUTO_SYNC_MS = Number(process.env.AUTO_SYNC_MS || 4 * 60 * 60 * 1000);
const MIN_SYNC_INTERVAL_MS = Number(process.env.MIN_SYNC_INTERVAL_MS || 60 * 60 * 1000);
const MATCH_DATA_PROVIDER = (process.env.MATCH_DATA_PROVIDER || "auto").toLowerCase();
const MATCH_SYNC_DAILY_REQUEST_LIMIT = Number(process.env.MATCH_SYNC_DAILY_REQUEST_LIMIT || process.env.API_FOOTBALL_DAILY_REQUEST_LIMIT || 90);
const WORLD_CUP_DATA_URL = process.env.WORLD_CUP_DATA_URL || process.env.FIFA_WORLD_CUP_DATA_URL || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const WEB_EXTRACT_MAX_CHARS = Number(process.env.WEB_EXTRACT_MAX_CHARS || 120000);
let syncTimer = null;

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function seedRuntimeFile(relativePath) {
  const target = path.join(DATA_DIR, relativePath);
  if (await fileExists(target)) return;
  const source = path.join(SEED_DATA_DIR, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

async function ensureRuntimeData() {
  await seedRuntimeFile("ownership.json");
  await seedRuntimeFile("player-images.json");
  await seedRuntimeFile(path.join("cache", "matches.json"));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html";
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".js")) return "text/javascript";
  if (file.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function stableId(...parts) {
  return parts
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || `match-${Date.now()}`;
}

function normaliseScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

function normaliseProviderMatch(match, index = 0, source = "provider") {
  const kickoff = match.kickoff || match.date || match.fixture?.date || null;
  const parsedKickoff = kickoff ? new Date(kickoff) : null;
  const validKickoff = parsedKickoff && Number.isFinite(parsedKickoff.getTime()) ? parsedKickoff : null;
  const homeTeam = match.homeTeam || match.home_team || match.home || match.teams?.home?.name || null;
  const awayTeam = match.awayTeam || match.away_team || match.away || match.teams?.away?.name || null;
  const id = String(match.id || stableId(source, validKickoff?.toISOString().slice(0, 10), homeTeam, awayTeam, index));

  return {
    id,
    kickoff: validKickoff ? validKickoff.toISOString() : null,
    status: mapProviderState(match.status || match.state),
    minute: Number(match.minute || 0),
    homeTeam,
    awayTeam,
    homeScore: normaliseScore(match.homeScore ?? match.home_score),
    awayScore: normaliseScore(match.awayScore ?? match.away_score),
    events: (match.events || []).map((event, eventIndex) => ({
      id: String(event.id || `${id}-${event.minute || 0}-${event.team || "team"}-${event.player || eventIndex}-${event.type || "event"}`),
      minute: Number(event.minute || 0),
      type: mapProviderEvent(event.type || event.detail),
      team: event.team || null,
      player: event.player || null,
      assist: event.assist || null
    })),
    lineups: (match.lineups || []).map((entry) => ({
      player: entry.player || entry.name || null,
      team: entry.team || null,
      position: entry.position || "Player"
    })),
    playerStats: match.playerStats || match.player_stats || []
  };
}

function normaliseApiFootballFixture(item) {
  const fixture = item.fixture || {};
  const teams = item.teams || {};
  const goals = item.goals || {};
  const status = fixture.status || {};

  return {
    id: String(fixture.id),
    kickoff: fixture.date ? new Date(fixture.date).toISOString() : null,
    status: mapApiFootballState(status.short || status.long),
    minute: status.elapsed || 0,
    homeTeam: teams.home?.name,
    awayTeam: teams.away?.name,
    homeScore: normaliseScore(goals.home),
    awayScore: normaliseScore(goals.away),
    events: (item.events || []).map((event, index) => ({
      id: String(event.id || `${fixture.id}-${event.time?.elapsed || 0}-${event.team?.id || "team"}-${event.player?.id || index}-${event.type || "event"}`),
      minute: event.time?.elapsed || event.time?.extra || 0,
      type: mapApiFootballEvent(event.type, event.detail),
      team: event.team?.name || null,
      player: event.player?.name || null,
      assist: event.assist?.name || null
    })),
    lineups: (item.lineups || []).flatMap((lineup) => {
      const team = lineup.team?.name;
      return (lineup.startXI || []).map((entry) => ({
        player: entry.player?.name,
        team,
        position: entry.player?.pos || "Player"
      }));
    }),
    playerStats: (item.players || []).flatMap((team) => (team.players || []).map((entry) => ({
      player: entry.player?.name,
      team: team.team?.name,
      statistics: entry.statistics || []
    })))
  };
}

function mapProviderState(state = "") {
  const key = String(state).toLowerCase();
  if (["ft", "aet", "pen", "completed", "final"].includes(key) || key.includes("match finished") || key.includes("full time")) return "completed";
  if (["1h", "2h", "ht", "et", "bt", "p", "int", "live", "in_progress"].includes(key) || key.includes("in play") || key.includes("half")) return "live";
  return "scheduled";
}

function mapApiFootballState(state = "") {
  return mapProviderState(state);
}

function mapProviderEvent(type = "", detail = "") {
  const typeKey = String(type).toLowerCase();
  const detailKey = String(detail).toLowerCase();
  const key = `${typeKey} ${detailKey}`;
  if (key.includes("yellow card")) return "yellow_card";
  if (key.includes("red card")) return "red_card";
  if (typeKey.includes("goal") && !/disallowed|cancelled|missed/.test(detailKey)) return "goal";
  return String(type || detail || "event").toLowerCase().replaceAll(" ", "_");
}

function mapApiFootballEvent(type = "", detail = "") {
  return mapProviderEvent(type, detail);
}

function hasApiFootballErrors(errors) {
  if (!errors) return false;
  if (Array.isArray(errors)) return errors.length > 0;
  if (typeof errors === "object") return Object.keys(errors).length > 0;
  return Boolean(errors);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function syncMeta(cache) {
  return cache.sync || { date: todayKey(), requests: 0, lastAttemptAt: null, lastSuccessAt: cache.fetchedAt || null };
}

function resetDailySyncMeta(meta) {
  const key = todayKey();
  return meta.date === key ? meta : { ...meta, date: key, requests: 0 };
}

async function writeSyncMetadata(patch) {
  const latest = await readJson(CACHE_FILE);
  const sync = { ...resetDailySyncMeta(syncMeta(latest)), ...patch };
  const next = { ...latest, sync };
  await writeJson(CACHE_FILE, next);
  return next;
}

async function recordSyncError(sync, provider, message) {
  await writeSyncMetadata({
    date: sync.date,
    requests: sync.requests,
    lastAttemptAt: new Date().toISOString(),
    lastError: `${provider}: ${message}`
  });
}

function shouldSkipProviderSync(cache, force = false) {
  const sync = resetDailySyncMeta(syncMeta(cache));
  const lastSuccess = new Date(sync.lastSuccessAt || cache.fetchedAt || 0).getTime();
  const minInterval = force ? MIN_SYNC_INTERVAL_MS : AUTO_SYNC_MS;
  const freshEnough = Number.isFinite(lastSuccess) && Date.now() - lastSuccess < minInterval;
  if (freshEnough) {
    return { skip: true, reason: "cooldown", sync };
  }
  if (sync.requests >= MATCH_SYNC_DAILY_REQUEST_LIMIT) {
    return { skip: true, reason: "daily_limit", sync };
  }
  return { skip: false, sync };
}


function nextSyncAt(sync, cache, intervalMs = AUTO_SYNC_MS) {
  const lastSuccess = new Date(sync.lastSuccessAt || cache.fetchedAt || 0).getTime();
  const base = Number.isFinite(lastSuccess) && lastSuccess > 0 ? lastSuccess : Date.now();
  return new Date(Math.max(base + intervalMs, Date.now())).toISOString();
}

function hasUnresolvedSyncError(sync) {
  if (!sync.lastError) return false;
  const lastAttempt = new Date(sync.lastAttemptAt || 0).getTime();
  const lastSuccess = new Date(sync.lastSuccessAt || 0).getTime();
  return !Number.isFinite(lastSuccess) || lastAttempt > lastSuccess;
}

function providerStatus(cache) {
  const sync = resetDailySyncMeta(syncMeta(cache));
  const decision = shouldSkipProviderSync(cache, false);
  const configuredProvider = MATCH_DATA_PROVIDER === "auto"
    ? (GEMINI_API_KEY && WORLD_CUP_DATA_URL ? "gemini-web" : (process.env.API_FOOTBALL_KEY ? "api-football" : "local-cache"))
    : MATCH_DATA_PROVIDER;
  const reason = configuredProvider === "local-cache"
    ? "no_provider_configured"
    : (hasUnresolvedSyncError(sync) ? "error" : (decision.skip ? decision.reason : "ready"));

  return {
    provider: cache.provider || configuredProvider || "local",
    sourceUrl: cache.sourceUrl || WORLD_CUP_DATA_URL || null,
    fetchedAt: cache.fetchedAt || null,
    matches: Array.isArray(cache.matches) ? cache.matches.length : 0,
    canSync: configuredProvider !== "local-cache" && !decision.skip,
    reason,
    sync: {
      ...sync,
      skipped: reason === "ready" ? undefined : reason,
      requestLimit: MATCH_SYNC_DAILY_REQUEST_LIMIT,
      nextAutoSyncAt: nextSyncAt(sync, cache),
      minSyncIntervalMs: MIN_SYNC_INTERVAL_MS
    }
  };
}

async function fetchApiFootballMatches(sync) {
  const token = process.env.API_FOOTBALL_KEY;
  if (!token) return null;

  const url = new URL("/fixtures", API_FOOTBALL_BASE_URL);
  url.search = new URLSearchParams({
    league: API_FOOTBALL_LEAGUE_ID,
    season: API_FOOTBALL_SEASON,
    timezone: "UTC"
  }).toString();

  const response = await fetch(url, { headers: { "x-apisports-key": token } });
  const nextRequests = sync.requests + 1;
  if (!response.ok) {
    await writeSyncMetadata({
      date: sync.date,
      requests: nextRequests,
      lastAttemptAt: new Date().toISOString(),
      lastError: `API-Football ${response.status}: ${await response.text()}`
    });
    throw new Error(`API-Football ${response.status}`);
  }

  const payload = await response.json();
  if (hasApiFootballErrors(payload.errors)) {
    await writeSyncMetadata({
      date: sync.date,
      requests: nextRequests,
      lastAttemptAt: new Date().toISOString(),
      lastError: `API-Football errors: ${JSON.stringify(payload.errors).slice(0, 300)}`
    });
    throw new Error("API-Football returned errors");
  }

  const matches = (payload.response || []).map(normaliseApiFootballFixture);
  return {
    provider: "api-football",
    fetchedAt: new Date().toISOString(),
    sync: {
      date: sync.date,
      requests: nextRequests,
      requestLimit: MATCH_SYNC_DAILY_REQUEST_LIMIT,
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      nextAutoSyncAt: new Date(Date.now() + AUTO_SYNC_MS).toISOString(),
      minSyncIntervalMs: MIN_SYNC_INTERVAL_MS
    },
    matches: matches.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
  };
}


function stripHtmlForExtraction(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, WEB_EXTRACT_MAX_CHARS);
}

function parseGeminiJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw new Error("Gemini response did not contain a JSON object");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function geminiPrompt(pageText, sourceUrl) {
  return `Extract FIFA World Cup 2026 match data from this webpage text. Return ONLY a JSON object with this shape:
{"matches":[{"id":"stable optional id","kickoff":"ISO 8601 date/time if present, otherwise null","status":"scheduled|live|completed","minute":0,"homeTeam":"Team A","awayTeam":"Team B","homeScore":null,"awayScore":null,"events":[{"minute":0,"type":"goal|yellow_card|red_card|event","team":"Team","player":"Player","assist":null}],"lineups":[{"player":"Player","team":"Team","position":"Player"}],"playerStats":[]}]}
Rules: use null when unknown, do not invent events or lineups, keep team/player names exactly as shown, prefer UTC or source timezone converted to ISO when available, and include all visible matches.
Source URL: ${sourceUrl}
Webpage text:
${pageText}`;
}

async function fetchGeminiWebMatches(sync) {
  if (!GEMINI_API_KEY || !WORLD_CUP_DATA_URL) return null;

  const pageResponse = await fetch(WORLD_CUP_DATA_URL, { headers: { "User-Agent": "world-cup-family-cards/1.0" } });
  if (!pageResponse.ok) throw new Error(`World Cup data page ${pageResponse.status}`);

  const pageText = stripHtmlForExtraction(await pageResponse.text());
  const endpoint = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`);
  endpoint.searchParams.set("key", GEMINI_API_KEY);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: geminiPrompt(pageText, WORLD_CUP_DATA_URL) }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0 }
    })
  });

  const nextRequests = sync.requests + 1;
  if (!response.ok) {
    await writeSyncMetadata({
      date: sync.date,
      requests: nextRequests,
      lastAttemptAt: new Date().toISOString(),
      lastError: `Gemini ${response.status}: ${(await response.text()).slice(0, 300)}`
    });
    throw new Error(`Gemini ${response.status}`);
  }

  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n");
  if (!text) throw new Error("Gemini returned no extractable text");

  const extracted = parseGeminiJson(text);
  const matches = (extracted.matches || []).map((match, index) => normaliseProviderMatch(match, index, "gemini-web"));
  return {
    provider: "gemini-web",
    sourceUrl: WORLD_CUP_DATA_URL,
    model: GEMINI_MODEL,
    fetchedAt: new Date().toISOString(),
    sync: {
      date: sync.date,
      requests: nextRequests,
      requestLimit: MATCH_SYNC_DAILY_REQUEST_LIMIT,
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      nextAutoSyncAt: new Date(Date.now() + AUTO_SYNC_MS).toISOString(),
      minSyncIntervalMs: MIN_SYNC_INTERVAL_MS
    },
    matches: matches.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
  };
}

async function fetchProviderMatches(sync) {
  if (MATCH_DATA_PROVIDER === "gemini-web") return fetchGeminiWebMatches(sync);
  if (MATCH_DATA_PROVIDER === "api-football") return fetchApiFootballMatches(sync);
  return (GEMINI_API_KEY && WORLD_CUP_DATA_URL)
    ? fetchGeminiWebMatches(sync)
    : fetchApiFootballMatches(sync);
}

async function readMatchCache() {
  return readJson(CACHE_FILE);
}

async function syncMatches(force = false) {
  const cached = await readJson(CACHE_FILE);
  const decision = shouldSkipProviderSync(cached, force);
  if (decision.skip) {
    return {
      ...cached,
      sync: {
        ...decision.sync,
        requestLimit: MATCH_SYNC_DAILY_REQUEST_LIMIT,
        skipped: decision.reason,
        nextAutoSyncAt: nextSyncAt(decision.sync, cached),
        minSyncIntervalMs: MIN_SYNC_INTERVAL_MS
      }
    };
  }

  try {
    const fetched = await fetchProviderMatches(decision.sync);
    if (!fetched) {
      return {
        ...cached,
        sync: {
          ...decision.sync,
          requestLimit: MATCH_SYNC_DAILY_REQUEST_LIMIT,
          skipped: "no_provider_configured",
          lastAttemptAt: new Date().toISOString(),
          lastError: "No match data provider is configured.",
          nextAutoSyncAt: nextSyncAt(decision.sync, cached),
          minSyncIntervalMs: MIN_SYNC_INTERVAL_MS
        }
      };
    }
    await writeJson(CACHE_FILE, fetched);
    return fetched;
  } catch (error) {
    const updated = await writeSyncMetadata({
      date: decision.sync.date,
      requests: decision.sync.requests,
      lastAttemptAt: new Date().toISOString(),
      lastError: error.message
    });
    return {
      ...updated,
      sync: {
        ...updated.sync,
        requestLimit: MATCH_SYNC_DAILY_REQUEST_LIMIT,
        skipped: "error",
        nextAutoSyncAt: nextSyncAt(updated.sync, updated),
        minSyncIntervalMs: MIN_SYNC_INTERVAL_MS
      }
    };
  }
}

function json(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handler(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/healthz") return json(res, { ok: true, uptime: process.uptime() });
    if (url.pathname === "/api/ownership") return json(res, await readJson(OWNERSHIP_FILE));
    if (url.pathname === "/api/matches") return json(res, await readMatchCache());
    if (url.pathname === "/api/sync/status") return json(res, providerStatus(await readMatchCache()));
    if (url.pathname === "/api/sync") return json(res, await syncMatches(true));
    if (url.pathname === "/api/player-images") {
      const ownership = await readJson(OWNERSHIP_FILE);
      const store = ensureRecords(ownership, await readStore(PLAYER_IMAGES_FILE));
      await writeStore(PLAYER_IMAGES_FILE, store);
      return json(res, store);
    }
    if (url.pathname === "/api/player-images/update" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, await updateRecord(PLAYER_IMAGES_FILE, body.id, body.patch || {}));
    }
    if (url.pathname === "/api/player-images/enrich" && req.method === "POST") {
      const body = await readBody(req);
      const ownership = await readJson(OWNERSHIP_FILE);
      return json(res, await enrichStore({
        ownership,
        imageFile: PLAYER_IMAGES_FILE,
        recordId: body.id || "",
        limit: body.id ? 1 : Number(body.limit || 5),
        only: body.only || "missing-low",
        strategy: body.strategy || (body.id ? "wikimedia-first" : "sportsdb-only")
      }));
    }
    if (url.pathname === "/api/recommendation") {
      return json(res, {
        recommended: "Gemini webpage extraction with scheduled cache",
        reason: "Best fit for this family app: one cached Gemini extraction can turn a trusted World Cup page into normalized fixtures, scores, events, lineups, and player statistics while users read cached JSON.",
        tradeOffs: "AI extraction depends on the source page remaining readable and should be spot-checked, but the server-side cache cadence keeps Gemini or fallback API calls within conservative free-tier budgets."
      });
    }

    const safePath = path.normalize(url.pathname === "/" ? "/index.html" : url.pathname);
    const filePath = path.join(PUBLIC_DIR, safePath);
    if (!filePath.startsWith(PUBLIC_DIR)) throw new Error("Invalid path");
    const file = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(file);
  } catch (error) {
    if (error.code === "ENOENT") return json(res, { error: "Not found" }, 404);
    json(res, { error: error.message }, 500);
  }
}

await ensureRuntimeData();

http.createServer(handler).listen(PORT, HOST, () => {
  console.log(`World Cup Family Cards running at http://${HOST}:${PORT}`);
  console.log(`Using data directory: ${DATA_DIR}`);
  console.log("Set GEMINI_API_KEY + WORLD_CUP_DATA_URL for AI webpage extraction, or API_FOOTBALL_KEY for the fallback provider.");
});

async function runScheduledSync() {
  try {
    await syncMatches(false);
  } catch (error) {
    console.warn(`Scheduled sync skipped: ${error.message}`);
  }
}

runScheduledSync();
syncTimer = setInterval(runScheduledSync, AUTO_SYNC_MS);

process.on("SIGINT", () => {
  clearInterval(syncTimer);
  process.exit(0);
});
