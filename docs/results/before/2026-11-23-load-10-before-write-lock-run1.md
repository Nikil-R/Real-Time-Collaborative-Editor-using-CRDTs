# Load run: 10 clients

Date: 2026-11-23T07:39:26.000Z
Machine: 11th Gen Intel(R) Core(TM) i3-1115G4 @ 3.00GHz (4 threads), 7.8 GB RAM, win32 10.0.26300
Node v24.16.0; server: FastAPI + uvicorn with a local SQLite file (not PostgreSQL), client and server on the same machine
Command: `pnpm --filter @rce/loadtest start -- --duration 30 --spawn-server --port 8300 --out D:\Collaborative editor with CRDTs\docs\results\2026-11-23-load-10-run1.md --clients 10`

```json
{
  "passed": true,
  "clients": 10,
  "chaos": false,
  "typingSeconds": 30,
  "opsGenerated": 1435,
  "opsStoredByServer": 1435,
  "missingOps": 0,
  "distinctTexts": 1,
  "replayMatches": true,
  "settleSeconds": 0.3,
  "throughputOpsPerSec": 47.8,
  "finalVisibleChars": 864,
  "finalNodes": 1149,
  "tombstoneOverhead": 1.33,
  "latencyMs": {
    "count": 12915,
    "p50": 87.6,
    "p95": 503.2,
    "p99": 956.4,
    "max": 1468.2
  },
  "serverDbWriteMsAvg": 71.84,
  "faults": {
    "dropped": 0,
    "delayed": 0,
    "duplicated": 0
  },
  "serverRestarted": false
}
```
