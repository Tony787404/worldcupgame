import fs from "node:fs/promises";
import path from "node:path";

const COMMONS_SPECIAL_FILE = "https://commons.wikimedia.org/wiki/Special:FilePath/";
const USER_AGENT = "WorldCupFamilyCards/1.0 (family fantasy football card game)";

const REVIEW_WORDS = new Set(["lewandowski", "isak", "simons", "paez", "páez", "silva", "martinez", "hernandez", "rodriguez"]);

export function canonicalKey(name, teamCode) {
  return `${normaliseName(name)}__${String(teamCode || "UNK").toUpperCase()}`;
}

export function normaliseName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isPlayerCard(card) {
  if (!card) return false;
  const name = normaliseName(card.name || card.playerName);
  const category = normaliseName(card.category);
  const sourceCategory = normaliseName(card.sourceCategory);
  if (!name || name === "team crest" || name.endsWith(" crest")) return false;
  if (category === "team crest" || category === "non player" || sourceCategory === "non player") return false;
  if (["official mascot", "eternos 22", "sur bol irq"].includes(name)) return false;
  return true;
}

export function uniquePlayers(ownership) {
  const players = new Map();
  for (const card of ownership.cards || []) {
    if (!isPlayerCard(card)) continue;
    const key = canonicalKey(card.name, card.teamCode);
    if (!players.has(key)) {
      players.set(key, {
        id: key,
        canonicalPlayerName: normaliseName(card.name),
        displayName: card.name,
        teamCode: card.teamCode || "",
        team: card.team || "",
        category: card.category || "",
        cardIds: []
      });
    }
    players.get(key).cardIds.push(card.id);
  }
  return [...players.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function readStore(imageFile) {
  try {
    const store = JSON.parse(await fs.readFile(imageFile, "utf8"));
    return { schema: "player_images.v1", updatedAt: new Date().toISOString(), records: [], ...store };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { schema: "player_images.v1", updatedAt: new Date().toISOString(), records: [] };
  }
}

export async function writeStore(imageFile, store) {
  await fs.mkdir(path.dirname(imageFile), { recursive: true });
  await fs.writeFile(imageFile, JSON.stringify({ ...store, updatedAt: new Date().toISOString() }, null, 2));
}

export function ensureRecords(ownership, store) {
  const existing = new Map((store.records || []).map((record) => [record.id, record]));
  const now = new Date().toISOString();
  for (const player of uniquePlayers(ownership)) {
    if (existing.has(player.id)) {
      const record = existing.get(player.id);
      record.displayName = record.displayName || player.displayName;
      record.teamCode = record.teamCode || player.teamCode;
      record.cardIds = player.cardIds;
      continue;
    }
    existing.set(player.id, {
      id: player.id,
      canonicalPlayerName: player.canonicalPlayerName,
      displayName: player.displayName,
      teamCode: player.teamCode,
      team: player.team,
      imageUrl: "",
      thumbnailUrl: "",
      source: "",
      sourcePageUrl: "",
      licence: "",
      attribution: "",
      confidence: "low",
      status: "missing",
      manualOverrideUrl: "",
      notes: "No lookup has been accepted yet.",
      cardIds: player.cardIds,
      createdAt: now,
      updatedAt: now,
      lastCheckedAt: ""
    });
  }
  return { ...store, records: [...existing.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)) };
}

export function imageForCard(card, imageStore) {
  if (!isPlayerCard(card)) return null;
  const record = (imageStore.records || []).find((item) => item.id === canonicalKey(card.name, card.teamCode));
  if (!record) return null;
  const url = record.manualOverrideUrl || record.thumbnailUrl || record.imageUrl;
  if (!url || record.status === "rejected") return { ...record, resolvedUrl: "" };
  return { ...record, resolvedUrl: url };
}

export async function updateRecord(imageFile, id, patch) {
  const store = await readStore(imageFile);
  const index = store.records.findIndex((record) => record.id === id);
  if (index === -1) throw new Error(`No image record found for ${id}`);
  const current = store.records[index];
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  if (patch.manualOverrideUrl) {
    next.status = "manual";
    next.confidence = "high";
    next.source = "manual override";
    next.imageUrl = patch.manualOverrideUrl;
    next.thumbnailUrl = patch.manualOverrideUrl;
  }
  if (patch.clearManualOverride) {
    next.manualOverrideUrl = "";
    if (next.status === "manual") next.status = next.imageUrl ? "found" : "missing";
    delete next.clearManualOverride;
  }
  store.records[index] = next;
  await writeStore(imageFile, store);
  return next;
}

export async function enrichStore({ ownership, imageFile, limit = Infinity, only = "missing-low", recordId = "", strategy = "wikimedia-first" }) {
  let store = ensureRecords(ownership, await readStore(imageFile));
  let changed = 0;
  for (const record of store.records) {
    if (record.manualOverrideUrl) continue;
    if (recordId && record.id !== recordId) continue;
    if (!recordId && (record.imageUrl || record.thumbnailUrl) && ["found", "needs_review", "manual"].includes(record.status)) continue;
    if (only === "missing-low" && !["missing", "needs_review"].includes(record.status) && record.confidence !== "low") continue;
    if (!recordId && only === "missing-low" && record.status === "missing" && record.lastCheckedAt && record.source === "TheSportsDB") continue;
    if (changed >= limit) break;
    let enriched;
    try {
      enriched = await lookupPlayerImage(record, { strategy });
    } catch (error) {
      enriched = {
        status: "needs_review",
        confidence: "low",
        source: "image lookup",
        notes: friendlyLookupError(error)
      };
    }
    if (["missing", "rejected"].includes(enriched.status) && !record.manualOverrideUrl) {
      if (record.imageUrl || record.thumbnailUrl) {
        enriched = {
          ...enriched,
          imageUrl: record.imageUrl,
          thumbnailUrl: record.thumbnailUrl,
          status: "needs_review",
          confidence: record.confidence || "low",
          source: record.source || enriched.source,
          sourcePageUrl: record.sourcePageUrl || enriched.sourcePageUrl,
          licence: record.licence || enriched.licence,
          attribution: record.attribution || enriched.attribution,
          notes: "Existing image candidate preserved. Latest lookup did not return a better candidate."
        };
      } else {
        enriched.imageUrl = "";
        enriched.thumbnailUrl = "";
      }
    }
    Object.assign(record, enriched, {
      updatedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString()
    });
    changed += 1;
    await sleep(strategy === "wikimedia-first" ? 1400 : 650);
  }
  await writeStore(imageFile, store);
  return { changed, total: store.records.length, records: store.records };
}

export async function lookupPlayerImage(record, options = {}) {
  const strategy = options.strategy || "wikimedia-first";
  if (strategy === "sportsdb-first" || strategy === "sportsdb-only") {
    const sportsDb = await safeSportsDbLookup(record);
    if (sportsDb) return sportsDb;
    if (strategy === "sportsdb-only") {
      return {
        status: "missing",
        confidence: "low",
        source: "TheSportsDB",
        notes: "No TheSportsDB player image candidate found. Try a one-player Wikimedia lookup or add a manual override."
      };
    }
  }

  const name = record.displayName;
  let searchHits = [];
  try {
    searchHits = await wikidataSearch(name);
  } catch (error) {
    const fallback = await safeSportsDbLookup(record);
    if (fallback) return fallback;
    return {
      status: "missing",
      confidence: "low",
      source: isRateLimit(error) ? "Wikimedia rate limit" : "Wikimedia lookup",
      notes: friendlyLookupError(error)
    };
  }
  const candidates = [];
  for (const hit of searchHits.slice(0, 6)) {
    let entity;
    try {
      entity = await wikidataEntity(hit.id);
    } catch (error) {
      if (isRateLimit(error)) {
        const fallback = await safeSportsDbLookup(record);
        if (fallback) return fallback;
        return {
          status: "missing",
          confidence: "low",
          source: "Wikimedia rate limit",
          notes: friendlyLookupError(error)
        };
      }
      throw error;
    }
    const imageName = entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    const isFootballer = hasAnyClaim(entity, "P106", ["Q937857"]) || hasAnyClaim(entity, "P641", ["Q2736"]);
    if (!imageName || !isFootballer) continue;
    const label = entity.labels?.en?.value || hit.label || name;
    const description = entity.descriptions?.en?.value || "";
    const sitelink = entity.sitelinks?.enwiki?.title ? `https://en.wikipedia.org/wiki/${encodeURIComponent(entity.sitelinks.enwiki.title.replaceAll(" ", "_"))}` : `https://www.wikidata.org/wiki/${hit.id}`;
    const exact = normaliseName(label) === normaliseName(name);
    const confidence = exact && !isAmbiguousName(name) ? "high" : exact ? "medium" : "low";
    candidates.push({
      imageName,
      label,
      description,
      sourcePageUrl: sitelink,
      confidence,
      notes: `${label}${description ? `: ${description}` : ""}`
    });
  }

  if (candidates.length === 0) {
    const fallback = await safeSportsDbLookup(record);
    if (fallback) return fallback;
    return {
      status: "missing",
      confidence: "low",
      notes: "No suitable Wikimedia footballer image candidate found."
    };
  }

  const best = candidates[0];
  const imageUrl = `${COMMONS_SPECIAL_FILE}${encodeURIComponent(best.imageName)}?width=900`;
  const thumbnailUrl = `${COMMONS_SPECIAL_FILE}${encodeURIComponent(best.imageName)}?width=420`;
  return {
    imageUrl,
    thumbnailUrl,
    source: "Wikidata / Wikimedia Commons",
    sourcePageUrl: best.sourcePageUrl,
    licence: "See Wikimedia Commons file page",
    attribution: best.imageName,
    confidence: best.confidence,
    status: best.confidence === "high" ? "found" : "needs_review",
    notes: best.confidence === "high" ? best.notes : `Review match before accepting. ${best.notes}`
  };
}

async function safeSportsDbLookup(record) {
  try {
    return await lookupSportsDbImage(record);
  } catch {
    return null;
  }
}

function isRateLimit(error) {
  return /429|too many requests|rate limit/i.test(error?.message || "");
}

function friendlyLookupError(error) {
  if (isRateLimit(error)) {
    return "Wikimedia is temporarily rate-limiting lookups. No image was accepted from that response. Try again later, use the TheSportsDB fallback, or paste a manual override.";
  }
  return `Lookup did not find a safe image candidate. ${String(error?.message || "").slice(0, 140)}`;
}

async function lookupSportsDbImage(record) {
  const key = process.env.THESPORTSDB_API_KEY || "3";
  const url = new URL(`https://www.thesportsdb.com/api/v1/json/${key}/searchplayers.php`);
  url.search = new URLSearchParams({ p: record.displayName }).toString();
  const payload = await fetchJson(url);
  const players = payload.player || [];
  const candidate = players.find((player) => {
    const sport = normaliseName(player.strSport);
    const nameMatch = normaliseName(player.strPlayer) === normaliseName(record.displayName);
    return nameMatch && ["soccer", "football"].includes(sport);
  }) || players.find((player) => player.strThumb && ["soccer", "football"].includes(normaliseName(player.strSport)));

  if (!candidate?.strThumb) return null;

  const exact = normaliseName(candidate.strPlayer) === normaliseName(record.displayName);
  const confidence = exact && !isAmbiguousName(record.displayName) ? "medium" : "low";
  return {
    imageUrl: candidate.strThumb,
    thumbnailUrl: `${candidate.strThumb}/preview`,
    source: "TheSportsDB",
    sourcePageUrl: candidate.idPlayer ? `https://www.thesportsdb.com/player/${candidate.idPlayer}` : "https://www.thesportsdb.com/",
    licence: "See TheSportsDB image/artwork terms",
    attribution: "TheSportsDB contributors",
    confidence,
    status: confidence === "medium" ? "needs_review" : "needs_review",
    notes: `Fallback candidate from TheSportsDB: ${candidate.strPlayer || record.displayName}. Review before accepting.`
  };
}

function isAmbiguousName(name) {
  const parts = normaliseName(name).split(" ");
  return parts.length === 1 || parts.some((part) => REVIEW_WORDS.has(part));
}

function hasAnyClaim(entity, property, ids) {
  return (entity?.claims?.[property] || []).some((claim) => ids.includes(claim.mainsnak?.datavalue?.value?.id));
}

async function wikidataSearch(name) {
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.search = new URLSearchParams({
    action: "wbsearchentities",
    search: name,
    language: "en",
    format: "json",
    limit: "4"
  }).toString();
  const response = await fetchJson(url);
  return response.search || [];
}

async function wikidataEntity(id) {
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.search = new URLSearchParams({
    action: "wbgetentities",
    ids: id,
    props: "labels|descriptions|claims|sitelinks",
    languages: "en",
    sitefilter: "enwiki",
    format: "json"
  }).toString();
  const response = await fetchJson(url);
  return response.entities?.[id];
}

async function fetchJson(url) {
  let response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept": "application/json" }
  });
  if (response.status === 429) {
    await sleep(2500);
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/json" }
    });
  }
  if (!response.ok) throw new Error(`Image lookup failed ${response.status}: ${await response.text()}`);
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
