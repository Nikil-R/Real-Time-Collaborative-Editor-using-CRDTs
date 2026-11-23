# Load run: 100 clients

Date: 2026-11-23T07:57:58.719Z
Machine: 11th Gen Intel(R) Core(TM) i3-1115G4 @ 3.00GHz (4 threads), 7.8 GB RAM, win32 10.0.26300
Node v24.16.0; server: FastAPI + uvicorn with a local SQLite file (not PostgreSQL), client and server on the same machine
Command: `pnpm --filter @rce/loadtest start -- --duration 30 --spawn-server --port 8328 --out D:\Collaborative editor with CRDTs\docs\results\2026-11-23-load-100-run3.md --clients 100`

```json
{
  "passed": false,
  "clients": 100,
  "chaos": false,
  "typingSeconds": 30,
  "opsGenerated": 14436,
  "opsStoredByServer": 959,
  "missingOps": 13477,
  "distinctTexts": 100,
  "replayMatches": false,
  "settleSeconds": 120,
  "throughputOpsPerSec": 32,
  "finalVisibleChars": 614,
  "finalNodes": 673,
  "tombstoneOverhead": 1.1,
  "latencyMs": {
    "count": 69288,
    "p50": 13461.6,
    "p95": 25207.2,
    "p99": 26546,
    "max": 28393.4
  },
  "serverDbWriteMsAvg": 3860.79,
  "faults": {
    "dropped": 0,
    "delayed": 0,
    "duplicated": 0
  },
  "serverRestarted": false
}
```
