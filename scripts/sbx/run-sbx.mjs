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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EVIDENCE_REFRESH_ENV,
  evidenceDestinationBanner,
  isEvidenceRefresh,
  resolveEvidencePath,
} from '../evidence-target.mjs';

/**
 * NR-14 (OPUS-M3-008): a plain `pnpm sbx` writes its scenario report and every
 * retained artifact under `.evidence-scratch/`, leaving the tree clean.
 * `pnpm sbx --refresh` writes the tracked bundle, which is what a task does once
 * from a coherent run.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REFRESH = isEvidenceRefresh();
process.stdout.write(`${evidenceDestinationBanner(REFRESH)}\n`);

const result = spawnSync(
  'node',
  ['node_modules/vitest/vitest.mjs', 'run', '--project', 'api', 'apps/api/test/sbx/sbx.test.ts'],
  {
    encoding: 'utf8',
    stdio: 'inherit',
    // The flag reaches the vitest workers as an environment variable; they never
    // see this process's argv.
    env: { ...process.env, ...(REFRESH ? { [EVIDENCE_REFRESH_ENV]: '1' } : {}) },
  },
);

if (result.status !== 0) {
  process.stdout.write('\nSBX run FAILED — see the output above.\n');
  process.exit(result.status ?? 1);
}

const REPORT = resolveEvidencePath(REPO_ROOT, 'docs/evidence/EV-M2-SBX/scenario-report.txt', REFRESH);

try {
  process.stdout.write(`\n${readFileSync(REPORT, 'utf8')}\n${REPORT}\n`);
} catch {
  process.stdout.write('\nSBX run finished but wrote no scenario report — that is a defect.\n');
  process.exit(1);
}
