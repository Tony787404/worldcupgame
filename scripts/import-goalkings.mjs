import fs from "node:fs/promises";
import path from "node:path";

const input = process.argv[2];
const output = process.argv[3] || path.join("data", "ownership.json");

if (!input) {
  console.error("Usage: node scripts/import-goalkings.mjs /path/to/goalkings-export.json [data/ownership.json]");
  process.exit(1);
}

const TEAM_NAMES = {
  ALG: "Algeria",
  ARG: "Argentina",
  AUS: "Australia",
  AUT: "Austria",
  BEL: "Belgium",
  BRA: "Brazil",
  CAN: "Canada",
  CIV: "Cote d'Ivoire",
  COL: "Colombia",
  CPV: "Cape Verde",
  CRO: "Croatia",
  CUW: "Curacao",
  DEN: "Denmark",
  ECU: "Ecuador",
  EGY: "Egypt",
  ENG: "England",
  ESP: "Spain",
  FRA: "France",
  GER: "Germany",
  GHA: "Ghana",
  HAI: "Haiti",
  IRN: "Iran",
  ITA: "Italy",
  JAM: "Jamaica",
  JOR: "Jordan",
  JPN: "Japan",
  KOR: "South Korea",
  KSA: "Saudi Arabia",
  MAR: "Morocco",
  MEX: "Mexico",
  NED: "Netherlands",
  NOR: "Norway",
  NZL: "New Zealand",
  PAN: "Panama",
  PAR: "Paraguay",
  POL: "Poland",
  POR: "Portugal",
  QAT: "Qatar",
  RSA: "South Africa",
  SCO: "Scotland",
  SEN: "Senegal",
  SUI: "Switzerland",
  SWE: "Sweden",
  TUN: "Tunisia",
  TUR: "Turkiye",
  URU: "Uruguay",
  USA: "United States",
  UZB: "Uzbekistan"
};

const OWNER_COLOURS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#f59e0b", "#0891b2"];

function titleCase(name) {
  if (!name) return "Unknown";
  return name
    .toLocaleLowerCase("en")
    .split(" ")
    .map((part) => part ? part[0].toLocaleUpperCase("en") + part.slice(1) : part)
    .join(" ");
}

function categoryToPosition(category, playerName) {
  if (/team crest/i.test(playerName)) return "Team";
  if (category === "Top Keepers") return "Goalkeeper";
  if (category === "Defensive Rocks") return "Defender";
  if (category === "Midfield Maestros") return "Midfielder";
  if (category === "Goal Machines") return "Forward";
  return "Player";
}

const raw = JSON.parse(await fs.readFile(input, "utf8"));
const familyMembers = raw.players.map((player, index) => ({
  id: player.id,
  name: player.name,
  colour: OWNER_COLOURS[index % OWNER_COLOURS.length]
}));

const cards = raw.cards.map((card) => {
  const isCrest = /team crest/i.test(card.playerName);
  const team = TEAM_NAMES[card.teamCode] || card.teamCode || "Unknown";
  return {
    id: card.id,
    ownerId: card.ownerId,
    cardNumber: card.cardNumber,
    name: isCrest ? `${team} Crest` : titleCase(card.playerName),
    team,
    teamCode: card.teamCode,
    category: isCrest ? "Team Crest" : card.category,
    sourceCategory: card.category,
    position: categoryToPosition(card.category, card.playerName)
  };
});

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify({
  familyMembers,
  cards,
  importedFrom: path.basename(input),
  importedAt: new Date().toISOString()
}, null, 2));

console.log(`Imported ${cards.length} cards for ${familyMembers.length} family members into ${output}`);
