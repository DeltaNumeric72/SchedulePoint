#!/usr/bin/env node
/**
 * **The red-case runner's own control** (OPUS-M4-005).
 *
 * A runner that cannot tell "this arm did not run" from "this gate failed"
 * launders a broken arm into a PROVEN one — and the runner is the thing every
 * other gate's falsifiability rests on. So the signature list gets a control of
 * its own, and the control is falsifiable: emptying `ERRORED_SIGNATURES` makes
 * this exit non-zero.
 *
 * Both directions are asserted. A checker that only tested the positive case
 * would pass with a pattern of `/.*``/`, which would mark every arm ERRORED and
 * be just as useless.
 *
 * ## The signal-death arm is EXECUTED, not quoted (OPUS-M5-H, FU-25)
 *
 * Every sample below this line is a string somebody typed, which is the right
 * instrument for pinning wording. It is the wrong instrument for FU-25, whose
 * claim is not "this text is classified as ERRORED" but **"a gate that is killed
 * mid-run is classified as ERRORED"** — and the gap between those two is exactly
 * where the defect lived: the wording existed, the runner never produced it,
 * because it read `status` and a killed child leaves `status: null`. So section 3
 * SPAWNS A REAL CHILD, KILLS IT WITH A REAL `SIGKILL`, and hands the real
 * `spawnSync` result to the real classifier `run.mjs` uses. Nothing about that
 * arm is simulated except the identity of the victim.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { erroredReason } from '../errored-signatures.mjs';
import {
  REPORT_DIR_MARKER,
  killedWrapperDiagnostic,
  spawnOutcomeDiagnostic,
} from '../spawn-outcome.mjs';
import {
  VITEST_WRAPPER,
  findUnwrappedVitestInvocations,
} from '../vitest-invocation.mjs';

const MUST_BE_ERRORED = [
  'No test files found, exiting with code 1',
  "red case \"foo\": anchor not found in bar.ts.",
  /* FAD-51 D-1. The runner's OWN synthesised spawn diagnostic, quoted in the
   * shape `run()` emits it. A spawn failure leaves `status: null` and empty
   * output, so without this it read as an ordinary GATE FAILED — and in the
   * asymmetric case (green spawns, red does not) the arm reported PROVEN having
   * never tested its violation. Kept verbatim so a reworded diagnostic that
   * stopped matching fails HERE rather than silently downgrading every future
   * spawn failure. */
  /* The command names a REAL test file, and deliberately.
     `citation-integrity.test.ts` scans full paths across every tracked source
     and cannot tell a fixture string from a citation — correctly, since nothing
     in the text distinguishes them. The first version of this sample invented a
     plausible-looking path, and the gate caught it as a citation to a file no
     clone has. Naming something that exists costs nothing here and keeps the
     gate's reach undiminished. */
  'RED-CASE RUNNER: the command could not be spawned (spawnSync pnpm ENOENT).\n' +
    '  command: pnpm exec vitest run apps/api/test/db/queue-pool-release.test.ts\n',
  /* REV-B-006 / GH-008. The zero-match guard's own diagnostic, in the shape
     `scripts/gates/vitest-must-run.mjs` writes it. An arm whose command selected
     no test did not run, whichever direction it was pointed in, and the runner
     has to say so rather than scoring the gate. */
  '\nTHIS TEST INVOCATION EXECUTED NOTHING.\n' +
    '  executed: 0   skipped: 45\n',
  /* The same wrapper's OTHER "did not run" exit (FAD-53 R-7 C-2, the FAD-51 D-1
     class one layer down): `spawnSync` reports a failure to START vitest in
     `result.error` with `status: null`, and the wrapper's exit code alone would
     read as a gate failure. Pinned in the runner's own vocabulary, so the
     wrapper cannot be reworded out of the classification. */
  '\nVITEST-MUST-RUN: the vitest process could not be spawned (spawnSync EACCES).\n' +
    '  arguments: (none)\n',
  /* FU-25 (OPUS-M5-H), the wrapper's signal-death announcement. The runner
     cannot see this kill for itself — pnpm converts a descendant's signal death
     into `exit 1, signal null`, measured for both a direct child and a
     grandchild — so the wrapper says it, in the same words
     `scripts/red-cases/spawn-outcome.mjs` uses. One signature, two emitters, one
     matcher; pinned here so a rewording of either emitter fails HERE rather than
     silently letting a kill score as a verdict again. */
  '\nVITEST-MUST-RUN: the gate was KILLED by a signal (SIGKILL) and never reached a verdict.\n' +
    '  arguments: (none)\n',
];

const MUST_NOT_BE_ERRORED = [
  'FAIL  route-policy-check (I-02) — 1 violation(s)',
  /* A gate that legitimately says the word "spawned" in passing must NOT be
     swept up — the pattern is about the runner's own diagnostic, not the word. */
  'PASS  provider-boundary — 4 provider(s) spawned and reaped cleanly',
  ' Test Files  1 failed (1)\n      Tests  3 failed | 40 passed (43)',
  'PASS  raw-nul-scan (FAD-45(1)) — 1201 text file(s) scanned',
];

