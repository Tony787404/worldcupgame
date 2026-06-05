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

Recommended provider: API-Football through the server-side scheduled cache.

Set the API key before starting the server:

```sh
API_FOOTBALL_KEY=your_key_here node server.mjs
```

The app serves `data/cache/matches.json` to users. The background timer and the Sync button refresh API-Football data server-side, normalize the fixtures/events/lineups/player-stat payload, and write the result back to the cache. If no key is set, the app uses the cached sample data so the app remains usable.

Cost-control defaults are intentionally conservative for the free tier: `AUTO_SYNC_MS` defaults to 4 hours, `MIN_SYNC_INTERVAL_MS` defaults to 1 hour for manual sync cooldowns, and `API_FOOTBALL_DAILY_REQUEST_LIMIT` defaults to 90 so the app stays below 100 API requests/day.

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
- API-Football World Cup fixture cache
- Scheduled sync every 4 hours by default, manual Sync with a 1-hour cooldown, and a 90-request/day cap
- Event ledger scoring so the whole tournament can be recalculated after rule changes
