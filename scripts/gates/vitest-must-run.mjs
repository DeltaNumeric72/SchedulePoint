import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * **A test invocation that selected NOTHING is a FAILED run, not a passed one**
 * (REV-B-006 / GH-008's registered "vitest zero-match-exits-0 guard"; the
 * precedent is FAD-50 C-3's `MustRunReporter`, and this is that argument moved
 * from Playwright to Vitest).
 *
 * ## The hazard, reproduced
 *
 * REV-B reproduced it exactly (`transcripts/t03-vitest-zero-match.txt`):
 *
 * ```
 * $ pnpm exec vitest run packages/domain/test/ports/result-reproducibility.test.ts \
 *     -t 'NO_SUCH_TEST_NAME_REVB'
 *  ↓ |domain| test/ports/result-reproducibility.test.ts (31 tests | 31 skipped)
 *  Test Files  1 skipped (1)
 *       Tests  31 skipped (31)
 * EXIT=0
 * ```
 *
 * Zero tests executed, exit 0, no diagnostic. `--passWithNoTests=false` — which
 * is already the default and is what makes a wrong PATH exit non-zero with
 * `No test files found` — does not cover this: the files were found, collected
 * and then filtered to nothing by the NAME pattern, and Vitest reports that as
 * a clean skip.
 *
 * REV-B also established the mitigating half by execution: no `-t` /
 * `--testNamePattern` filter is used anywhere in `package.json`, `scripts/` or
 * `.github/workflows/ci.yml` today. So the hazard is latent rather than live —
 * and one `-t` away from making a battery decorative.
 *
 * ## What this wrapper does
 *
 * Runs `vitest run` with the caller's own arguments, streams its output
 * unchanged, and then FAILS the invocation when the run executed no tests. The
 * count is read from Vitest's own JSON reporter rather than scraped out of the
 * summary text, so a change to the human-readable output cannot quietly disarm
 * it. `executed = numPassedTests + numFailedTests`; **pending (skipped) tests
 * are not executed**, deliberately and for the same reason `MustRunReporter`
 * counts them that way — a suite that skipped itself proved nothing.
 *
 * A genuine failure inside the run is passed through untouched: the child's exit
 * code wins whenever it is non-zero. This guard only ever turns a zero into a
 * one.
 *
 * ## The boundary, stated rather than implied
 *
 * This is the guard for invocations that go **through it**: `gate:unit` and
 * `gate:unit:builds` in `package.json`, which is what `pnpm check`, the CI unit
 * job and every `pnpm run gate:unit` red-case arm run. It is NOT a repository-
 * wide interception of Vitest: the red-case arms that spawn
 * `pnpm exec vitest run <path>` directly still reach Vitest unwrapped. Those
 * carry PATH filters only — a wrong path is already an ERRORED signature — and
 * an arm may be routed through this wrapper by changing its command. A guard
 * that claimed to cover invocations it does not is the class of claim this
 * repository's review process exists to catch.
 *
 * Usage: `node scripts/gates/vitest-must-run.mjs [vitest run arguments...]`
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VITEST_BIN = resolve(REPO_ROOT, 'node_modules/.bin/vitest');

if (!existsSync(VITEST_BIN)) {
  process.stderr.write(
    `vitest-must-run: vitest is not installed at ${VITEST_BIN}.\n` +
      '  Run `corepack pnpm install` (corepack only — see docs/dev-setup.md).\n',
  );
  process.exit(127);
}

const forwarded = process.argv.slice(2);
const reportDir = mkdtempSync(join(tmpdir(), 'sp-vitest-must-run-'));
const reportPath = join(reportDir, 'run.json');

/* FU-25's residual, mechanized (OPUS-M5-H).
 *
 * This wrapper removes `reportDir` on EVERY path it completes — success,
 * failure, spawn error, signal death of its child. So **a surviving directory is
 * a killed WRAPPER**: that inference rule is M5-002's, drawn from eight empty
 * `sp-vitest-must-run-*` directories spanning four days, and it was the evidence
 * that established the environment's kill class in the first place.
 *
 * It was an inference a human made afterwards by listing `/tmp`. Announcing the
 * path here turns it into something the red-case runner can check for itself: on
 * a non-zero gate whose announced directory still exists, the runner scores
 * ERRORED — did not run — instead of counting a kill as a verdict. Without this
 * line the case is undetectable from outside, because a killed wrapper writes no
 * diagnostic of its own and pnpm converts its signal death into an ordinary
 * `exit 1`.
 *
 * One line, on stderr, structure only. */
process.stderr.write(`VITEST-MUST-RUN-REPORT-DIR: ${reportDir}\n`);

/* `default` is re-stated because naming any reporter replaces the default set,
   and the human reading this run must still see the run. */
