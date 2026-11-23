# 08 - Deployment and Operations

## 1. Environments
| Environment | Purpose | How |
|---|---|---|
| Local, no Docker | Daily development | `cd server && uv run uvicorn app.main:app --reload` (SQLite file) and `pnpm dev:web` |
| Local, Docker | Full stack incl. Postgres, Redis, Prometheus, Grafana | `docker compose up --build` |
| CI | Automated tests | GitHub Actions with service containers |
| Demo | Public link for recruiters | Any single Linux host that runs Docker (a small VM at any provider): Docker Compose with the Caddy profile for HTTPS |

## 2. Local setup (target)
`docker-compose.yml` services:
- `postgres:16` with a named volume.
- `redis:7`.
- `server` built from `server/Dockerfile`, port 8000.
- Optional second `server2` on port 8001 to test multi-process fan-out.

Environment variables (`.env.example`, never commit `.env`):
```
DATABASE_URL=postgresql://collab:collab@postgres:5432/collab   # omit for a local SQLite dev database
REDIS_URL=redis://redis:6379/0
MAX_MESSAGE_BYTES=262144
MAX_OPS_PER_BATCH=500
RATE_LIMIT_OPS_PER_SEC=200
ALLOWED_ORIGINS=http://localhost:3000
LOG_LEVEL=info
```

## 3. Demo deployment on a single Docker host
Nothing here is specific to a cloud provider; the project is not tied to AWS.
1. A small Linux VM (1 vCPU and 2 GB RAM is enough for a demo) with Docker and the Compose plugin.
2. Firewall: allow 80 and 443 from anywhere and 22 only from your own address. Postgres and Redis ports are never published. `docker-compose.yml` publishes `server`, `web`, Prometheus and Grafana for local use; on a public host remove those `ports:` entries or bind them to `127.0.0.1`.
3. Copy the repository, create a `.env` with real values (`POSTGRES_PASSWORD`, `GRAFANA_PASSWORD`, `DOMAIN`, `ALLOWED_ORIGINS=https://<domain>`, `PUBLIC_API_URL=https://<domain>`), then `docker compose --profile demo up -d --build`.
4. Caddy (see `ops/Caddyfile`) gets a TLS certificate automatically, serves the web app, and forwards `/api/*`, `/ws/*` and `/health` to the server with WebSocket upgrade. `/metrics` is not exposed publicly.
5. Domain: a cheap domain or a free subdomain pointing at the host.
6. Backups: nightly `pg_dump` from the `postgres` container to storage off the host; restore it once to prove it works.
7. Costs: record the real monthly cost in the README once chosen. Stop the host when not demonstrating and say so in the README so the link is not expected to always be up; the recorded demo GIF is the fallback.

**Status:** the Compose stack, Dockerfiles and Caddyfile were written but have **not** been run on the development machine (Docker was not installed there). Run `docker compose build` and a smoke test before relying on them; the CI workflow builds the images on every push.

## 3b. Compaction
`uv run python -m app.compact --keep-ops 10000 --keep-days 7` (inside the container: `docker compose exec server python -m app.compact`) deletes operations covered by a stored snapshot and outside the safety window. Run it from a daily cron or systemd timer.

## 4. Health, metrics and logs
- `/health` returns database and Redis status.
- `/metrics` (Prometheus text format): connected clients, ops per second, broadcast latency, Postgres write latency, pending ops, errors by code.
- Logs are JSON lines with `doc_id`, `replica`, `seq`, `event`.
- Prometheus scrapes `/metrics`, and a provisioned Grafana dashboard (`ops/grafana/dashboards/collab.json`) shows clients, ops per second, database write latency, broadcast time, errors by code and dropped slow clients.

## 5. Operational limits
- Maximum clients per document: start at 200 and test.
- Maximum document size: start at 1,000,000 nodes and measure.
- Idle connections closed after 5 minutes without ping.
- Per-connection rate limit with a clear `RATE_LIMITED` error.

## 6. Security checklist
- [ ] HTTPS and WSS only on the public demo.
- [ ] Strict allowed origins for WebSocket upgrade.
- [ ] Document IDs are random UUIDs (not guessable).
- [ ] Message size and rate limits enforced on the server.
- [ ] Display names escaped before rendering.
- [ ] No secrets in the repository; `.env` ignored by git.
- [ ] Dependencies pinned and scanned (`npm audit`, `pip-audit`).
- [ ] Postgres user has only the privileges it needs.

## 7. Release checklist
1. All tests green, including the full property run.
2. Load test results saved and README table updated from the results files.
3. Docs match the code (protocol, schema, design).
4. Demo GIF re-recorded if the UI changed.
5. Tag a release and write a changelog entry.
6. Deploy, smoke-test with two real devices, including one on mobile data.

## 8. Rollback
- Keep the previous Docker image tag.
- Database migrations are additive; destructive changes ship in a separate release after the code stops using the old column.
- Because the operation log is append-only, a bad server release cannot corrupt history; worst case, roll back the image.
