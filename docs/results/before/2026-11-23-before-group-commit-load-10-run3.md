# Load run: 10 clients

Date: 2026-11-23T07:44:02.788Z
Machine: 11th Gen Intel(R) Core(TM) i3-1115G4 @ 3.00GHz (4 threads), 7.8 GB RAM, win32 10.0.26300
Node v24.16.0; server: FastAPI + uvicorn with a local SQLite file (not PostgreSQL), client and server on the same machine
Command: `pnpm --filter @rce/loadtest start -- --duration 30 --spawn-server --port 8322 --out D:\Collaborative editor with CRDTs\docs\results\2026-11-23-load-10-run3.md --clients 10`

```json
{
  "passed": true,
  "clients": 10,
  "chaos": false,
  "typingSeconds": 30,
  "opsGenerated": 1421,
  "opsStoredByServer": 1421,
  "missingOps": 0,
  "distinctTexts": 1,
  "replayMatches": true,
  "settleSeconds": 0,
  "throughputOpsPerSec": 47.4,
  "finalVisibleChars": 859,
  "finalNodes": 1139,
  "tombstoneOverhead": 1.33,
  "latencyMs": {
    "count": 12789,
    "p50": 79.9,
    "p95": 792,
    "p99": 1444.5,
    "max": 1626.9
  },
  "serverDbWriteMsAvg": 61.69,
  "faults": {
    "dropped": 0,
    "delayed": 0,
    "duplicated": 0
  },
  "serverRestarted": false
}
```