const result = spawnSync(
  VITEST_BIN,
  ['run', ...forwarded, '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`],
  { cwd: REPO_ROOT, stdio: 'inherit' },
);

/* FAD-51 D-1's class, at this layer. `spawnSync` reports a failure to START a
 * process in `result.error`, NOT in `status` — an ENOENT or EACCES leaves
 * `status: null` with no output of its own. Without this branch the wrapper
 * exited 1 SILENTLY, and a silent non-zero exit reaches
 * `scripts/red-cases/run.mjs` as an ordinary GATE FAILED: the arm scores
 * "the gate failed as required" having never run the gate, which is the
 * decorative red case the runner exists to detect. The wording carries the
 * `could not be spawned` signature `scripts/red-cases/errored-signatures.mjs`
 * already matches, so the runner reads it as ERRORED — did not run.
 *
 * Structure only, never content (I-07 / non-bypass rule 9): the binary path, the
 * errno code, and the argument list the caller passed. */
if (result.error !== undefined) {
  const code = /** @type {NodeJS.ErrnoException} */ (result.error).code ?? 'unknown';
  rmSync(reportDir, { recursive: true, force: true });
  process.stderr.write(
    '\nVITEST-MUST-RUN: the vitest process could not be spawned ' +
      `(spawnSync ${VITEST_BIN} ${code}).\n` +
      `  arguments: ${forwarded.join(' ') || '(none)'}\n` +
      '  Nothing ran, so this is not a gate result at all.\n\n',
  );
  process.exit(1);
}

/* FU-25 (OPUS-M5-H), the wrapper's half of the signal-death class.
 *
 * `scripts/red-cases/run.mjs` treats a signal-killed child as ERRORED — did not
 * run. It cannot see THIS child's death, and that was measured rather than
 * assumed: the runner never spawns vitest directly, it spawns the package
 * manager, and pnpm converts a descendant's signal death into an ordinary
 * `exit 1` with `signal: null` (probed for both a direct child and a grandchild).
 * So a SIGKILL landing on vitest — the long, memory-hungry leg the environment
 * actually kills — reached the runner as a plain non-zero exit and, on a RED leg,
 * scored as "the gate failed as required": a kill counted as PROOF.
 *
 * `result.status ?? 1` below is what erased the distinction. The signal is
 * announced here instead, in the SAME wording
 * `scripts/red-cases/spawn-outcome.mjs` uses, so the runner's existing matcher
 * classifies it: one signature, two emitters, one matcher.
 *
 * **The residual is named rather than assumed closed.** If the WRAPPER ITSELF is
 * killed, it prints nothing — a dead process writes no diagnostic — and pnpm
 * again reports exit 1. That case is FU-25's amendment, with a candidate fix
 * recorded there and deliberately not built here.
 *
 * Structure only, never content (I-07 / non-bypass rule 9). */
if (result.status === null && result.signal !== null && result.signal !== undefined) {
  rmSync(reportDir, { recursive: true, force: true });
  process.stderr.write(
    `\nVITEST-MUST-RUN: the gate was KILLED by a signal (${String(result.signal)}) ` +
      'and never reached a verdict.\n' +
      `  arguments: ${forwarded.join(' ') || '(none)'}\n` +
      '  Nothing ran to completion, so this is not a gate result at all.\n\n',
  );
  process.exit(1);
}

const childStatus = result.status ?? 1;

/** @returns {{ executed: number, skipped: number } | null} */
function countsFromReport() {
  if (!existsSync(reportPath)) return null;
  try {
    const report = /** @type {Record<string, unknown>} */ (
      JSON.parse(readFileSync(reportPath, 'utf8'))
    );
    const number = (/** @type {unknown} */ value) => (typeof value === 'number' ? value : 0);
    return {
      executed: number(report['numPassedTests']) + number(report['numFailedTests']),
      skipped: number(report['numPendingTests']) + number(report['numTodoTests']),
    };
  } catch {
    return null;
  }
}

const counts = countsFromReport();
rmSync(reportDir, { recursive: true, force: true });

/* A real failure inside the run is the answer; this guard never softens one. */
if (childStatus !== 0) process.exit(childStatus);

if (counts === null) {
  /* No report — the run did not get far enough to write one (an unreadable
     config, `No test files found`). Vitest already exits non-zero for those, so
     reaching here with a zero status means something wrote no report AND
     claimed success, which is exactly the shape this file refuses to pass. */
  process.stderr.write(
    '\nVITEST WROTE NO RUN REPORT, AND EXITED 0.\n' +
      '  Nothing can be said about what executed, so this is a FAILED run.\n' +
      `  Arguments: ${forwarded.join(' ')}\n\n`,
  );
  process.exit(1);
}

if (counts.executed === 0) {
  process.stderr.write(
    '\nTHIS TEST INVOCATION EXECUTED NOTHING.\n' +
      `  executed: ${String(counts.executed)}   skipped: ${String(counts.skipped)}\n` +
      `  arguments: ${forwarded.join(' ') || '(none)'}\n` +
      '  Vitest exits 0 when a name filter (-t / --testNamePattern) matches no test:\n' +
      '  the files are found, collected, and then every test in them is skipped.\n' +
      '  A run that executed no test proves nothing, so it fails here rather than\n' +
      '  reporting success (REV-B-006; the FAD-50 C-3 precedent).\n\n',
  );
  process.exit(1);
}

process.exit(0);
