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

const SPORTMONKS_LEAGUE_ID = process.env.SPORTMONKS_WORLD_CUP_LEAGUE_ID || "732";
const LIVE_REFRESH_MS = Number(process.env.LIVE_REFRESH_MS || 60000);
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

function normaliseSportmonksFixture(fixture) {
  const participants = fixture.participants || [];
  const home = participants.find((team) => team.meta?.location === "home") || participants[0] || {};
  const away = participants.find((team) => team.meta?.location === "away") || participants[1] || {};
  const scores = fixture.scores || [];
  const scoreFor = (teamId) => {
    const current = scores.find((score) => score.participant_id === teamId && /current|2nd-half|final/i.test(score.description || ""));
    return current?.score?.goals ?? current?.score?.participant ?? null;
  };

  return {
    id: String(fixture.id),
    kickoff: fixture.starting_at ? new Date(fixture.starting_at).toISOString() : null,
    status: mapSportmonksState(fixture.state?.name || fixture.state?.short_name),
    minute: fixture.periods?.at(-1)?.minutes || fixture.time?.minute || 0,
    homeTeam: home.name,
    awayTeam: away.name,
    homeScore: scoreFor(home.id),
    awayScore: scoreFor(away.id),
    events: (fixture.events || []).map((event) => ({
      id: String(event.id),
      minute: event.minute || event.extra_minute || 0,
      type: mapSportmonksEvent(event.type?.name || event.type?.code || event.type_id),
      team: event.participant?.name || event.team_name || null,
      player: event.player_name || event.player?.display_name || event.player?.name || null,
      assist: event.related_player_name || event.relatedplayer?.display_name || null
    })),
    lineups: (fixture.lineups || []).map((lineup) => ({
      player: lineup.player_name || lineup.player?.display_name || lineup.player?.name,
      team: lineup.team_name || lineup.participant?.name,
      position: lineup.position?.name || lineup.formation_position || "Player"
    }))
  };
}

function mapSportmonksState(state = "") {
  const key = String(state).toLowerCase();
  if (key.includes("finished") || key.includes("ended") || key === "ft") return "completed";
  if (key.includes("live") || key.includes("half") || key === "1st" || key === "2nd") return "live";
  return "scheduled";
}

function mapSportmonksEvent(type = "") {
  const key = String(type).toLowerCase();
  if (key.includes("yellow")) return "yellow_card";
  if (key.includes("red")) return "red_card";
  if (key.includes("goal")) return "goal";
  return key.replaceAll(" ", "_") || "event";
}

async function fetchSportmonksMatches() {
  const token = process.env.SPORTMONKS_API_TOKEN;
  if (!token) return null;

  const include = "scores;participants;events;lineups;state;periods";
  const urls = [
    `https://api.sportmonks.com/v3/football/livescores/inplay?api_token=${token}&filters=fixtureLeagues:${SPORTMONKS_LEAGUE_ID}&include=${include}`,
    `https://api.sportmonks.com/v3/football/fixtures?api_token=${token}&filters=fixtureLeagues:${SPORTMONKS_LEAGUE_ID}&include=${include}`
  ];

  const allFixtures = [];
  for (const url of urls) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Sportmonks ${response.status}: ${await response.text()}`);
    const payload = await response.json();
    allFixtures.push(...(payload.data || []));
  }

  const byId = new Map(allFixtures.map((fixture) => [fixture.id, normaliseSportmonksFixture(fixture)]));
  return {
    provider: "sportmonks",
    fetchedAt: new Date().toISOString(),
    matches: [...byId.values()].sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
  };
}

async function syncMatches(force = false) {
  const cached = await readJson(CACHE_FILE);
  const freshEnough = Date.now() - new Date(cached.fetchedAt).getTime() < LIVE_REFRESH_MS;
  const hasLive = cached.matches.some((match) => match.status === "live");
  if (!force && freshEnough && !hasLive) return cached;

  const fetched = await fetchSportmonksMatches();
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
    if (url.pathname === "/api/matches") return json(res, await syncMatches(false));
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
        recommended: "Sportmonks World Cup 2026 API",
        reason: "Best fit for this family app: dedicated 2026 World Cup coverage, live scores, in-game events, squads/player data, standings and brackets, clear documentation, and a low-cost tournament plan compared with enterprise feeds.",
        tradeOffs: "Free APIs are usually acceptable for fixtures/results but weak for assists, cards, player positions, squad data, and near-live reliability. Sportmonks is paid, but avoids manual score entry and gives the event detail required for recalculable fantasy scoring."
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
  console.log("Set SPORTMONKS_API_TOKEN to enable live World Cup syncing.");
});

syncTimer = setInterval(async () => {
  try {
    const cache = await readJson(CACHE_FILE);
    if (cache.matches.some((match) => match.status === "live")) await syncMatches(true);
  } catch (error) {
    console.warn(`Scheduled sync skipped: ${error.message}`);
  }
}, LIVE_REFRESH_MS);

process.on("SIGINT", () => {
  clearInterval(syncTimer);
  process.exit(0);
});
