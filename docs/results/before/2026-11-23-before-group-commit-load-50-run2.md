# Load run: 50 clients

Date: 2026-11-23T07:47:20.582Z
Machine: 11th Gen Intel(R) Core(TM) i3-1115G4 @ 3.00GHz (4 threads), 7.8 GB RAM, win32 10.0.26300
Node v24.16.0; server: FastAPI + uvicorn with a local SQLite file (not PostgreSQL), client and server on the same machine
Command: `pnpm --filter @rce/loadtest start -- --duration 30 --spawn-server --port 8324 --out D:\Collaborative editor with CRDTs\docs\results\2026-11-23-load-50-run2.md --clients 50`

```json
{
  "passed": false,
  "clients": 50,
  "chaos": false,
  "typingSeconds": 30,
  "opsGenerated": 7417,
  "opsStoredByServer": 1352,
  "missingOps": 6065,
  "distinctTexts": 50,
  "replayMatches": false,
  "settleSeconds": 120.2,
  "throughputOpsPerSec": 45.1,
  "finalVisibleChars": 820,
  "finalNodes": 926,
  "tombstoneOverhead": 1.13,
  "latencyMs": {
    "count": 50782,
    "p50": 12852.6,
    "p95": 23894.3,
    "p99": 24983.3,
    "max": 25429.8
  },
  "serverDbWriteMsAvg": 1413.14,
  "faults": {
    "dropped": 0,
    "delayed": 0,
    "duplicated": 0
  },
  "serverRestarted": false
}
```
