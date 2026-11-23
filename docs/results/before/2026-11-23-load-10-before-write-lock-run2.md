# Load run: 10 clients

Date: 2026-11-23T07:40:02.043Z
Machine: 11th Gen Intel(R) Core(TM) i3-1115G4 @ 3.00GHz (4 threads), 7.8 GB RAM, win32 10.0.26300
Node v24.16.0; server: FastAPI + uvicorn with a local SQLite file (not PostgreSQL), client and server on the same machine
Command: `pnpm --filter @rce/loadtest start -- --duration 30 --spawn-server --port 8301 --out D:\Collaborative editor with CRDTs\docs\results\2026-11-23-load-10-run2.md --clients 10`

```json
{
  "passed": true,
  "clients": 10,
  "chaos": false,
  "typingSeconds": 30,
  "opsGenerated": 1434,
  "opsStoredByServer": 1434,
  "missingOps": 0,
  "distinctTexts": 1,
  "replayMatches": true,
  "settleSeconds": 0.3,
  "throughputOpsPerSec": 47.8,
  "finalVisibleChars": 868,
  "finalNodes": 1149,
  "tombstoneOverhead": 1.32,
  "latencyMs": {
    "count": 12906,
    "p50": 109.8,
    "p95": 987.5,
    "p99": 1811.7,
    "max": 2582.8
  },
  "serverDbWriteMsAvg": 94.87,
  "faults": {
    "dropped": 0,
    "delayed": 0,
    "duplicated": 0
  },
  "serverRestarted": false
}
```
