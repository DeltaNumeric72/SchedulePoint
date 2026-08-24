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
 */
import { erroredReason } from '../errored-signatures.mjs';

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

if (problems.length > 0) {
  process.stdout.write(`FAIL  red-case runner ERRORED signatures — ${String(problems.length)} problem(s)\n`);
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  process.exit(1);
}

process.stdout.write(
  `PASS  red-case runner ERRORED signatures — ${String(MUST_BE_ERRORED.length)} detected, ` +
    `${String(MUST_NOT_BE_ERRORED.length)} correctly left alone\n`,
);
