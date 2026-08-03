#!/usr/bin/env node
/**
 * The SBX evidence harness — command-line entry point.
 *
 * The scenarios live in `apps/api/test/sbx/` and run inside the api test project
 * deliberately: they need the real migrations, the real five roles, the real
 * MULTI fixture and the real server, and each of those already exists there
 * exactly once. A standalone harness with its own cluster would be a second copy
 * of that machinery, and a second thing to keep true.
 *
 * This entry point drives them and surfaces the scenario table it writes.
 *
 *     corepack pnpm sbx
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const result = spawnSync(
  'node',
  ['node_modules/vitest/vitest.mjs', 'run', '--project', 'api', 'apps/api/test/sbx/sbx.test.ts'],
  { encoding: 'utf8', stdio: 'inherit' },
);

if (result.status !== 0) {
  process.stdout.write('\nSBX run FAILED — see the output above.\n');
  process.exit(result.status ?? 1);
}

try {
  process.stdout.write(`\n${readFileSync('docs/evidence/EV-M2-SBX/scenario-report.txt', 'utf8')}`);
} catch {
  process.stdout.write('\nSBX run finished but wrote no scenario report — that is a defect.\n');
  process.exit(1);
}
