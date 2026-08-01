import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { REPO_ROOT, listFiles, parseArgs, rel, report } from './lib/gate.mjs';

/**
 * Requests-per-interaction budget — SP-HR-2 / I-10.
 *
 * The harness is split in two on purpose. The **recorder** lives in the
 * Playwright run (`apps/web/e2e/support/request-budget.ts`) because counting
 * requests needs a real browser against the real production bundle. The
 * **enforcer** is this script, because a gate has to be able to fail on its own
 * in CI, and because the enforcement rule needs to be readable without reading
 * a browser test.
 *
 * The rule that makes it more than decoration: **a budgeted interaction with no
 * recording is a failure.** Otherwise the cheapest way to pass would be to break
 * the e2e run.
 *
 * Scope today is one enforced example plus the cold load. Every later slice adds
 * its interactions here; the budget file is the request-amplification ledger.
 */

/**
 * @typedef {{ id: string, description: string, maxRequests: number, note?: string }} Budget
 * @typedef {{ interaction: string, project: string, requests: { method: string, url: string }[] }} Recording
 * @typedef {{ file: string, line: number, detail: string }} Violation
 */

/**
 * @param {{ budgets: Budget[], recordings: { path: string, recording: Recording }[] }} input
 * @returns {Violation[]}
 */
export function analyze({ budgets, recordings }) {
  /** @type {Violation[]} */
  const violations = [];

  for (const budget of budgets) {
    const matching = recordings.filter((r) => r.recording.interaction === budget.id);

    if (matching.length === 0) {
      violations.push({
        file: 'scripts/gates/request-budget/budgets.json',
        line: 0,
        detail: `no recording for budgeted interaction "${budget.id}" — run the e2e gate (a missing recording is a failure, not a skip)`,
      });
      continue;
    }

    for (const { path, recording } of matching) {
      const count = recording.requests.length;
      if (count > budget.maxRequests) {
        violations.push({
          file: path,
          line: 0,
          detail: `"${budget.id}" [${recording.project}] issued ${String(count)} request(s), budget ${String(budget.maxRequests)}: ${recording.requests
            .map((r) => `${r.method} ${r.url}`)
            .join(' | ')}`,
        });
      }
    }
  }

  const budgeted = new Set(budgets.map((b) => b.id));
  for (const { path, recording } of recordings) {
    if (!budgeted.has(recording.interaction)) {
      violations.push({
        file: path,
        line: 0,
        detail: `recording for "${recording.interaction}" has no declared budget — every measured interaction must be budgeted`,
      });
    }
  }

  return violations;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir =
    typeof args['dir'] === 'string'
      ? resolve(args['dir'])
      : resolve(REPO_ROOT, 'scripts/gates/request-budget');

  const budgetsFile = resolve(dir, 'budgets.json');
  if (!existsSync(budgetsFile)) {
    process.stdout.write(`FAIL  request-budget (SP-HR-2) — no budgets.json in ${rel(dir)}\n`);
    process.exit(1);
  }

  /** @type {{ interactions: Budget[] }} */
  const parsed = JSON.parse(readFileSync(budgetsFile, 'utf8'));
  const budgets = parsed.interactions;

  const recordingsDir = resolve(dir, 'recordings');
  const recordings = listFiles(recordingsDir)
    .filter((f) => f.endsWith('.json'))
    .map((path) => ({
      path: rel(path),
      /** @type {Recording} */
      recording: JSON.parse(readFileSync(path, 'utf8')),
    }));

  process.exit(
    report(
      'request-budget (SP-HR-2 / I-10)',
      analyze({ budgets, recordings }),
      `${String(budgets.length)} budgeted interaction(s), ${String(recordings.length)} recording(s) [${recordings
        .map((r) => basename(r.path))
        .join(', ')}]`,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
