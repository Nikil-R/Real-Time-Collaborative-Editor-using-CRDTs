# Load run: 50 clients

Date: 2026-11-23T07:50:02.038Z
Machine: 11th Gen Intel(R) Core(TM) i3-1115G4 @ 3.00GHz (4 threads), 7.8 GB RAM, win32 10.0.26300
Node v24.16.0; server: FastAPI + uvicorn with a local SQLite file (not PostgreSQL), client and server on the same machine
Command: `pnpm --filter @rce/loadtest start -- --duration 30 --spawn-server --port 8325 --out D:\Collaborative editor with CRDTs\docs\results\2026-11-23-load-50-run3.md --clients 50`

```json
{
  "passed": false,
  "clients": 50,
  "chaos": false,
  "typingSeconds": 30,
  "opsGenerated": 7504,
  "opsStoredByServer": 3585,
  "missingOps": 3919,
  "distinctTexts": 50,
  "replayMatches": false,
  "settleSeconds": 120.1,
  "throughputOpsPerSec": 119.5,
  "finalVisibleChars": 1780,
  "finalNodes": 2170,
  "tombstoneOverhead": 1.22,
  "latencyMs": {
    "count": 131048,
    "p50": 9430.9,
    "p95": 18142.4,
    "p99": 19200.8,
    "max": 19795.6
  },
  "serverDbWriteMsAvg": 539.91,
  "faults": {
    "dropped": 0,
    "delayed": 0,
    "duplicated": 0
  },
  "serverRestarted": false
}
```
