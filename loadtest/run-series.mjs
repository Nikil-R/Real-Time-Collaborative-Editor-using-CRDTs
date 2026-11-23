// Runs the documented load scenarios (docs/07-TESTING.md section 6): 10, 50 and
// 100 clients on one document, three runs each, and one chaos run. Each run
// writes its own report into docs/results/.
//
//   node run-series.mjs [durationSeconds]     (default 30)
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const results = path.resolve(here, "../docs/results");
mkdirSync(results, { recursive: true });
const duration = process.argv[2] ?? "30";
const date = new Date().toISOString().slice(0, 10);

let port = 8300;
let failures = 0;
function run(label, extra) {
  const out = path.join(results, `${date}-${label}.md`);
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(
    "pnpm",
    ["exec", "tsx", "src/run.ts", "--duration", duration, "--spawn-server", "--port", String(port++), "--out", out, ...extra],
    { cwd: here, stdio: "inherit", shell: true },
  );
  if (r.status !== 0) failures += 1;
}

for (const clients of [10, 50, 100]) {
  for (const n of [1, 2, 3]) run(`load-${clients}-run${n}`, ["--clients", String(clients)]);
}
run("chaos-20", ["--clients", "20", "--chaos"]);
console.log(`\nfinished, ${failures} run(s) reported a failure`);
process.exit(failures ? 1 : 0);
