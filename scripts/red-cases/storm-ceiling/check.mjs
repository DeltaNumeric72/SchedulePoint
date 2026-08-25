#!/usr/bin/env node
/**
 * **The R-13 storm ceiling's enforcement branch, driven until it fires**
 * (FU-03; the R-13 review's C7).
 *
 * ## Why this arm exists
 *
 * R-13 replaced T-15's fixed 120 000 ms `testTimeout` with a deadline the storm
 * MEASURES for itself — `min(840_000, max(120_000, passMs × 1800 × 4))` — and
 * enforces at every iteration boundary with a named error. On a healthy tree
 * that branch never fires: every completed run of the doc 38 §7 battery finished
 * at 0.17–0.35 of its budget. So the branch that carries the whole repair is,
 * on the evidence a normal battery produces, UNEXECUTED — which is exactly the
 * shape of a control that can be deleted, inverted or misspelled without a
 * single red signal. The R-13 review fired it once by hand and recorded that as
 * a follow-up rather than a proof; this makes it a standing arm.
 *
 * ## How the violation is introduced, and why it is not a patch
 *
 * Every other arm in this battery plants its violation in a file. This one does
 * not need to: the storm already carries the knob its own author wrote for the
 * purpose — `SP_STORM_ITERATIONS`, read by
 * `apps/api/test/tenancy/unit-of-work.test.ts` and defaulting to 900. Twelve
 * thousand iterations is 13.3× the workload the ceiling's `STORM_PROBE_PASSES`
 * constant scales from, against a ×4 safety factor, so a storm asked for 12 000
 * crosses its own measured deadline at roughly a quarter of the way through.
 *
 * **Nothing shipped is weakened to make that happen.** The iteration count is
 * the test's own environment knob and the ONLY thing this arm sets;
 * `stormCeilingMs`, `STORM_PROBE_PASSES`, `STORM_CEILING_FLOOR_MS`,
 * `STORM_CEILING_SAFETY`, the vitest hang backstop and all five of the storm's
 * assertions are untouched. The arm proves the enforcement fires; it does not
 * make it easier to fire.
 *
 * ## The string is the assertion (why this script exists at all)
 *
 * A red leg that merely exits non-zero would be satisfied by vitest's generic
 * `Test timed out in 900000ms` — the pre-R-13 failure mode, the one that "never
 * said what it measured, what it was judged against or how far it got". That
 * would report PROVEN for a run in which the enforcement branch never executed.
 * So this script asserts the NAMED error, parses its figures, and checks them:
 *
 *   · the run exited non-zero;
 *   · the calibration line printed — the ceiling was MEASURED in that process,
 *     not defaulted;
 *   · the named `R-13 storm ceiling exceeded` error is present;
 *   · elapsed > ceiling in the message's own numbers;
 *   · the storm was stopped EARLY: 0 < completed < requested, and requested is
 *     the 12 000 this arm asked for. A message reporting 12000 of 12000 would
 *     mean the storm finished and something else threw.
 *
 * ## Exit codes, and the one that looks backwards
 *
 * The red-case runner reads a NON-ZERO exit as "the gate failed, as required".
 * So:
 *
 *   exit 1 — every assertion above held: the ceiling fired for the right reason.
 *   exit 0 — it did not. The runner then scores the arm NOT PROVEN and the
 *            battery fails, which is the correct verdict for every way this can
 *            go wrong: the run passed (the enforcement is gone), or it failed
 *            for a reason that is not this branch. An arm that reported PROVEN
 *            on a generic timeout would be the decorative red case the runner
 *            exists to detect.
 *
 * ## The bound, and where 12 000 comes from — DERIVED, not chosen
 *
 * The storm costs ≈ 2 probe passes per iteration, so N iterations cost ≈ 2N ×
 * the pass cost the run ACTUALLY sustains, against a ceiling of
 * `max(120 000, 7 200 × the pass cost this run CALIBRATED)` — 7 200 being
 * `STORM_PROBE_PASSES` × `STORM_CEILING_SAFETY`. Crossing therefore needs BOTH
 *
 *     sustained / calibrated  >  3 600 / N        (the scaled branch)
 *     sustained               >  60 000 / N ms    (the 120 000 ms floor branch)
 *
 * Those two conditions are **sufficient, not necessary**, and the reason is the
 * term this restatement leaves out: the real ceiling is
 * `min(840 000, max(120 000, …))`, and the `min` can only LOWER the deadline the
 * storm has to beat. Any run that satisfies the conditions above crosses; a run
 * whose scaled term is above 840 000 ms crosses more easily than they predict.
 *
 * **The two costs are not the same number**, and that is the whole reason this
 * paragraph exists: NR-23's rider measured the single-pass calibration erring
 * between −33% and +39% of what the storm goes on to sustain.
 *
 * At N = 6 000 — the count R-13's review fired by hand — the threshold is a
 * ratio of 0.60. **That threshold has already been breached in practice, twice.**
 * The four sustained/calibrated ratios measured on this arm are **0.50, 0.58,
 * 0.66 and 0.84**: two of the four sit BELOW 0.60, so those two runs would have
 * crossed nothing at N = 6 000 and reported NOT PROVEN — a standing CI gate
 * failing for a reason that is not a defect. The raise was necessary, not merely
 * prudent, and it is recorded that way because the review derived the
 * consequence from the implementer's own retained 0.58, before the condition
 * round's 0.50 measured a second instance.
 *
 * Provenance, since a figure without one is the class this repository keeps
 * correcting: **0.50** is the condition round's re-proof and **0.58** the
 * 12 000-iteration proving run (both transcripts retained); **0.84** is the
 * review's independent re-proof; **0.66 was measured in a 6 000-iteration
 * proving run whose transcript was NOT retained** — the next run of the same arm
 * overwrote it — so it is a remembered figure rather than an evidenced one. It
 * is not load-bearing either way: the case for N = 12 000 rests on the two
 * retained ratios below 0.60.
 *
 * At N = 12 000 the threshold halves to 0.30 — a **1.66× to 2.8× margin over the
 * four observed ratios**, the 1.66× being the 0.4971 of the condition round
 * (218 415 ms over 2 × 7 244 passes = 15.08 ms sustained, against 30.33 ms
 * calibrated) — and the floor branch relaxes from 10 ms to 5 ms per pass. **The wall-clock cost of the change is nil:** the
 * enforcement stops the storm AT the ceiling, so the leg costs the ceiling
 * either way, and the only run that would use the extra iterations is one in
 * which the enforcement is already broken — which is a run this arm needs to
 * report as NOT PROVEN rather than to finish quickly.
 *
 * Below either bound this arm reports NOT PROVEN rather than passing quietly,
 * and the diagnostic below says so in those words and names the fix. Deriving
 * the count from the run's own calibration instead of pinning it at all is the
 * better shape still, and it is recorded as a follow-up rather than smuggled in
 * here.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The knob the test itself reads. 900 is its default; this is the violation.
 *  12 000 rather than 6 000: see the docblock's threshold arithmetic. */
