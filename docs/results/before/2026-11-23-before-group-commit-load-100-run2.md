# Load run: 100 clients

Date: 2026-11-23T07:55:16.908Z
Machine: 11th Gen Intel(R) Core(TM) i3-1115G4 @ 3.00GHz (4 threads), 7.8 GB RAM, win32 10.0.26300
Node v24.16.0; server: FastAPI + uvicorn with a local SQLite file (not PostgreSQL), client and server on the same machine
Command: `pnpm --filter @rce/loadtest start -- --duration 30 --spawn-server --port 8327 --out D:\Collaborative editor with CRDTs\docs\results\2026-11-23-load-100-run2.md --clients 100`

```json
{
  "passed": false,
  "clients": 100,
  "chaos": false,
  "typingSeconds": 30,
  "opsGenerated": 14031,
  "opsStoredByServer": 771,
  "missingOps": 13260,
  "distinctTexts": 100,
  "replayMatches": false,
  "settleSeconds": 120.1,
  "throughputOpsPerSec": 25.7,
  "finalVisibleChars": 492,
  "finalNodes": 543,
  "tombstoneOverhead": 1.1,
  "latencyMs": {
    "count": 53089,
    "p50": 14587.3,
    "p95": 25765.8,
    "p99": 26932.6,
    "max": 28691.6
  },
  "serverDbWriteMsAvg": 4692.44,
  "faults": {
    "dropped": 0,
    "delayed": 0,
    "duplicated": 0
  },
  "serverRestarted": false
}
```