const problems = [];

/* ── 3. FU-25: a REAL killed gate, through the REAL classifier ──────────────
 *
 * The child kills itself with `SIGKILL`, so `spawnSync` returns
 * `{ status: null, signal: 'SIGKILL' }` — the shape the environment produces
 * when it kills a long vitest leg, and the shape `run.mjs` used to score as a
 * failing gate. Three things are asserted, and the third is the one that matters:
 *
 *   (a) the child really died by signal, not by exit code — otherwise this arm
 *       would be proving something about a process that exited normally;
 *   (b) the classifier produces a diagnostic for it at all;
 *   (c) `erroredReason` classifies THAT diagnostic as ERRORED — the end-to-end
 *       property, over the two modules that have no compiler relating them.
 *
 * And the negative control, in the same shape: a child that exits 1 of its own
 * accord is an ORDINARY GATE FAILURE and must produce NO diagnostic. Without it
 * a classifier that returned a diagnostic unconditionally would pass (a), (b)
 * and (c) while marking every failing gate as never having run — the same
 * uselessness the `/.*``/` pattern above would produce, one layer down. */
const SELF_KILL = 'process.kill(process.pid, "SIGKILL");';
const killed = spawnSync(process.execPath, ['-e', SELF_KILL], { encoding: 'utf8' });

if (killed.signal !== 'SIGKILL') {
  problems.push(
    'the self-kill probe did NOT die by signal ' +
      `(signal=${String(killed.signal)}, status=${String(killed.status)}) — this arm cannot ` +
      'prove anything about a killed gate and must not report that it did',
  );
} else {
  const diagnostic = spawnOutcomeDiagnostic(killed, `${process.execPath} -e ${SELF_KILL}`);
  if (diagnostic === null) {
    problems.push(
      'a gate KILLED by SIGKILL produced no runner diagnostic — it would reach run.mjs as an ' +
        'ordinary non-zero exit, and on a RED leg a kill would score as PROOF (FU-25)',
    );
  } else if (erroredReason(diagnostic) === null) {
    problems.push(
      'the killed-gate diagnostic is NOT classified as ERRORED, so the arm would still be ' +
        `scored as a verdict: ${JSON.stringify(diagnostic)}`,
    );
  } else if (!diagnostic.includes('SIGKILL')) {
    problems.push(
      'the killed-gate diagnostic does not name the signal, so the report cannot say what ' +
        `happened: ${JSON.stringify(diagnostic)}`,
    );
  }
}

const failedNormally = spawnSync(process.execPath, ['-e', 'process.exit(1);'], {
  encoding: 'utf8',
});
if (failedNormally.status !== 1 || failedNormally.signal !== null) {
  problems.push(
    'the negative-control probe did not exit 1 on its own ' +
      `(signal=${String(failedNormally.signal)}, status=${String(failedNormally.status)})`,
  );
} else if (spawnOutcomeDiagnostic(failedNormally, 'node -e process.exit(1)') !== null) {
  problems.push(
    'an ordinary FAILING gate was given a did-not-run diagnostic — every real gate failure ' +
      'would be reported as ERRORED, which is exactly as useless as never reporting one',
  );
}

