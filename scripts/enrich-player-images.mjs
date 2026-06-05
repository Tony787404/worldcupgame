import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { ensureRecords, enrichStore, readStore, writeStore } from "../lib/player-images.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));

const ownershipFile = path.resolve(args.get("ownership") || path.join(root, "data", "ownership.json"));
const imageFile = path.resolve(args.get("images") || path.join(root, "data", "player-images.json"));
const limit = args.has("limit") ? Number(args.get("limit")) : Infinity;
const only = args.get("only") || "missing-low";
const recordId = args.get("id") || "";
const strategy = args.get("strategy") || (recordId ? "wikimedia-first" : "sportsdb-only");
const initialiseOnly = args.has("init-only");

const ownership = JSON.parse(await fs.readFile(ownershipFile, "utf8"));

if (initialiseOnly) {
  const store = ensureRecords(ownership, await readStore(imageFile));
  await writeStore(imageFile, store);
  console.log(`Initialised ${store.records.length} player image records in ${imageFile}`);
} else {
  const result = await enrichStore({ ownership, imageFile, limit, only, recordId, strategy });
  console.log(`Checked ${result.changed} player image records. Total records: ${result.total}`);
}
