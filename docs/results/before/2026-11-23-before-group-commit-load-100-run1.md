# Load run: 100 clients

Date: 2026-11-23T07:52:38.139Z
Machine: 11th Gen Intel(R) Core(TM) i3-1115G4 @ 3.00GHz (4 threads), 7.8 GB RAM, win32 10.0.26300
Node v24.16.0; server: FastAPI + uvicorn with a local SQLite file (not PostgreSQL), client and server on the same machine
Command: `pnpm --filter @rce/loadtest start -- --duration 30 --spawn-server --port 8326 --out D:\Collaborative editor with CRDTs\docs\results\2026-11-23-load-100-run1.md --clients 100`

```json
{
  "passed": false,
  "clients": 100,
  "chaos": false,
  "typingSeconds": 30,
  "opsGenerated": 13704,
  "opsStoredByServer": 1894,
  "missingOps": 11810,
  "distinctTexts": 100,
  "replayMatches": false,
  "settleSeconds": 120.1,
  "throughputOpsPerSec": 63.1,
  "finalVisibleChars": 966,
  "finalNodes": 1061,
  "tombstoneOverhead": 1.1,
  "latencyMs": {
    "count": 125251,
    "p50": 12674.3,
    "p95": 26237.1,
    "p99": 26428.7,
    "max": 27283.9
  },
  "serverDbWriteMsAvg": 1976.48,
  "faults": {
    "dropped": 0,
    "delayed": 0,
    "duplicated": 0
  },
  "serverRestarted": false
}
```
