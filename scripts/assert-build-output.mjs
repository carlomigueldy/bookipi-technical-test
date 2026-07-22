#!/usr/bin/env node
/**
 * Build-output assertion guard.
 *
 * A build that exits 0 having emitted nothing is worse than a build that fails:
 * it stays green through CI and detonates at runtime as MODULE_NOT_FOUND inside
 * a Docker image. This guard makes that outcome impossible by asserting, at the
 * exact package that produced the build, that every required artifact exists and
 * is non-empty.
 *
 * Usage (from a package directory, chained with && after the compiler):
 *   node ../../scripts/assert-build-output.mjs dist/main.js
 */
import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const required = process.argv.slice(2);

if (required.length === 0) {
  console.error('assert-build-output: no required artifacts given');
  process.exit(2);
}

let pkgName = basename(process.cwd());
try {
  pkgName = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).name ?? pkgName;
} catch {
  /* fall back to directory name */
}

const failures = [];

for (const rel of required) {
  const abs = resolve(rel);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    failures.push(`${rel} — MISSING (compiler exited 0 but emitted nothing)`);
    continue;
  }
  if (!stat.isFile()) {
    failures.push(`${rel} — not a regular file`);
  } else if (stat.size === 0) {
    failures.push(`${rel} — empty (0 bytes)`);
  }
}

if (failures.length > 0) {
  console.error(`\n  BUILD OUTPUT ASSERTION FAILED in ${pkgName}\n`);
  for (const f of failures) console.error(`    ✗ ${f}`);
  console.error(
    `\n  The build reported success but did not produce its artifacts.\n` +
      `  Most common cause: a stale *.tsbuildinfo convinced tsc everything was\n` +
      `  already emitted while dist/ had been deleted. Run \`pnpm --filter ${pkgName} clean\`\n` +
      `  and rebuild. Do not ship this artifact.\n`,
  );
  process.exit(1);
}

console.log(`  ${pkgName}: build output verified (${required.join(', ')})`);
