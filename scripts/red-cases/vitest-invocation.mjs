/**
 * **No red-case arm may reach vitest unwrapped** (OPUS-M5-H, FU-08).
 *
 * `scripts/gates/vitest-must-run.mjs` exists because *a test invocation that
 * selected NOTHING is a FAILED run, not a passed one*: vitest exits **0** when a
 * `-t` / `--testNamePattern` filter empties a file it collected, so a battery can
 * become decorative one flag at a time. The wrapper reads vitest's own JSON
 * report and refuses a run that executed nothing.
 *
 * Its docblock stated the boundary honestly — "the red-case arms that spawn
 * `pnpm exec vitest run <path>` directly still reach Vitest unwrapped… an arm may
 * be routed through this wrapper by changing its command" — and REV-B registered
 * the residue as FU-08. **That boundary is now closed**, and this module is what
 * keeps it closed: the runner refuses to START a battery in which any arm invokes
 * vitest directly, so the 28th arm somebody adds unwrapped fails loudly instead
 * of quietly re-opening the hole.
 *
 * ## The measured count, and why the register said four
 *
 * FU-08 was written at REV-B (the M4-005 era) and says *four* arms. Enumerated
 * at `0df0c74`, the registry held **27** — OPUS-M4-000A, 000B and 001 added
 * twenty-three more in the same shape after the entry was written. All 27 are
 * routed through the wrapper in the same change as this control; the register
 * entry carries a dated amendment recording the measured count rather than
 * having its original text rewritten.
 *
 * ## Where each half is proved
 *
 * The PREDICATE is proved both directions on synthetic cases in
 * `scripts/red-cases/runner-signature/check.mjs` — it must find an unwrapped
 * invocation and must leave a wrapped one alone, because a predicate that flags
 * everything is exactly as useless as one that flags nothing. The REGISTRY is
 * checked by `run.mjs` at module scope, before the build preflight and before any
 * arm's GREEN leg, in the same refuse-to-start posture as
 * `assertMigrationAnchorsAreLive`. The split is deliberate and stated rather than
 * implied: `run.mjs` runs the whole battery on import and cannot be imported by a
 * checker, so the checker gets the function and the battery gets the data.
 */

/** The wrapper every vitest invocation in the registry must go through. */
export const VITEST_WRAPPER = 'scripts/gates/vitest-must-run.mjs';

/**
 * Is this argv element an invocation of the vitest binary itself?
 *
 * By basename rather than by exact token, so `vitest`, `node_modules/.bin/vitest`
 * and an absolute path to it are all the same thing. The wrapper's own path is
 * NOT one of these — it is a `.mjs` script whose basename is `vitest-must-run.mjs`
 * — so a wrapped command never matches.
 *
 * @param {string} argument
 * @returns {boolean}
 */
function isVitestBinary(argument) {
  const basename = argument.split('/').pop() ?? argument;
  return basename === 'vitest' || basename === 'vitest.mjs';
}

/**
 * @typedef {{ id: string, leg: string, command: readonly string[] }} UnwrappedInvocation
 */

/**
 * Every arm command that reaches vitest without going through the wrapper.
 *
 * All five command slots are examined, not only the two legs: a `prepare` or
 * `restore` step that runs vitest is running tests, and the zero-execution
 * hazard does not care which field the command was written in.
 *
 * @param {readonly Record<string, unknown>[]} cases the runner's registry
 * @returns {UnwrappedInvocation[]}
 */
export function findUnwrappedVitestInvocations(cases) {
  /** @type {UnwrappedInvocation[]} */
  const problems = [];
  const slots = ['greenCommand', 'redCommand', 'setup', 'prepare', 'restore'];

  for (const testCase of cases) {
    const id = typeof testCase['id'] === 'string' ? testCase['id'] : '(unnamed arm)';
    for (const slot of slots) {
      const value = testCase[slot];
      if (!Array.isArray(value)) continue;
      /* `greenCommand`/`redCommand` are one command; `setup`/`prepare`/`restore`
         are LISTS of commands. Normalising here keeps the caller from having to
         know which is which — and a slot that changed shape would show up as an
         unexamined command rather than as a crash. */
      const commands = Array.isArray(value[0]) ? value : [value];
      for (const command of commands) {
        if (!Array.isArray(command)) continue;
        const argv = command.filter((part) => typeof part === 'string');
        if (!argv.some(isVitestBinary)) continue;
        if (argv.some((part) => part === VITEST_WRAPPER)) continue;
        problems.push({ id, leg: slot, command: argv });
      }
    }
  }

  return problems;
}

/**
 * The refuse-to-start message, in the runner's own voice.
 *
 * @param {readonly UnwrappedInvocation[]} problems
 * @returns {string}
 */
export function describeUnwrappedVitestInvocations(problems) {
  const lines = [
    `RED-CASE RUNNER: ${String(problems.length)} arm command(s) invoke vitest directly.`,
    '',
    `  Every vitest invocation in this registry goes through ${VITEST_WRAPPER},`,
    '  which FAILS a run that executed no test. Vitest exits 0 when a name filter',
    '  empties the files it collected, so an unwrapped arm can report a verdict',
    '  having tested nothing at all (REV-B-006 / FU-08).',
    '',
    "  Replace `'exec', 'vitest', 'run', <paths>` with",
    `  \`'exec', 'node', '${VITEST_WRAPPER}', <paths>\` — the wrapper supplies`,
    '  `run` itself and forwards the rest unchanged.',
    '',
  ];
  for (const problem of problems) {
    lines.push(`  ${problem.id} (${problem.leg}): ${problem.command.join(' ')}`);
  }
  lines.push('');
  return lines.join('\n');
}
