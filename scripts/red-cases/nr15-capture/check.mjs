#!/usr/bin/env node
/**
 * **NR-15's control** (OPUS-M4-005).
 *
 * The register's diagnosis of why NR-15 stayed open for five packets is one
 * sentence: "the gate truncates assertion output so the actual failure was never
 * captured." The repair widens the capture — and a widening nobody can falsify
 * is a claim rather than a control, because a truncation nobody notices looks
 * exactly like a capture.
 *
 * So this hands `writeCapture` a synthetic failing run whose output contains a
 * line the OLD filter would have dropped — an assertion body, which is precisely
 * the thing that was missing — and requires it back, byte for byte.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeCapture } from '../../sbx/capture.mjs';

/* Shaped like the output that mattered: the FAIL line the old filter kept, and
 * the assertion under it that it threw away. */
const ASSERTION = 'AssertionError: expected 3 to be 2 // Object.is equality';
const OUTPUT = [
  ' FAIL  |api| test/profiles/loader-writer-agreement.test.ts > an actual supersession …',
  ASSERTION,
  '  ❯ test/profiles/loader-writer-agreement.test.ts:214:5',
  '    212|     const rows = await closedRows(uow);',
  '    213|',
  '    214|     expect(rows.length).toBe(2);',
].join('\n');

const root = mkdtempSync(join(tmpdir(), 'sp-nr15-'));
const problems = [];
try {
  const path = writeCapture(
    { label: 'seed 20250101', args: ['--project', 'api', '--sequence.seed=20250101'], status: 1, output: OUTPUT },
    root,
  );
  const written = readFileSync(path, 'utf8');

  if (!written.includes(ASSERTION)) {
    problems.push('the ASSERTION was not retained — this is exactly the truncation NR-15 names');
  }
  for (const line of OUTPUT.split('\n')) {
    if (!written.includes(line)) problems.push(`a line of the run output was dropped: ${line}`);
  }
  if (!written.includes('# exit:    1')) {
    problems.push('the exit code was not retained — a capture without one is not reproducible');
  }
  if (!written.includes('--sequence.seed=20250101')) {
    problems.push('the command was not retained — a capture nobody can re-run is a transcript of nothing');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (problems.length > 0) {
  process.stdout.write(`FAIL  NR-15 capture widening — ${String(problems.length)} problem(s)\n`);
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  process.exit(1);
}
process.stdout.write('PASS  NR-15 capture widening — the full run output, the command and the exit code are retained\n');
