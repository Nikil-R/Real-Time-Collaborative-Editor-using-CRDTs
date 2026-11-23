# Load run: 10 clients

Date: 2026-11-23T07:43:27.099Z
Machine: 11th Gen Intel(R) Core(TM) i3-1115G4 @ 3.00GHz (4 threads), 7.8 GB RAM, win32 10.0.26300
Node v24.16.0; server: FastAPI + uvicorn with a local SQLite file (not PostgreSQL), client and server on the same machine
Command: `pnpm --filter @rce/loadtest start -- --duration 30 --spawn-server --port 8321 --out D:\Collaborative editor with CRDTs\docs\results\2026-11-23-load-10-run2.md --clients 10`

```json
{
  "passed": true,
  "clients": 10,
  "chaos": false,
  "typingSeconds": 30,
  "opsGenerated": 1432,
  "opsStoredByServer": 1432,
  "missingOps": 0,
  "distinctTexts": 1,
  "replayMatches": true,
  "settleSeconds": 0.3,
  "throughputOpsPerSec": 47.7,
  "finalVisibleChars": 865,
  "finalNodes": 1147,
  "tombstoneOverhead": 1.33,
  "latencyMs": {
    "count": 12888,
    "p50": 53.4,
    "p95": 82,
    "p99": 153.5,
    "max": 255.8
  },
  "serverDbWriteMsAvg": 18.12,
  "faults": {
    "dropped": 0,
    "delayed": 0,
    "duplicated": 0
  },
  "serverRestarted": false
}
```
