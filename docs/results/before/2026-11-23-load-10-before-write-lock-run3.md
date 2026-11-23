# Load run: 10 clients

Date: 2026-11-23T07:40:38.080Z
Machine: 11th Gen Intel(R) Core(TM) i3-1115G4 @ 3.00GHz (4 threads), 7.8 GB RAM, win32 10.0.26300
Node v24.16.0; server: FastAPI + uvicorn with a local SQLite file (not PostgreSQL), client and server on the same machine
Command: `pnpm --filter @rce/loadtest start -- --duration 30 --spawn-server --port 8302 --out D:\Collaborative editor with CRDTs\docs\results\2026-11-23-load-10-run3.md --clients 10`

```json
{
  "passed": true,
  "clients": 10,
  "chaos": false,
  "typingSeconds": 30,
  "opsGenerated": 1437,
  "opsStoredByServer": 1437,
  "missingOps": 0,
  "distinctTexts": 1,
  "replayMatches": true,
  "settleSeconds": 0.3,
  "throughputOpsPerSec": 47.9,
  "finalVisibleChars": 870,
  "finalNodes": 1151,
  "tombstoneOverhead": 1.32,
  "latencyMs": {
    "count": 12933,
    "p50": 95.7,
    "p95": 662.1,
    "p99": 1121,
    "max": 1513
  },
  "serverDbWriteMsAvg": 80.09,
  "faults": {
    "dropped": 0,
    "delayed": 0,
    "duplicated": 0
  },
  "serverRestarted": false
}
```
