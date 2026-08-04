#!/usr/bin/env node
/**
 * The FAD-15 fixture-isolation regression gate.
 *
 * NR-13 measured that a SINGLE shuffled run is a weak detector: of ten seeds run
 * against the pre-refactor suite, four found nothing and the rest found between
 * one and five of the six coupled tests. So this gate runs a FIXED SET of seeds —
 * every seed known to have exposed a defect — plus one ROTATING seed, and then
 * every test file alone.
 *
 * FAD-15 ruling 3, binding: **a rotating-seed failure is a defect to fix, never a
 * flake to retry.** The failing seed is printed so it is reproducible, and once a
 * seed exposes a defect it joins the fixed set below.
 *
 * Not wired into `pnpm check`: that would mean editing the gate runner, which is
 * an escalation under this task's packet. Run it explicitly:
 *
 *     corepack pnpm fixture-regression
 *     corepack pnpm fixture-regression --quick     (seed set only, no standalone sweep)
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every seed that has ever exposed an order dependence in this suite.
 *
 * Sources: docs/evidence/EV-M2-NR13/coupled-test-population.txt (7, 20260803,
 * 31337, 123456, 20250101, 8675309); the four that were green there and are kept
 * as controls (1, 42, 424242, 99991); 65339, drawn by the ROTATING seed at
 * OPUS-M2-001's acceptance and the first to expose coupling number SEVEN — the
 * EXPIRED grant test in http-authorization.test.ts, an M1-authored file outside
 * the six converted at Layer 4. Phase A said six was a lower bound; this is what
 * that meant, and it is why the rotating seed exists.
 *
 * **531651** (added by OPUS-M2-004, FAD-15 ruling 3). Drawn by the rotating seed
 * during OPUS-M2-003 and the first to reach `chain.test.ts`'s R-04 with a chain
 * ten events or longer — which is where a **`select sequence::text as sequence …
 * order by sequence`** starts sorting the bigint as text and putting `'10'` above
 * `'9'`. Three test sites and one PRODUCTION site
 * (`apps/api/src/audit/verification.ts`, the problems array an operator reads
 * first) carried that trap; the class is fixed and pinned by
 * `apps/api/test/audit/problem-ordering.test.ts`. Two of the three test sites had
 * never failed — they had been silently aiming at whichever row sorted second
 * lexicographically — which is why the seed is worth keeping rather than
 * retiring with the defect it found.
 */
const FIXED_SEEDS = [
  1, 7, 42, 424242, 20260803, 31337, 99991, 123456, 20250101, 8675309, 65339, 531651,
  // 740673 — the rotating seed that exposed OPUS-M3-001's authn-test couplings:
  // four tests depended on a sibling having activated an account, written a
  // capability grant, or not having reset somebody else's MFA first. FAD-15
  // ruling 3: the exposing seed joins the fixed set rather than being retried.
  740673,
];

const QUICK = process.argv.includes('--quick');
const results = [];

function run(label, args) {
  const started = Date.now();
  const result = spawnSync('node', ['node_modules/vitest/vitest.mjs', 'run', ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const tests = /^\s+Tests\s+(.+)$/m.exec(output)?.[1]?.trim() ?? '(no summary)';
  const ok = result.status === 0;
  results.push({ label, ok, elapsed, tests });
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${elapsed.padStart(6)}s  ${tests}\n`,
  );
  if (!ok) {
    const failures = output
      .split('\n')
      .filter((line) => / FAIL +\|api\| /.test(line) || /FAD-15 Layer 1 violated/.test(line));
    for (const line of failures.slice(0, 12)) process.stdout.write(`        ${line.trim()}\n`);
  }
  return ok;
}

function testFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...testFiles(path));
    else if (entry.endsWith('.test.ts')) found.push(path);
  }
  return found.sort();
}

process.stdout.write('FAD-15 fixture-isolation regression gate\n');
process.stdout.write(`${'='.repeat(78)}\n\n`);

process.stdout.write('1. FIXED SEED SET — file order AND test order shuffled\n');
for (const seed of FIXED_SEEDS) {
  run(`seed ${String(seed)}`, [
    '--project',
    'api',
    '--sequence.shuffle.files',
    '--sequence.shuffle.tests',
    `--sequence.seed=${String(seed)}`,
  ]);
}

// The rotating seed is what keeps the gate finding NEW couplings rather than only
// re-proving the ones already fixed. It is printed before the run so a failure is
// reproducible from the log alone.
const rotating = Math.floor(Math.random() * 1_000_000);
process.stdout.write(`\n2. ROTATING SEED — this run drew ${String(rotating)}\n`);
process.stdout.write(
  '   FAD-15 ruling 3: a failure here is a DEFECT TO FIX, never a flake to retry.\n' +
    '   Reproduce with --sequence.seed=' +
    String(rotating) +
    ', fix it, then add the seed to FIXED_SEEDS.\n',
);
run(`rotating seed ${String(rotating)}`, [
  '--project',
  'api',
  '--sequence.shuffle.files',
  '--sequence.shuffle.tests',
  `--sequence.seed=${String(rotating)}`,
]);

if (!QUICK) {
  process.stdout.write('\n3. STANDALONE SWEEP — every file alone\n');
  for (const file of testFiles('apps/api/test')) {
    run(relative('apps/api/test', file), ['--project', 'api', file]);
  }
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${'='.repeat(78)}\n`);
process.stdout.write(
  `${String(results.length)} run(s): ${String(results.length - failed.length)} passed, ` +
    `${String(failed.length)} failed\n`,
);
if (failed.length > 0) {
  for (const result of failed) process.stdout.write(`  FAILED: ${result.label}\n`);
  process.exit(1);
}
process.stdout.write(
  'Order-independent under every seed tried.\n' +
    (QUICK
      ? 'STANDALONE SWEEP SKIPPED (--quick) — this run says nothing about files run alone.\n'
      : 'Every file also passes alone.\n') +
    'The shared baseline was unmodified in every run (the Layer 1 control runs in each).\n',
);
