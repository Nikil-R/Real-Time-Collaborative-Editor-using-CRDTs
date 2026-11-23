# Chaos run: 20 clients

Date: 2026-11-23T08:00:39.713Z
Machine: 11th Gen Intel(R) Core(TM) i3-1115G4 @ 3.00GHz (4 threads), 7.8 GB RAM, win32 10.0.26300
Node v24.16.0; server: FastAPI + uvicorn with a local SQLite file (not PostgreSQL), client and server on the same machine
Command: `pnpm --filter @rce/loadtest start -- --duration 30 --spawn-server --port 8329 --out D:\Collaborative editor with CRDTs\docs\results\2026-11-23-chaos-20.md --clients 20 --chaos`

```json
{
  "passed": false,
  "clients": 20,
  "chaos": true,
  "typingSeconds": 30,
  "opsGenerated": 2094,
  "opsStoredByServer": 1968,
  "missingOps": 126,
  "distinctTexts": 9,
  "replayMatches": false,
  "settleSeconds": 120.2,
  "throughputOpsPerSec": 65.6,
  "finalVisibleChars": 95,
  "finalNodes": 111,
  "tombstoneOverhead": 1.17,
  "latencyMs": {
    "count": 40833,
    "p50": 6196,
    "p95": 18811.2,
    "p99": 21608.2,
    "max": 24191.4
  },
  "serverDbWriteMsAvg": 240.51,
  "faults": {
    "dropped": 20,
    "delayed": 869,
    "duplicated": 472
  },
  "serverRestarted": true
}
```
