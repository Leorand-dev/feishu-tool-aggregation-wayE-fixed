// Run all 2026.10.5 suites against one bundle.
// Usage: node run-all.mjs [bundle-path]
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const suites = [
  "test-wayD-105.mjs",
  "test-wayB-105.mjs",
  "test-wayC-105.mjs",
  "exec-agg-105.mjs",
  "test-idle-release-105.mjs",
  "test-narration-ticker-105.mjs",
  "test-display-backfill-105.mjs",
  "audit-agg-105.mjs",
];
const bundle = process.argv[2] || "../patches/2026.10.5/patched.mjs";

let passed = 0;
const failed = [];
for (const suite of suites) {
  console.log(`\n========== ${suite} ==========`);
  const result = spawnSync(process.execPath, [path.join(dir, suite), bundle], {
    stdio: "inherit",
    cwd: dir
  });
  if (result.status === 0) passed += 1;
  else failed.push(suite);
}

console.log(`\n${passed}/${suites.length} suites passed, ${failed.length} failed`);
if (failed.length > 0) console.log("failed: " + failed.join(", "));
process.exit(failed.length === 0 ? 0 : 1);
