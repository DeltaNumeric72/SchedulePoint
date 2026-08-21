import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * **NR-15's capture widening** (doc 35 §6g Included (E); the register's own
 * recorded improvement).
 *
 * NR-15 is one non-reproducing failure of
 * `apps/api/test/profiles/loader-writer-agreement.test.ts` at fixed seed
 * 20250101, first seen at OPUS-M4-000A. Its mechanism is UNKNOWN, it is
 * explicitly NOT ruled a flake, and the register names the reason it could never
 * be diagnosed:
 *
 * > **the gate truncates assertion output so the actual failure was never
 * > captured.**
 *
 * The gate filtered a failing run's output to at most twelve lines matching two
 * narrow patterns and printed nothing else — so every reproduction across five
 * packets produced a test NAME and no assertion, and the one piece of evidence
 * that would have identified the mechanism was discarded the moment it existed.
 *
 * `writeCapture` retains the run's output **verbatim and in full**. It lives in
 * its own module so that `scripts/red-cases/nr15-capture/check.mjs` can prove it
 * — a widening nobody can falsify is a claim, not a control, and the whole
 * reason NR-15 stayed open is that a truncation nobody noticed looked exactly
 * like a capture.
 *
 * Retention is unconditional on failure and deliberately NOT sampled: NR-15
 * reproduced roughly once in a hundred runs, and a sampling rule is how you miss
 * the one that matters.
 */

/** Where captures go. Scratch, so a plain run still leaves the tree clean (NR-14). */
export const CAPTURE_ROOT = resolve(process.cwd(), '.evidence-scratch/fixture-regression');

/** @param {string} label */
export function captureFileName(label) {
  return `${label.replace(/[^A-Za-z0-9._-]+/g, '-')}.txt`;
}

/**
 * Retains one failing run's COMPLETE output and returns the path it wrote.
 *
 * @param {{ label: string, args: readonly string[], status: number | null, output: string }} run
 * @param {string} [root]
 * @returns {string}
 */
export function writeCapture(run, root = CAPTURE_ROOT) {
  const path = join(root, captureFileName(run.label));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      `# fixture-regression capture — ${new Date().toISOString()}`,
      `# label:   ${run.label}`,
      `# command: node node_modules/vitest/vitest.mjs run ${run.args.join(' ')}`,
      `# exit:    ${String(run.status)}`,
      '',
      // VERBATIM. Not filtered, not truncated, not summarised. This line is the
      // whole repair.
      run.output,
    ].join('\n'),
    'utf8',
  );
  return path;
}
