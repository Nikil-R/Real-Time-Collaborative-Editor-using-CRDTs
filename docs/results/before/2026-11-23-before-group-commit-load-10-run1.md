# Load run: 10 clients

Date: 2026-11-23T07:42:51.907Z
Machine: 11th Gen Intel(R) Core(TM) i3-1115G4 @ 3.00GHz (4 threads), 7.8 GB RAM, win32 10.0.26300
Node v24.16.0; server: FastAPI + uvicorn with a local SQLite file (not PostgreSQL), client and server on the same machine
Command: `pnpm --filter @rce/loadtest start -- --duration 30 --spawn-server --port 8320 --out D:\Collaborative editor with CRDTs\docs\results\2026-11-23-load-10-run1.md --clients 10`

```json
{
  "passed": true,
  "clients": 10,
  "chaos": false,
  "typingSeconds": 30,
  "opsGenerated": 1433,
  "opsStoredByServer": 1433,
  "missingOps": 0,
  "distinctTexts": 1,
  "replayMatches": true,
  "settleSeconds": 0,
  "throughputOpsPerSec": 47.8,
  "finalVisibleChars": 865,
  "finalNodes": 1148,
  "tombstoneOverhead": 1.33,
  "latencyMs": {
    "count": 12897,
    "p50": 53.6,
    "p95": 86.9,
    "p99": 128.7,
    "max": 191.2
  },
  "serverDbWriteMsAvg": 18.86,
  "faults": {
    "dropped": 0,
    "delayed": 0,
    "duplicated": 0
  },
  "serverRestarted": false
}
```
