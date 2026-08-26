/**
 * Output that means **an arm did not run**, not "the gate failed"
 * (OPUS-M4-005, closing the M4-001S transient).
 *
 * Two arms' GREEN commands once came back with vitest's `No test files found` —
 * a filter that matched nothing for files that exist — and the runner could not
 * tell that from a gate failure. It is worse in the RED direction:
 * `vitest run some-typo.test.ts` exits NON-ZERO, so an arm whose test path is
 * misspelled records "gate failed as required" and reports **PROVEN** while
 * proving nothing whatsoever. That is the decorative red case the whole runner
 * exists to detect, arriving through the runner itself.
 *
 * `anchor not found` is here for the same reason: M4-002 §14a records a case
 * that was BROKEN rather than failing for four packets, and "a broken case
 * proves nothing at all".
 *
 * `could not be spawned` closes the same class one layer lower (FAD-51 D-1).
 * `spawnSync` reports a failure to START a process in `result.error`, NOT in
 * `status` — an ENOENT leaves `status: null` with empty stdout and stderr. The
 * runner synthesises a diagnostic for that case, and FAD-50 N-1(ii) asked for it
 * to READ as ERRORED; the first attempt appended the human-readable REASON of
 * the `No test files found` signature instead of text any pattern here matches,
 * so `erroredReason` still returned `null` and a spawn failure still scored
 * GATE FAILED. The asymmetric case is the dangerous one: green spawns, red does
 * not, and the arm reports PROVEN with the violation never tested.
 *
 * The pattern therefore matches the runner's own synthesised wording, and
 * `runner-signature/check.mjs` pins a sample of it so the two cannot drift.
 *
 * Its own module so that `scripts/red-cases/runner-signature/check.mjs` can
 * import it — `run.mjs` executes on import and cannot be one.
 */
export const ERRORED_SIGNATURES = [
  {
    pattern: /No test files found/,
    reason: 'vitest matched no test file (a filter or a path is wrong)',
  },
  {
    pattern: /anchor not found/,
    reason: 'a patch anchor no longer matches — the arm is broken, not failing',
  },
  {
    pattern: /could not be spawned/,
    reason: 'the command could not be spawned (a binary is missing from PATH)',
  },
  /* REV-B-006 / GH-008's zero-match guard. `scripts/gates/vitest-must-run.mjs`
   * turns "vitest selected no test and exited 0" into a non-zero exit — and the
   * exit code alone would reach this runner as an ordinary GATE FAILED. It is
   * not one: nothing ran, which is the same class as `No test files found` one
   * step later in the pipeline (the files were found, the NAME filter emptied
   * them). Quoted from the wrapper's own diagnostic, and pinned in
   * `runner-signature/check.mjs` so a reworded message fails there rather than
   * silently downgrading. */
  {
    pattern: /THIS TEST INVOCATION EXECUTED NOTHING/,
    reason: 'vitest selected no test to execute (a name filter matched nothing)',
  },
  /* FU-25 (OPUS-M5-H). The gate STARTED and was then killed. `spawnSync` puts
   * that in `result.signal` and leaves `status: null`, which `run.mjs` compared
   * against 0 and read as a failing gate — so on a RED leg a killed gate scored
   * "the gate failed as required" and **a kill counted as PROOF**, the
   * decorative red case arriving through the detector itself. Measured at
   * M5-002: eight empty `sp-vitest-must-run-*` directories over four days, with
   * kernel OOM excluded (`oom_kill 0`).
   *
   * Quoted from `scripts/red-cases/spawn-outcome.mjs`'s own wording, and pinned
   * in `runner-signature/check.mjs` — where the sample is produced by KILLING a
   * real child rather than typed by hand, so the classifier and this pattern
   * cannot drift apart without that check failing. */
  {
    pattern: /the gate was KILLED by a signal/,
    reason: 'the gate was killed by a signal — it never reached a verdict',
  },
];

/**
 * The reason an arm's output shows it did not run, or `null`.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function erroredReason(text) {
  for (const signature of ERRORED_SIGNATURES) {
    if (signature.pattern.test(text)) return signature.reason;
  }
  return null;
}
