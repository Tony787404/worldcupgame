import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const imageFile = path.join(root, "data", "player-images.json");
const aliasFile = path.join(root, "data", "manual", "player-image-aliases.json");

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));

const limit = args.has("limit") ? Number(args.get("limit")) : Infinity;
const onlyMissing = args.get("only") !== "all";
const aliases = JSON.parse(await fs.readFile(aliasFile, "utf8"));
const store = JSON.parse(await fs.readFile(imageFile, "utf8"));

let checked = 0;
let updated = 0;
for (const record of store.records) {
  if (checked >= limit) break;
  if (record.manualOverrideUrl || record.status === "found" || record.status === "manual") continue;
  if (onlyMissing && (record.imageUrl || record.thumbnailUrl)) continue;
  const isCuratedAlias = Boolean(aliases[record.id]);
  const alias = aliases[record.id] || record.displayName;
  checked += 1;
  const candidate = await wikipediaSummary(alias, { allowSparseSummary: isCuratedAlias });
  await sleep(250);
  if (!candidate?.thumbnailUrl) continue;
  record.imageUrl = candidate.imageUrl || candidate.thumbnailUrl;
  record.thumbnailUrl = candidate.thumbnailUrl;
  record.source = "Wikipedia / Wikimedia";
  record.sourcePageUrl = candidate.sourcePageUrl;
  record.licence = "See Wikipedia page and linked Wikimedia Commons file page";
  record.attribution = candidate.title;
  record.confidence = aliases[record.id] ? "medium" : "low";
  record.status = "needs_review";
  record.notes = `Curated Wikipedia candidate using lookup title "${alias}". Review before accepting.`;
  record.updatedAt = new Date().toISOString();
  record.lastCheckedAt = new Date().toISOString();
  updated += 1;
}

store.updatedAt = new Date().toISOString();
await fs.writeFile(imageFile, JSON.stringify(store, null, 2));
console.log(`Checked ${checked} records and added ${updated} Wikipedia/Wikimedia image candidates.`);

async function wikipediaSummary(title, options = {}) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replaceAll(" ", "_"))}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "WorldCupFamilyCards/1.0 (family fantasy football card game)"
    }
  });
  if (!response.ok) return null;
  const payload = await response.json();
  if (payload.type === "disambiguation") return null;
  if (!options.allowSparseSummary && !/football|soccer/i.test(`${payload.extract || ""} ${payload.description || ""}`)) return null;
  return {
    title: payload.title,
    sourcePageUrl: payload.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
    thumbnailUrl: payload.thumbnail?.source,
    imageUrl: payload.originalimage?.source || payload.thumbnail?.source
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
