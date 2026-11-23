# 08 - Deployment and Operations

## 1. Environments
| Environment | Purpose | How |
|---|---|---|
| Local | Daily development | Docker Compose: Postgres, Redis, server; web via `npm run dev` |
| CI | Automated tests | GitHub Actions with service containers |
| Demo | Public link for recruiters | One small AWS EC2 instance (matches existing experience), Docker Compose behind a reverse proxy |

## 2. Local setup (target)
`docker-compose.yml` services:
- `postgres:16` with a named volume.
- `redis:7`.
- `server` built from `server/Dockerfile`, port 8000.
- Optional second `server2` on port 8001 to test multi-process fan-out.

Environment variables (`.env.example`, never commit `.env`):
```
DATABASE_URL=postgresql://collab:collab@postgres:5432/collab
REDIS_URL=redis://redis:6379/0
MAX_MESSAGE_BYTES=262144
MAX_OPS_PER_BATCH=500
RATE_LIMIT_OPS_PER_SEC=200
ALLOWED_ORIGINS=http://localhost:5173
LOG_LEVEL=info
```

## 3. Demo deployment on AWS EC2
1. Small instance (for example t3.small), Amazon Linux or Ubuntu, Docker and Docker Compose installed.
2. Security group: allow 80 and 443 from anywhere, 22 only from your own IP. Postgres and Redis ports are never exposed publicly.
3. Reverse proxy (Caddy or Nginx) terminates TLS and forwards `/ws/*` with WebSocket upgrade headers and long idle timeouts.
4. Static web build served by the proxy (`npm run build`, copy `dist`).
5. Domain: a cheap domain or a free subdomain, with HTTPS.
6. Backups: nightly `pg_dump` to S3 (small cost), tested restore once.
7. Costs: record the monthly estimate in the README. Stop or terminate the instance when not demonstrating, and say so in the README so the link is not expected to always be up. A static recorded GIF stays in the README as a fallback.

## 4. Health, metrics and logs
- `/health` returns database and Redis status.
- `/metrics` (Prometheus text format): connected clients, ops per second, broadcast latency, Postgres write latency, pending ops, errors by code.
- Logs are JSON lines with `doc_id`, `replica`, `seq`, `event`.
- Optional later: Grafana dashboard (ties in with the observability learning topic).

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
