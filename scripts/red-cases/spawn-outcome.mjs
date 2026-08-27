/**
 * **Did the gate process actually reach a verdict?** (OPUS-M5-H, FU-25.)
 *
 * `scripts/red-cases/run.mjs` spawns each arm's gate command and reads the exit
 * status. Two `spawnSync` outcomes are not exit statuses at all, and both of them
 * used to arrive at the runner looking exactly like an ordinary `GATE FAILED`:
 *
 *  1. **the process never started** — `result.error` carries an `ENOENT`/`EACCES`
 *     and `result.status` is `null` (FAD-50 N-1(ii) / FAD-51 D-1);
 *  2. **the process was killed by a signal** — `result.signal` carries the signal
 *     name and `result.status` is `null` (FU-25).
 *
 * The second is the dangerous one and it is the reason this module exists.
 * `run.mjs` scores an arm's RED leg as PROVEN when the gate command exits
 * non-zero, so a gate killed mid-run scored **"the gate failed as required"** —
 * *a kill counted as proof*, which is the decorative red case the whole battery
 * exists to detect, arriving through the detector itself. On the GREEN leg the
 * same kill reads `GATE FAILED` and reports an arm unproven that was never
 * tested. FU-25's evidence is measured rather than argued: at OPUS-M5-002 an
 * isolated arm re-run left `/tmp/sp-vitest-must-run-OsC0Kq/` behind empty (the
 * wrapper removes that directory on every completed run, so a surviving one IS a
 * killed wrapper), and eight such directories span 2026-08-23 → 08-26 with five
 * of them predating that packet's worktree; kernel OOM is excluded by
 * `/proc/vmstat` `oom_kill 0`, so the kills are userspace and environmental.
 *
 * ## Why it is a module of its own
 *
 * `run.mjs` runs the whole battery on import and therefore cannot be imported by
 * a test. `errored-signatures.mjs` was split out for exactly that reason and says
 * so; this is the same split applied to the classification that PRODUCES the text
 * those signatures match. With both halves importable,
 * `scripts/red-cases/runner-signature/check.mjs` can spawn a child that really
 * kills itself with `SIGKILL`, hand the REAL `spawnSync` result to the REAL
 * classifier, and assert the verdict — rather than pinning a string somebody
 * typed.
 *
 * ## What it deliberately does NOT do
 *
 * It does not classify a signal death that happens BELOW the runner's own child.
 * `run.mjs` spawns the package manager, which spawns the gate, which may spawn
 * `scripts/gates/vitest-must-run.mjs`, which spawns vitest. A signal delivered to
 * the whole process group reaches the runner's own child and is caught here; a
 * signal delivered to a grandchild alone leaves the package manager to report an
 * ordinary non-zero exit, and this module cannot tell that from a gate failure.
 * FU-25's ratified fix is the narrow one at this site ("narrower than a
 * wrapper-side signature and closes both directions at the source"), and the
 * residual is stated here rather than left for a reader to discover.
 */

/**
 * The runner's diagnostic for a spawn that produced no verdict, or `null` when
 * the process ran and its exit status means something.
 *
 * The returned text is written so `erroredReason` (`./errored-signatures.mjs`)
 * classifies it as ERRORED — did not run. Structure only, never content
 * (I-07 / non-bypass rule 9): the command line, the errno code or signal name,
 * and nothing the gate printed.
 *
 * @param {{ error?: unknown, signal?: NodeJS.Signals | null }} result a `spawnSync` result
 * @param {string} commandText the command line, for the human reading the report
 * @returns {string | null}
 */