/* ── 3b. FU-25's residual: a surviving report directory IS a killed wrapper ──
 *
 * Proved against the REAL filesystem, not an injected stub, because the whole
 * claim is about a directory existing. A real temp directory is created, the
 * wrapper's announcement is synthesised around its real path, and the reader must
 * find it; the directory is then removed and the reader must fall silent. That
 * second half is what stops this from being a check that marks every failing
 * gate ERRORED — which is the failure mode with the worst blast radius here,
 * since it would make the battery incapable of reporting any verdict at all. */
{
  const dir = mkdtempSync(join(tmpdir(), 'sp-runner-signature-probe-'));
  const output = `some gate output\n${REPORT_DIR_MARKER} ${dir}\nTest Files  1 failed (1)\n`;
  const present = killedWrapperDiagnostic(output, 'pnpm run gate:unit', existsSync);
  if (present === null) {
    problems.push(
      'a SURVIVING vitest-must-run report directory produced no diagnostic — a killed wrapper ' +
        'would still score as a gate verdict (FU-25 residual)',
    );
  } else if (erroredReason(present) === null) {
    problems.push(
      `the surviving-report-dir diagnostic is not classified as ERRORED: ${JSON.stringify(present)}`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
  if (killedWrapperDiagnostic(output, 'pnpm run gate:unit', existsSync) !== null) {
    problems.push(
      'a REMOVED report directory still produced a killed-wrapper diagnostic — every ordinary ' +
        'gate failure would be reported as never having run',
    );
  }
}

/* ── 4. FU-08: the unwrapped-vitest predicate, both directions ──────────────
 *
 * `run.mjs` applies this to its own registry at module scope, where it refuses to
 * start a battery containing an arm that reaches vitest unwrapped. It cannot be
 * applied to the real registry from here — `run.mjs` runs the whole battery on
 * import — so what is proved here is the FUNCTION, on cases written to be
 * unambiguous, in both directions:
 *
 *   - an unwrapped invocation is FOUND, in every command slot, in each of the
 *     three spellings a future arm might reach for;
 *   - a WRAPPED invocation, and a command that never mentions vitest, are left
 *     alone. A predicate that flagged everything would stop every battery and be
 *     removed within a day, which is not a control.
 */
const UNWRAPPED_FIXTURES = [
  { id: 'a', greenCommand: ['exec', 'vitest', 'run', 'x.test.ts'] },
  { id: 'b', redCommand: ['exec', 'node_modules/.bin/vitest', 'run', 'x.test.ts'] },
  { id: 'c', prepare: [['exec', 'vitest', 'run', 'x.test.ts']] },
];
for (const fixture of UNWRAPPED_FIXTURES) {
  if (findUnwrappedVitestInvocations([fixture]).length !== 1) {
    problems.push(
      `an UNWRAPPED vitest invocation was not detected (arm ${fixture.id}) — the boundary ` +
        'FU-08 closed would re-open with nothing turning red',
    );
  }
}

const WRAPPED_FIXTURES = [
  { id: 'd', greenCommand: ['exec', 'node', VITEST_WRAPPER, 'x.test.ts'] },
  { id: 'e', redCommand: ['run', 'gate:unit'] },
  { id: 'f', greenCommand: ['exec', 'node', 'scripts/gates/secret-scan.mjs'] },
  /* The wrapper's own path must not be mistaken for the binary: its basename ends
     in `.mjs` and the naive `includes('vitest')` test would flag every arm the
     packet just repaired. */
  { id: 'g', restore: [['exec', 'node', VITEST_WRAPPER, 'y.test.ts']] },
];
for (const fixture of WRAPPED_FIXTURES) {
  const found = findUnwrappedVitestInvocations([fixture]);
  if (found.length !== 0) {
    problems.push(
      `a correctly WRAPPED arm was flagged (arm ${fixture.id}): ${JSON.stringify(found)}`,
    );
  }
}

for (const text of MUST_BE_ERRORED) {
  if (erroredReason(text) === null) {
    problems.push(`NOT detected as ERRORED, and it must be: ${JSON.stringify(text)}`);
  }
}
for (const text of MUST_NOT_BE_ERRORED) {
  const reason = erroredReason(text);
  if (reason !== null) {
    problems.push(
      `detected as ERRORED (${reason}) and it must NOT be — an ordinary gate failure: ` +
        JSON.stringify(text),
    );
  }
}

/* ── 5. FU-13 (R-8's F3): the preflights are CALLED, not merely defined ─────
 *
 * R-8 landed the migration-anchor supersession preflight and its own red-case
 * arm, and the review recorded what neither covered: **nothing asserts that
 * `run.mjs` actually calls it.** The arm proves the FUNCTION refuses a
 * superseded anchor; a commented-out call site would leave that arm green and the
 * battery unguarded, which is the decorative-control shape one level up from the
 * one the battery exists to catch.
 *
 * A source assertion rather than an executed one, and the reason is the same one
 * that put `errored-signatures.mjs` in its own module: `run.mjs` runs the entire
 * battery on import, so a checker cannot import it to observe a call. The
 * anchoring is at column 0 — a call at module scope, not one nested inside a
 * function that nothing invokes.
 *
 * FU-08's registry preflight is asserted the same way in the same breath: it is
 * new in this packet, it has exactly the same failure mode, and adding it here
 * costs one line. */
const RUN_MJS = readFileSync(new URL('../run.mjs', import.meta.url), 'utf8');
for (const preflight of ['assertMigrationAnchorsAreLive', 'assertEveryVitestInvocationIsWrapped']) {
  if (!new RegExp(`^${preflight}\\(\\);$`, 'm').test(RUN_MJS)) {
    problems.push(
      `run.mjs does not CALL ${preflight}() at module scope. The preflight's own red case ` +
        'proves the function refuses; only this proves the runner asks it.',
    );
  }
}

if (problems.length > 0) {
  process.stdout.write(`FAIL  red-case runner ERRORED signatures — ${String(problems.length)} problem(s)\n`);
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  process.exit(1);
}

process.stdout.write(
  `PASS  red-case runner ERRORED signatures — ${String(MUST_BE_ERRORED.length)} detected, ` +
    `${String(MUST_NOT_BE_ERRORED.length)} correctly left alone; a REAL SIGKILLed child ` +
    'classified ERRORED and a real exit-1 child left as a gate failure (FU-25)\n',
);
