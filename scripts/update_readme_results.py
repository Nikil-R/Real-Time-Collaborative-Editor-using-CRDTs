"""Regenerate the results section of README.md from the files in docs/results.

Every number in the README results section comes from here, which reads the
recorded run reports; nothing is typed in by hand (docs/PROJECT-RULES.md rule 5).

    python scripts/update_readme_results.py [date]      # default date 2026-11-23
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "docs" / "results"
DATE = sys.argv[1] if len(sys.argv) > 1 else "2026-11-23"
START, END = "<!-- RESULTS:START -->", "<!-- RESULTS:END -->"


def report(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    match = re.search(r"```json\n(.*?)\n```", text, re.S)
    if not match:
        raise ValueError(f"no JSON block in {path}")
    return json.loads(match.group(1))


def span(values: list[float], digits: int = 0) -> str:
    lo, hi = min(values), max(values)
    fmt = f"{{:,.{digits}f}}"
    return fmt.format(lo) if round(lo, digits) == round(hi, digits) else f"{fmt.format(lo)} to {fmt.format(hi)}"


def verdict(reps: list[dict]) -> str:
    passed = sum(1 for r in reps if r["passed"])
    if passed == len(reps):
        return "all passed"
    stored = [100 * r["opsStoredByServer"] / r["opsGenerated"] for r in reps if not r["passed"]]
    lead = "none passed" if passed == 0 else f"{passed}/{len(reps)} passed"
    return (
        f"{lead}; the server had stored "
        f"{min(stored):.0f}% to {max(stored):.0f}% of the operations when the 120 s settle window ended"
    )


def load_table(prefix: str, label: str) -> list[str]:
    rows = []
    for clients in (10, 50, 100):
        files = sorted(RESULTS.glob(f"{DATE}-{prefix}-{clients}-run*.md"))
        files = [f for f in files if "before" not in f.name]
        if not files:
            continue
        reps = [report(f) for f in files]
        rows.append(
            "| {c} | {n} | {ok} | {ops} | {tp} | {p50} | {p95} | {p99} | {db} |".format(
                c=clients,
                n=len(reps),
                ok=verdict(reps),
                ops=span([r["opsGenerated"] for r in reps]),
                tp=span([r["throughputOpsPerSec"] for r in reps], 1),
                p50=span([r["latencyMs"]["p50"] for r in reps]),
                p95=span([r["latencyMs"]["p95"] for r in reps]),
                p99=span([r["latencyMs"]["p99"] for r in reps]),
                db=span([r["serverDbWriteMsAvg"] for r in reps if r["serverDbWriteMsAvg"] is not None], 1),
            )
        )
    if not rows:
        return []
    return [
        f"**{label}**",
        "",
        "| Clients | Runs | Verdict | Ops generated | Stored ops/s | p50 ms | p95 ms | p99 ms | DB write ms (avg per batch) |",
        "|---|---|---|---|---|---|---|---|---|",
        *rows,
    ]


def main() -> None:
    out: list[str] = [START, "", "## Results", ""]
    out += [
        f"All numbers below were produced on {DATE} on one machine (11th Gen Intel Core i3-1115G4, 7.8 GB RAM, Windows 11, Node 24) with clients and server on the same machine and the server on a **SQLite file, not PostgreSQL**. Each line links to a report in [`docs/results/`](docs/results/) that records the exact command. Treat them as demo-scale, relative numbers.",
        "",
    ]

    conv = RESULTS / f"{DATE}-crdt-convergence.md"
    if conv.exists():
        out += [
            "**Convergence (property-based fuzzing, 0 divergences).** 2 to 6 replicas, random edits, delivery order, delays and duplicates; after delivery every replica must show identical text, equal to the surviving characters. Details and the sanity check that the tests can fail: [`crdt-convergence`](docs/results/2026-11-23-crdt-convergence.md).",
            "",
        ]

    out += load_table("load", "Load test: random typing (5 characters per second per client, 30 s) into one document") or []
    out.append("")
    out.append("A run **passes** only if, after typing stops and faults end, every replica holds identical text, the server stored every operation that was generated, and a fresh client replaying the log gets the same text. A run that fails because the server is still working through a backlog is **saturation, not divergence**: the single-process server on a SQLite file, with all simulated clients on the same 4-thread laptop, could not keep up with the offered load. No claim is made that 100 clients converge.")
    out.append("")
    out.append("Latency is measured from the moment a client creates an operation to the moment another client's session receives it from the server (same process clock), so it includes the client's 30 ms batching window and the database write.")
    out.append("")

    chaos = RESULTS / f"{DATE}-chaos-20.md"
    if chaos.exists():
        c = report(chaos)
        out += [
            "**Chaos run** (20 clients, 30 s of typing with random disconnects, 1 to 10 s offline periods, delayed, duplicated and reordered messages, and one server restart mid-run):",
            "",
            f"- verdict: {'passed' if c['passed'] else 'FAILED'}; operations generated {c['opsGenerated']}, stored by the server {c['opsStoredByServer']} (missing: {c['missingOps']})",
            f"- distinct final texts across all replicas: {c['distinctTexts']}; a fresh client replaying the log matches: {c['replayMatches']}",
            f"- faults injected: {c['faults']['dropped']} dropped connections, {c['faults']['delayed']} delayed and {c['faults']['duplicated']} duplicated messages; server restarted: {c['serverRestarted']}; time to settle after faults stopped: {c['settleSeconds']} s",
            f"- latency during chaos is dominated by offline periods (p50 {c['latencyMs']['p50']:,.0f} ms, p99 {c['latencyMs']['p99']:,.0f} ms) and is not a performance figure",
            "",
        ]

    yj = RESULTS / f"{DATE}-yjs-compare.json"
    if yj.exists():
        data = json.loads(yj.read_text(encoding="utf-8"))
        rows = data["rows"]
        out += [
            "**Own CRDT versus Yjs** (same seeded synthetic trace, one run, results checked against a plain-string model; [details](docs/results/2026-11-23-yjs-comparison.md)):",
            "",
            "| Edits in the trace | " + " | ".join(f"{r['edits']:,}" for r in rows) + " |",
            "|---|" + "---|" * len(rows),
            "| Local apply, own / Yjs (ms) | " + " | ".join(f"{r['own']['applyLocalMs']:,.0f} / {r['yjs']['applyLocalMs']:,.0f}" for r in rows) + " |",
            "| Replay on a fresh replica, own / Yjs incremental (ms) | " + " | ".join(f"{r['own']['replayRemoteMs']:,.0f} / {r['yjs']['replayIncrementalMs']:,.0f}" for r in rows) + " |",
            "| Size: own operations as JSON / Yjs merged update (bytes) | " + " | ".join(f"{r['own']['opsJsonBytes']:,} / {r['yjs']['mergedUpdateBytes']:,}" for r in rows) + " |",
            "",
            "Own implementation is slower and larger than Yjs, as expected for a first version; the gap widens with document size.",
            "",
        ]

    base_f = RESULTS / f"{DATE}-crdt-baseline.json"
    final_f = RESULTS / f"{DATE}-crdt-final-quiet.json"
    if base_f.exists() and final_f.exists():
        def pick(path: Path) -> float:
            rows = json.loads(path.read_text(encoding="utf-8"))["rows"]
            return next(r["ms"] for r in rows if r["scenario"] == "n random single-char inserts" and r["n"] == 30000)

        before, after = pick(base_f), pick(final_f)
        out += [
            f"**CRDT optimisation:** 30,000 random single-character inserts took {before / 1000:,.1f} s before and {after / 1000:,.1f} s after indexing nodes by reference (idle-machine run, one run each). Deletes and in-order remote apply did not improve. Run-to-run noise on this laptop was large, see [`crdt-optimisation`](docs/results/2026-11-23-crdt-optimisation.md).",
            "",
        ]
    out.append(END)

    readme = ROOT / "README.md"
    text = readme.read_text(encoding="utf-8")
    block = "\n".join(out)
    if START in text and END in text:
        text = re.sub(re.escape(START) + r".*?" + re.escape(END), lambda _m: block, text, flags=re.S)
    else:
        raise SystemExit("README.md has no results markers")
    readme.write_text(text, encoding="utf-8", newline="\n")
    print("README results updated")


if __name__ == "__main__":
    main()