export function spawnOutcomeDiagnostic(result, commandText) {
  /* FAD-50 N-1(ii). `spawnSync` reports a failure to START the process in
   * `result.error`, NOT in `status` — an ENOENT leaves `status: null`, empty
   * stdout and empty stderr. That read as `ok: false` with no output at all, so
   * an arm whose command could not be spawned reported "GATE FAILED" and was
   * indistinguishable from a gate that ran and correctly failed. The reviewer
   * hit exactly that, silently.
   *
   * Rendered into the output as an ERRORED signature instead, so the detector
   * that already exists for "this arm did not RUN" catches it. A missing binary
   * is not evidence about a gate.
   *
   * The wording is quoted verbatim in `runner-signature/check.mjs`; it is the
   * runner's own vocabulary and a rewording that stopped matching must fail
   * there rather than silently downgrading every future spawn failure. */
  if (result.error !== undefined && result.error !== null) {
    const reason = /** @type {{ message?: unknown }} */ (result.error).message ?? String(result.error);
    return (
      `RED-CASE RUNNER: the command could not be spawned (${String(reason)}).\n` +
      `  command: ${commandText}\n` +
      'vitest matched no test file (a filter or a path is wrong)\n'
    );
  }

  /* FU-25, the same class one step later: the process STARTED and was then
   * killed. `result.signal` is the only place that fact appears — `status` is
   * `null`, which `run.mjs` compared against 0 and read as a failing gate.
   *
   * A killed gate is not a verdict in either direction, and the asymmetry is
   * what makes it worth its own branch: on GREEN it costs an arm that was never
   * tested, and on RED it BUYS a proof that was never earned. */
  if (result.signal !== undefined && result.signal !== null) {
    return (
      `RED-CASE RUNNER: the gate was KILLED by a signal (${String(result.signal)}) ` +
      'and never reached a verdict.\n' +
      `  command: ${commandText}\n` +
      '  A killed gate says nothing in either direction: on GREEN it costs an arm that\n' +
      '  was never tested, and on RED it would otherwise score as "the gate failed as\n' +
      '  required" — a kill counted as PROOF (FU-25).\n'
    );
  }

  return null;
}

/**
 * The marker `scripts/gates/vitest-must-run.mjs` announces its report directory
 * with. One constant, quoted by the emitter and by the reader, so the two cannot
 * drift.
 */
export const REPORT_DIR_MARKER = 'VITEST-MUST-RUN-REPORT-DIR:';

/**
 * A diagnostic when a FAILED gate's vitest wrapper was killed, or `null`.
 *
 * FU-25's residual, closed by mechanizing M5-002's own inference rule. The
 * wrapper removes its report directory on every path it completes, so **a
 * surviving directory IS a killed wrapper** — and that is the one signal-death
 * case neither branch above can see, because a killed wrapper writes no
 * diagnostic and the package manager converts its signal death into an ordinary
 * `exit 1` (measured: `status=1, signal=null` for both a direct child and a
 * grandchild of the runner's own child).
 *
 * Only ever consulted on a NON-ZERO gate result. A gate that passed is a gate
 * that ran, whatever is lying around in `/tmp`.
 *
 * The wording carries the same "the gate was KILLED by a signal" phrase as the
 * branch above and as the wrapper's own announcement: **one signature, three
 * emitters, one matcher.**
 *
 * @param {string} output the gate's combined output
 * @param {string} commandText the command line, for the human reading the report
 * @param {(path: string) => boolean} exists injected so the reader is testable
 * @returns {string | null}
 */
export function killedWrapperDiagnostic(output, commandText, exists) {
  const surviving = [];
  const pattern = new RegExp(`${REPORT_DIR_MARKER}\\s+(\\S+)`, 'g');
  for (const match of output.matchAll(pattern)) {
    const directory = match[1];
    if (directory !== undefined && exists(directory)) surviving.push(directory);
  }
  if (surviving.length === 0) return null;

  return (
    'RED-CASE RUNNER: the gate was KILLED by a signal — inferred, and the inference ' +
    'is M5-002\'s.\n' +
    `  command: ${commandText}\n` +
    `  surviving report director${surviving.length === 1 ? 'y' : 'ies'}: ${surviving.join(', ')}\n` +
    '  scripts/gates/vitest-must-run.mjs removes that directory on every run it\n' +
    '  COMPLETES, in every direction. A surviving one means the wrapper itself was\n' +
    '  killed — and a killed wrapper writes no diagnostic, while the package manager\n' +
    '  reports its signal death as an ordinary exit 1. Nothing ran to a verdict.\n'
  );
}
