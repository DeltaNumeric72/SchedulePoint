#!/usr/bin/env node
/**
 * REV-B assertion-mutation sampling — vacuity probe (doc 38 §3 REV-B).
 *
 * For each sampled assertion: record the file's sha256, INVERT the assertion
 * (change what it demands to the opposite / a neighbouring wrong value), run the
 * suite that contains it, and require a NON-ZERO exit. An inverted assertion
 * that still passes is a vacuous assertion. The file is then restored and its
 * sha256 re-checked byte-for-byte.
 *
 * This script writes nothing outside the transcript it prints and the files it
 * restores. It implements no repair. Run from the repository root.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * @typedef {{ id: string, file: string, line: number, from: string, to: string,
 *   command: string[], why: string }} Mutation
 */

/** @type {Mutation[]} */
const MUTATIONS = [
  {
    id: 'M-01',
    file: 'packages/domain/test/ports/result-reproducibility.test.ts',
    line: 81,
    from: 'expect(verdict.reproducible).toBe(true);',
    to: 'expect(verdict.reproducible).toBe(false);',
    command: ['run', 'packages/domain/test/ports/result-reproducibility.test.ts'],
    why: 'FAD-49/52: the positive verdict. If inverting it stays green the verdict is not measured.',
  },
  {
    id: 'M-02',
    file: 'packages/domain/test/ports/result-reproducibility.test.ts',
    line: 143,
    from: 'expect(verdict.reproducible).toBe(false);',
    to: 'expect(verdict.reproducible).toBe(true);',
    command: ['run', 'packages/domain/test/ports/result-reproducibility.test.ts'],
    why: 'FAD-49/52: the REFUSAL. The negative claim is the one a wall-clock-truncated run needs.',
  },
  {
    id: 'M-03',
    file: 'packages/domain/test/context-verification.test.ts',
    line: 100,
    from: 'expect(result.context.sessionEpoch).toBe(2);',
    to: 'expect(result.context.sessionEpoch).toBe(3);',
    command: ['run', 'packages/domain/test/context-verification.test.ts'],
    why: 'I-14/15 declared-vs-verified: the epoch actually carried through.',
  },
  {
    id: 'M-04',
    file: 'apps/web/test/build-vocabulary.test.ts',
    line: 155,
    from: 'expect(new Set(Object.values(CONFLICT_CLASS_LABELS)).size).toBe(4);',
    to: 'expect(new Set(Object.values(CONFLICT_CLASS_LABELS)).size).toBe(5);',
    command: ['run', '--project', 'web', 'test/build-vocabulary.test.ts'],
    why: 'UI/backend vocabulary agreement: distinct labels per conflict class.',
  },
  {
    id: 'M-05',
    file: 'apps/web/test/context-declaration.test.ts',
    line: 196,
    from: 'expect(calls).toHaveLength(4);',
    to: 'expect(calls).toHaveLength(5);',
    command: ['run', '--project', 'web', 'test/context-declaration.test.ts'],
    why: 'I-10: the exact request count the client issues.',
  },
  {
    id: 'M-06',
    file: 'packages/contracts/test/health.test.ts',
    line: 22,
    from: 'expect(result.success).toBe(false);',
    to: 'expect(result.success).toBe(true);',
    command: ['run', '--project', 'contracts', 'test/health.test.ts'],
    why: 'contract refusal: a malformed payload must not parse.',
  },
  {
    id: 'M-07',
    file: 'scripts/gates/test/network-assertion-guard.test.ts',
    line: 49,
    from: 'expect(scan(`fetch("http://localhost:3001/api/health")`).length).toBe(1);',
    to: 'expect(scan(`fetch("http://localhost:3001/api/health")`).length).toBe(0);',
    command: ['run', '--project', 'gates', 'test/network-assertion-guard.test.ts'],
    why: 'CAP-068/T-23: the client-host scanner detecting a request-shaped host.',
  },
  {
    id: 'M-08',
    file: 'scripts/gates/test/request-budget.test.ts',
    line: 61,
    from: 'expect(violations).toHaveLength(1);',
    to: 'expect(violations).toHaveLength(0);',
    command: ['run', '--project', 'gates', 'test/request-budget.test.ts'],
    why: 'SP-HR-2/I-10: the budget gate reporting an over-budget interaction.',
  },
  {
    id: 'M-09',
    file: 'packages/domain/test/layering.test.ts',
    line: 38,
    from: 'expect(offenders).toEqual([]);',
    to: "expect(offenders).toEqual(['REV-B forced non-empty']);",
    command: ['run', 'packages/domain/test/layering.test.ts'],
    why: 'the domain-imports-nothing boundary.',
  },
  {
    id: 'M-10',
    file: 'apps/api/test/architecture/no-tenant-access-outside-unit-of-work.test.ts',
    line: 143,
    from: "expect(singleFindings.some((f) => f.detail.includes('SQL string literal'))).toBe(true);",
    to: "expect(singleFindings.some((f) => f.detail.includes('SQL string literal'))).toBe(false);",
    command: ['run', '--project', 'api', 'test/architecture/no-tenant-access-outside-unit-of-work.test.ts'],
    why: 'NR-16 / I-15: the bare-SQL scanner (this is the scanner the NR-16 red case guards).',
  },
];

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function patch(file, line, from, to) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const index = line - 1;
  const current = lines[index];
  if (current === undefined || current.trim() !== from.trim()) {
    throw new Error(
      `ANCHOR MISS in ${file}:${line}\n  expected: ${from.trim()}\n  found:    ${String(current).trim()}`,
    );
  }
  lines[index] = current.replace(from.trim(), to.trim());
  writeFileSync(file, lines.join('\n'), 'utf8');
  return { before: current, after: lines[index] };
}

