# Deploying World Cup Family Cards on Render

This app deploys to Render as a Node.js web service.

## Files Render uses

- `package.json`: Node metadata and start/check scripts
- `Procfile`: fallback web process command
- `render.yaml`: Blueprint config for service, environment variables, health check, and persistent disk
- `.nvmrc` / `runtime.txt`: Node 20 runtime hints
- `.env.example`: local environment variable reference

## Recommended Render setup

Use the included `render.yaml` as a Blueprint.

Important settings:

- Runtime: Node
- Build command: `npm install --omit=dev`
- Start command: `node server.mjs`
- Health check path: `/healthz`
- Persistent disk mount: `/var/data`
- `DATA_DIR=/var/data`

The app is file-backed. The persistent disk is important because image review decisions, manual overrides, cached match data, and imported ownership data are stored as JSON files.

On first boot, the server copies seed files from the bundled `data/` folder into `DATA_DIR` if they are missing.

## Environment variables

Required for production binding:

```text
HOST=0.0.0.0
DATA_DIR=/var/data
NODE_ENV=production
```

Recommended:

```text
LIVE_REFRESH_MS=60000
SPORTMONKS_WORLD_CUP_LEAGUE_ID=732
```

Secrets to set in Render:

```text
SPORTMONKS_API_TOKEN=...
THESPORTSDB_API_KEY=...
```

`SPORTMONKS_API_TOKEN` enables live World Cup data syncing. Without it, the app uses cached/sample match data.

`THESPORTSDB_API_KEY` is optional. If omitted, the image enrichment script uses TheSportsDB's public test key where available.

## Manual deployment steps

1. Push this project folder to a Git repository.
2. In Render, create a new **Web Service** or use **Blueprints** with `render.yaml`.
3. Set the root directory to this app folder if it lives inside a larger repository.
4. Confirm the build command is `npm install --omit=dev`.
5. Confirm the start command is `node server.mjs`.
6. Add a persistent disk mounted at `/var/data`.
7. Add environment variables and secrets.
8. Deploy.

## Local smoke test

```sh
npm run check
npm start
```

Open:

```text
http://127.0.0.1:4173
```

Health check:

```sh
curl http://127.0.0.1:4173/healthz
```

## Notes

Render's filesystem outside a persistent disk can be ephemeral. Keep `DATA_DIR=/var/data` on Render so the app does not lose local JSON state between deploys.

For a larger multi-family production version, move the file-backed data model to SQLite on the persistent disk or Supabase Postgres.
