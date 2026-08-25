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
 * flake to retry.** The failing seed is printed, and once a seed exposes a defect
 * it joins the fixed set below.
 *
 * ## What the printed seed pins, and what it does not (NR-22)
 *
 * This used to say the failing seed "is printed so it is reproducible". That is
 * false as worded, and NR-22 carries the measured basis: a seed pins the shuffle
 * only **up to collection order**. `RandomSequencer.sort` is `shuffle(files,
 * seed)` over whatever array collection hands it, with no canonical pre-sort, and
 * the glob walk that builds that array is not stably ordered — the same seed in
 * one checkout returned the same file SET in different orders on successive
 * collections: five runs of this exact command over an identical 142-file set
 * returned three distinct orders, differing in 15, 54 and 69 of 142 positions.
 * The instability is LOCALISED — a given file may not move at all, and in those
 * five collections `periodic.test.ts` held position 13 every time, which is why
 * this bites intermittently rather than always. Across whole suite runs it moves
 * much further: the two full seed-1 suite runs of R-11 and R-12 differed in 40 of
 * 142 positions, moving `periodic.test.ts` from 132nd to 87th and so leaving it
 * behind inherited backlogs of 893 and 232 jobs respectively — the same seed, a
 * different order. Test order WITHIN a file is stable, and the results cache is
 * excluded as a cause (shuffle replaces the cache-consulting sort outright).
 *
 * So a printed seed is a **lead, not a reproduction**: re-running it may not
 * re-run the order that failed.
 *
 * **Reproduce by pinning the PRECONDITION the failure observed**, not the seed
 * alone. For a queue-timing defect that precondition is the inherited backlog
 * depth — FAD-53 R-12's seed-1 R-03 failure was reproduced at a fixed depth of
 * 3011 jobs, deterministically and in about a minute, after the seed order itself
 * proved unreproducible — and in general it is whatever measured state the
 * failing assertion depended on. A reproduction that pins the state is also
 * cheaper than one that re-runs 142 files hoping for the same draw.
 *
 * ## RETIRED 2026-08-25 (M5-000a, FU-01): the seed IS a replay key again
 *
 * Everything above is kept as the record of what was true until this date, and
 * half of it still is. **Collection order is still not stable** — `vitest list
 * --project api --filesOnly` returns a different order on successive runs of one
 * unchanged checkout, with or without any shuffle flag, because the instability
 * is in the glob walk and not in the shuffle. What changed is that collection
 * order no longer REACHES the run. `apps/api/vitest.config.ts` now carries a
 * `sequence.sequencer` (installed by the root `vitest.config.ts`, on the
 * file-shuffle path only) that sorts the collected files canonically before
 * applying the seeded Fisher–Yates, so the landed order is a function of **the
 * SET of files and the seed alone**.
 *
 * `--sequence.seed=N` therefore pins the file order again, and the operator line
 * this script prints below — `Reproduce with --sequence.seed=N` — is TRUE as
 * written. It is deliberately unchanged: NR-22's rider (c) gave that follow-up
 * two exits, "fix the sequencer (at which point the line becomes true again), or
 * reword the line", and this is the first of them.
 *
 * Two bounds, so it is not over-read. The permutation is a function of the file
 * SET as well as of the seed, so adding or removing a test file re-draws every
 * seed's order — a seed replays an order only against the tree it was drawn on.
 * And pinning the observed PRECONDITION is still the stronger reproduction for a
 * state-dependent defect: a seed replays 142 files to reach the state, while
 * R-12's queue-timing failure reproduces at a fixed backlog depth of 3011 in
 * about a minute.
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

import { CAPTURE_ROOT, writeCapture } from './capture.mjs';

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

const captures = [];

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
    /* The short version, for the console. Unchanged. */
    const failures = output
      .split('\n')
      .filter((line) => / FAIL +\|api\| /.test(line) || /FAD-15 Layer 1 violated/.test(line));
    for (const line of failures.slice(0, 12)) process.stdout.write(`        ${line.trim()}\n`);

    /* NR-15: the LONG version, kept. Everything the run wrote — the assertion,
     * the diff, the stack, the surrounding stdout — because the next
     * reproduction of an unexplained failure has to be diagnosable from the
     * artifact alone. See `scripts/sbx/capture.mjs` for why it lives there. */
    const capturePath = writeCapture({ label, args, status: result.status, output });
    captures.push(capturePath);
    process.stdout.write(`        FULL OUTPUT RETAINED: ${capturePath}\n`);
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
// re-proving the ones already fixed. It is printed before the run so the log names
// the order that was ATTEMPTED — which is a lead, not a reproduction. This comment
// used to claim a failure here was "reproducible from the log alone"; per NR-22 it
// is not, because the seed pins the permutation only up to collection order and the
// glob walk feeding it is not stably ordered (see the header). Reproducing a failure
// from this log means pinning the precondition the failing assertion observed — for
// a queue-timing defect, the inherited backlog depth — rather than re-running the
// seed and expecting the same file order.
//
// The operator line printed below still says "Reproduce with --sequence.seed=N".
// That is left exactly as it is because this correction is comment-only by
// construction (the executable text of this file is unchanged, and that is proved
// rather than asserted); the same over-claim in printed output is recorded as
// residue rather than repaired here.
//
// 2026-08-25 (M5-000a, FU-01): that residue is DISCHARGED, and the line is still
// byte-identical — because the sequencer changed underneath it rather than the
// wording changing. The canonical-sort sequencer in `apps/api/vitest.config.ts`
// makes the file permutation a function of the file set and the seed alone, so
// "Reproduce with --sequence.seed=N" now says something true. The paragraph
// above is kept as the record of what it meant before that; see the header for
// the two bounds (the file SET is part of the key, and pinning the observed
// precondition remains the stronger reproduction for a state-dependent defect).
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
  process.stdout.write(
    `\nNR-15: ${String(captures.length)} full-output capture(s) retained under ${CAPTURE_ROOT}\n` +
      'Diagnose from those, not from the summary lines above — the truncation is what kept\n' +
      'NR-15 unexplained across five packets.\n',
  );
  process.exit(1);
}
process.stdout.write(
  'Order-independent under every seed tried.\n' +
    (QUICK
      ? 'STANDALONE SWEEP SKIPPED (--quick) — this run says nothing about files run alone.\n'
      : 'Every file also passes alone.\n') +
    'The shared baseline was unmodified in every run (the Layer 1 control runs in each).\n',
);