let vacuous = 0;
let proven = 0;
const rows = [];

for (const m of MUTATIONS) {
  process.stdout.write(`\n${'='.repeat(78)}\n${m.id}  ${m.file}:${m.line}\n  ${m.why}\n`);
  const before = sha256(m.file);
  let applied;
  try {
    applied = patch(m.file, m.line, m.from, m.to);
  } catch (error) {
    process.stdout.write(`  ERRORED — ${String(error.message)}\n`);
    rows.push({ id: m.id, verdict: 'ERRORED (anchor miss)', file: m.file });
    continue;
  }
  process.stdout.write(`  applied diff:\n    - ${applied.before.trim()}\n    + ${applied.after.trim()}\n`);

  const started = Date.now();
  const run = spawnSync('node', ['node_modules/vitest/vitest.mjs', ...m.command], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: process.env,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const summary = /^\s+Tests\s+(.+)$/m.exec(output)?.[1]?.trim() ?? '(no summary)';

  // Restore, then prove the restore is byte-identical.
  writeFileSync(m.file, readFileSync(m.file, 'utf8').split('\n').map((l, i) =>
    i === m.line - 1 ? applied.before : l).join('\n'), 'utf8');
  const after = sha256(m.file);
  const restored = before === after;

  const bit = run.status !== 0;
  if (bit) proven += 1;
  else vacuous += 1;
  process.stdout.write(
    `  exit=${String(run.status)}  tests: ${summary}  (${seconds}s)\n` +
      `  VERDICT: ${bit ? 'LOAD-BEARING (inversion goes RED)' : '*** VACUOUS — inversion stayed GREEN ***'}\n` +
      `  restore byte-identical: ${restored ? 'yes' : '*** NO ***'} (${before.slice(0, 12)} -> ${after.slice(0, 12)})\n`,
  );
  if (!bit) {
    process.stdout.write(`  --- output of the still-green run ---\n${output.split('\n').slice(-25).join('\n')}\n`);
  }
  rows.push({
    id: m.id,
    verdict: bit ? 'load-bearing' : 'VACUOUS',
    exit: run.status,
    summary,
    seconds,
    restored,
    file: `${m.file}:${String(m.line)}`,
  });
}

process.stdout.write(`\n${'='.repeat(78)}\nMUTATION SAMPLE SUMMARY\n`);
for (const r of rows) {
  process.stdout.write(
    `  ${r.id}  ${String(r.verdict).padEnd(14)} exit=${String(r.exit)}  restored=${String(r.restored)}  ${r.file}\n      ${String(r.summary)}\n`,
  );
}
process.stdout.write(
  `\n${String(MUTATIONS.length)} sampled: ${String(proven)} load-bearing, ${String(vacuous)} vacuous\n`,
);
process.exitCode = 0;
