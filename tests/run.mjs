#!/usr/bin/env node
/**
 * Iris test runner — zero deps, exits non-zero on failure.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [join(here, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
console.log(`\n${files.length - failed}/${files.length} suites passed`);
process.exit(failed ? 1 : 0);
