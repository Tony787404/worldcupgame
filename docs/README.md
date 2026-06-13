# World Cup Family Cards

A complete, lightweight family fantasy football trading card app for FIFA World Cup 2026 cards.

## Run locally

```sh
npm start
```

Open `http://localhost:4173`.

## Deploy on Render

This project includes Render-ready configuration:

- `package.json`
- `Procfile`
- `render.yaml`
- `.nvmrc`
- `runtime.txt`
- `.env.example`
- `requirements.txt` placeholder for clarity

See [RENDER_DEPLOYMENT.md](./RENDER_DEPLOYMENT.md) for the full deployment guide.

## Live data

Recommended provider: Gemini webpage extraction through the server-side scheduled cache. Point the app at a trusted World Cup fixture/results page, then Gemini converts the visible page text into the match JSON shape the app already uses. API-Football remains available as a fallback.

Set Gemini before starting the server:

```sh
MATCH_DATA_PROVIDER=gemini-web \
WORLD_CUP_DATA_URL=https://example.com/world-cup-fixtures \
GEMINI_API_KEY=your_key_here \
node server.mjs
```

The app serves `data/cache/matches.json` to users. The background timer and the Sync button refresh match data server-side, normalize extracted fixtures/events/lineups/player stats, and write the result back to the cache. If no Gemini or API-Football credentials are set, the app uses cached sample data so the app remains usable.

Provider options:

- `MATCH_DATA_PROVIDER=auto` (default): use Gemini when both `GEMINI_API_KEY` and `WORLD_CUP_DATA_URL` are set; otherwise use API-Football if `API_FOOTBALL_KEY` is set.
- `MATCH_DATA_PROVIDER=gemini-web`: require Gemini webpage extraction.
- `MATCH_DATA_PROVIDER=api-football`: require API-Football.

Gemini settings:

- `GEMINI_API_KEY` or `GOOGLE_API_KEY`: server-side Gemini key.
- `WORLD_CUP_DATA_URL` or `FIFA_WORLD_CUP_DATA_URL`: fixture/results page to extract.
- `GEMINI_MODEL`: model name, default `gemini-2.0-flash`.
- `WEB_EXTRACT_MAX_CHARS`: maximum cleaned webpage text sent to Gemini, default `120000`.

Cost-control defaults are intentionally conservative for free tiers: `AUTO_SYNC_MS` defaults to 4 hours, `MIN_SYNC_INTERVAL_MS` defaults to 1 hour for manual sync cooldowns, and `MATCH_SYNC_DAILY_REQUEST_LIMIT` defaults to 90 calls/day. The older `API_FOOTBALL_DAILY_REQUEST_LIMIT` env var is still honored as a fallback for that cap.

## Player images

Player images are stored in `data/player-images.json`, which acts as the local `player_images` table for this file-backed build.

The image system:

- Extracts unique player/team combinations from `data/ownership.json`
- Excludes team crests and non-player cards
- Looks up player images without scraping Google Images or random sites
- Uses Wikidata, Wikipedia, and Wikimedia Commons for licence-friendly, reviewable images
- Uses TheSportsDB as the safer bulk-enrichment source because Wikimedia rate-limits automated batches
- Stores source, source page, licence/terms note, attribution, confidence, status, notes, and manual override fields
- Never performs image lookup while rendering the app
- Never overwrites manual overrides during enrichment

Create or refresh image records without network lookup:

```sh
node scripts/enrich-player-images.mjs --init-only
```

Run a small bulk enrichment batch. This uses TheSportsDB only, avoiding Wikimedia rate limits:

```sh
node scripts/enrich-player-images.mjs --limit=20
```

Run one player again with Wikimedia first:

```sh
node scripts/enrich-player-images.mjs --id="marcus rashford__ENG" --limit=1
```

Force a source strategy:

```sh
node scripts/enrich-player-images.mjs --limit=10 --strategy=sportsdb-first
node scripts/enrich-player-images.mjs --limit=10 --strategy=sportsdb-only
node scripts/enrich-player-images.mjs --id="marcus rashford__ENG" --strategy=wikimedia-first
```

Optional TheSportsDB key:

```sh
THESPORTSDB_API_KEY=your_key node scripts/enrich-player-images.mjs --limit=20
```

The app also has an **Images** tab where you can accept, reject, mark for review, paste a manual override URL, clear a manual override, or rerun lookup for one player or a small missing/low-confidence batch.

Statuses:

- `found`: accepted image
- `needs_review`: likely or fallback candidate that should be checked
- `missing`: no suitable image found yet
- `manual`: manual override URL is active
- `rejected`: image was rejected and will not display

Confidence:

- `high`: strong structured match, usually safe to display
- `medium`: plausible but should be reviewed
- `low`: ambiguous, missing, failed, or fallback candidate

Note: Wikimedia is still the best licence-friendly source, but it is not ideal for bulk lookup from an app button. The admin bulk action therefore checks only five records at a time and uses TheSportsDB only. Use one-player reruns for Wikimedia when you want a more licence-friendly source for a specific important card.

## Initial JSON import

The app includes an importer for the Goal Kings export format.

Use:

```sh
node scripts/import-goalkings.mjs /path/to/goalkings-export.json data/ownership.json
```

or:

```sh
OWNERSHIP_FILE=/absolute/path/to/your-file.json node server.mjs
```

Expected shape:

```json
{
  "familyMembers": [{ "id": "tony", "name": "Tony", "colour": "#2563eb" }],
  "cards": [{ "id": "card-kane", "ownerId": "tony", "name": "Harry Kane", "team": "England", "category": "Player", "position": "Forward" }]
}
```

## Production recommendation

For the real tournament version, use the same domain model with:

- Next.js or this Node server
- SQLite for a single-family deployment, or Supabase Postgres for hosted persistence
- Gemini webpage extraction or API-Football World Cup fixture cache
- Scheduled sync every 4 hours by default, manual Sync with a 1-hour cooldown, and a 90-call/day cap
- Event ledger scoring so the whole tournament can be recalculated after rule changes