const ITERATIONS = '12000';

/** The storm file, run through the zero-execution guard like every unit gate. */
const TARGET = 'apps/api/test/tenancy/unit-of-work.test.ts';

const result = spawnSync(process.execPath, ['scripts/gates/vitest-must-run.mjs', TARGET], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  stdio: 'pipe',
  /* 64 MiB rather than Node's 1 MiB default. A failing storm run prints the
   * whole suite's output plus a long assertion dump, and at the default this
   * script's own capture is where it would be truncated — the NR-15 class, in
   * the one place that must not have it. */
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, FORCE_COLOR: '0', SP_STORM_ITERATIONS: ITERATIONS },
});

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
process.stdout.write(output);

if (result.error !== undefined && result.error !== null) {
  const failure = /** @type {NodeJS.ErrnoException} */ (result.error);
  /* Two different facts, and the first spelling reported both as the second.
   * ENOBUFS means the child RAN and its output outgrew `maxBuffer` — saying
   * "nothing ran" there would be false, and it would send a reader looking for
   * a missing binary. Either way the arm exits 0 and scores NOT PROVEN: an
   * output this script could not read whole is not a red leg it can judge. */
  process.stdout.write(
    failure.code === 'ENOBUFS'
      ? '\nSTORM-CEILING ARM: the run EXECUTED but its output exceeded this capture ' +
          `(${String(64 * 1024 * 1024)} bytes). Nothing is judged from a truncated capture.\n`
      : '\nSTORM-CEILING ARM: the vitest process could not be spawned ' +
          `(${failure.code ?? 'unknown'}). Nothing ran.\n`,
  );
  process.exit(0);
}

