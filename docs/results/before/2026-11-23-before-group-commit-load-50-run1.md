# Load run: 50 clients

Date: 2026-11-23T07:44:38.626Z
Machine: 11th Gen Intel(R) Core(TM) i3-1115G4 @ 3.00GHz (4 threads), 7.8 GB RAM, win32 10.0.26300
Node v24.16.0; server: FastAPI + uvicorn with a local SQLite file (not PostgreSQL), client and server on the same machine
Command: `pnpm --filter @rce/loadtest start -- --duration 30 --spawn-server --port 8323 --out D:\Collaborative editor with CRDTs\docs\results\2026-11-23-load-50-run1.md --clients 50`

```json
{
  "passed": false,
  "clients": 50,
  "chaos": false,
  "typingSeconds": 30,
  "opsGenerated": 7251,
  "opsStoredByServer": 1315,
  "missingOps": 5936,
  "distinctTexts": 50,
  "replayMatches": false,
  "settleSeconds": 120.1,
  "throughputOpsPerSec": 43.8,
  "finalVisibleChars": 782,
  "finalNodes": 885,
  "tombstoneOverhead": 1.13,
  "latencyMs": {
    "count": 48740,
    "p50": 13416.9,
    "p95": 23949,
    "p99": 25064.7,
    "max": 26017.3
  },
  "serverDbWriteMsAvg": 1452.48,
  "faults": {
    "dropped": 0,
    "delayed": 0,
    "duplicated": 0
  },
  "serverRestarted": false
}
```
