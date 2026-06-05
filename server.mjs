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
const API_FOOTBALL_DAILY_REQUEST_LIMIT = Number(process.env.API_FOOTBALL_DAILY_REQUEST_LIMIT || 90);
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
    homeScore: Number.isFinite(goals.home) ? goals.home : null,
    awayScore: Number.isFinite(goals.away) ? goals.away : null,
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

function mapApiFootballState(state = "") {
  const key = String(state).toLowerCase();
  if (["ft", "aet", "pen"].includes(key) || key.includes("match finished")) return "completed";
  if (["1h", "2h", "ht", "et", "bt", "p", "int", "live"].includes(key) || key.includes("in play")) return "live";
  return "scheduled";
}

function mapApiFootballEvent(type = "", detail = "") {
  const typeKey = String(type).toLowerCase();
  const detailKey = String(detail).toLowerCase();
  const key = `${typeKey} ${detailKey}`;
  if (key.includes("yellow card")) return "yellow_card";
  if (key.includes("red card")) return "red_card";
  if (typeKey.includes("goal") && !/disallowed|cancelled|missed/.test(detailKey)) return "goal";
  return String(type || detail || "event").toLowerCase().replaceAll(" ", "_");
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

function shouldSkipProviderSync(cache, force = false) {
  const sync = resetDailySyncMeta(syncMeta(cache));
  const lastSuccess = new Date(sync.lastSuccessAt || cache.fetchedAt || 0).getTime();
  const minInterval = force ? MIN_SYNC_INTERVAL_MS : AUTO_SYNC_MS;
  const freshEnough = Number.isFinite(lastSuccess) && Date.now() - lastSuccess < minInterval;
  if (freshEnough) {
    return { skip: true, reason: "cooldown", sync };
  }
  if (sync.requests >= API_FOOTBALL_DAILY_REQUEST_LIMIT) {
    return { skip: true, reason: "daily_limit", sync };
  }
  return { skip: false, sync };
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
      requestLimit: API_FOOTBALL_DAILY_REQUEST_LIMIT,
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      nextAutoSyncAt: new Date(Date.now() + AUTO_SYNC_MS).toISOString(),
      minSyncIntervalMs: MIN_SYNC_INTERVAL_MS
    },
    matches: matches.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
  };
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
        requestLimit: API_FOOTBALL_DAILY_REQUEST_LIMIT,
        skipped: decision.reason,
        nextAutoSyncAt: new Date((new Date(decision.sync.lastSuccessAt || cached.fetchedAt || 0).getTime() || Date.now()) + AUTO_SYNC_MS).toISOString(),
        minSyncIntervalMs: MIN_SYNC_INTERVAL_MS
      }
    };
  }

  const fetched = await fetchApiFootballMatches(decision.sync);
  if (!fetched) return cached;
  await writeJson(CACHE_FILE, fetched);
  return fetched;
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
        recommended: "API-Football with scheduled cache",
        reason: "Best fit for this family app: one cached provider request can refresh World Cup fixtures, scores, events, lineups, and player statistics periodically while users read cached JSON.",
        tradeOffs: "The default cache cadence is intentionally conservative to stay under 100 API requests/day. Users can press Sync for a manual refresh, but repeated syncs are rate-limited server-side."
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
  console.log("Set API_FOOTBALL_KEY to enable scheduled API-Football cache refreshes.");
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