/* One line, so the message's own newlines and any reporter indentation cannot
 * hide it from the pattern below. */
const flat = output.replace(/\s+/g, ' ');

const NAMED = 'R-13 storm ceiling exceeded';
const CALIBRATION = 'R-13 precondition: one';
const figures =
  /R-13 storm ceiling exceeded: (\d+) ms after (\d+) of (\d+) iterations, against a ceiling of (\d+) ms/.exec(
    flat,
  );

/** @type {string[]} */
const problems = [];

if (result.status === 0) {
  problems.push(
    `the run PASSED with SP_STORM_ITERATIONS=${ITERATIONS}: the storm never crossed its ceiling, ` +
      'so the enforcement branch did not execute',
  );
}
if (!flat.includes(CALIBRATION)) {
  problems.push(
    'the storm never printed its calibration line, so no ceiling was measured in that process',
  );
}
if (!flat.includes(NAMED)) {
  problems.push(`the output does not contain the named error "${NAMED}"`);
}
if (figures === null) {
  if (flat.includes(NAMED)) problems.push('the named error did not carry the figures it should');
} else {
  const elapsedMs = Number(figures[1]);
  const completed = Number(figures[2]);
  const requested = Number(figures[3]);
  const ceilingMs = Number(figures[4]);
  if (requested !== Number(ITERATIONS)) {
    problems.push(
      `the storm ran ${String(requested)} iterations, not the ${ITERATIONS} this arm asked for: ` +
        'the knob did not reach the test',
    );
  }
  if (!(elapsedMs > ceilingMs)) {
    problems.push(
      `the error reports ${String(elapsedMs)} ms against a ceiling of ${String(ceilingMs)} ms, ` +
        'which is not an exceeded ceiling',
    );
  }
  if (!(completed > 0 && completed < requested)) {
    problems.push(
      `the storm was stopped at iteration ${String(completed)} of ${String(requested)}: ` +
        'the enforcement must stop it EARLY, after real work and before the end',
    );
  }
  process.stdout.write(
    `\nSTORM-CEILING ARM: named error at ${String(elapsedMs)} ms against a measured ceiling of ` +
      `${String(ceilingMs)} ms, after ${String(completed)} of ${String(requested)} iterations.\n`,
  );
}

if (problems.length === 0) {
  process.stdout.write(
    'STORM-CEILING ARM: the R-13 enforcement branch fired, for the reason it exists.\n',
  );
  process.exit(1);
}

const calibrated = /one 54-table probe pass costs ([\d.]+) ms/.exec(flat);
process.stdout.write(
  `\nSTORM-CEILING ARM: NOT PROVEN — ${String(problems.length)} problem(s):\n` +
    problems.map((problem) => `  · ${problem}\n`).join('') +
    (calibrated !== null
      ? `\nThe run calibrated one probe pass at ${String(calibrated[1])} ms. A ${ITERATIONS}-` +
        'iteration storm crosses its ceiling only while the pass cost it SUSTAINS is above ' +
        `max(5 ms, 0.3 x ${String(calibrated[1])} ms) — 5 ms being the 120 000 ms floor over the ` +
        "storm's 24 000 probe passes, and 0.3 being those 24 000 against the 7 200 the ceiling " +
        'scales (1 800 passes x the x4 safety). Raise the iteration count further: it costs no ' +
        'extra time, because the enforcement stops the storm at the ceiling either way.\n'
      : '') +
    'Exiting 0 so the runner records NOT PROVEN: a red leg that failed for the wrong reason ' +
    'proves nothing about this branch.\n',
);
process.exit(0);
