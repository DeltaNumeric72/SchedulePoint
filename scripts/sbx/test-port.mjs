/**
 * The embedded-PostgreSQL test port, derived per worktree (OPUS-M2-004, E-1).
 *
 * ## The finding this closes
 *
 * `apps/api/test/support/env.ts` read `SP_TEST_PG_PORT ?? 55433`, and its
 * docblock said the override existed "so two worktrees can each override it
 * (execution standards §E: concurrent agents never share a database instance)".
 * **Nothing set it.** `.worktrees/m2-002` and `.worktrees/m2-003` therefore
 * derived the same port *and* the same data directory (`.pgdata-test-55433`,
 * since the directory name follows the port), and the two agents' suites
 * destroyed each other's clusters — observed with the runbook's exact
 * signature: whole test *files* failing, tests *skipped*, **zero tests failed**
 * (`docs/evidence/EV-M2-PROFILES/INDEX.md` §1a E-1).
 *
 * The fix is that "each agent gets its own worktree" now *implies* "its own
 * database", with nobody having to remember: the default port is a stable hash
 * of the worktree's own path. An explicit `SP_TEST_PG_PORT` still wins, because
 * the red-case harness deliberately spawns a second cluster on a port of its
 * choosing and the NR-13 benchmarks pin theirs.
 *
 * ## The band, and why this one
 *
 * `55500..55899`. Deliberately **above** every port this repository has ever
 * named — the SP-A spike's 55432, the old default 55433, and the evidence
 * captures at 55437/55439/55444/55445/55455/55471/55473 are all below 55500 —
 * so a derived port can never collide with a documented fixed one. 400 slots
 * over the number of worktrees anybody runs makes an accidental collision
 * between two live worktrees vanishingly unlikely, and a collision is not
 * silent anyway: `cluster-process.ts` refuses to start on an occupied port and
 * names the directory to clear.
 *
 * ## Two implementations, and the test that keeps them equal
 *
 * This module is JavaScript because `scripts/` is outside every TypeScript
 * project in the repository; `apps/api/test/support/env.ts` carries the same
 * arithmetic in TypeScript because the test harness cannot import from
 * `scripts/`. That is a duplication, so it is **asserted**:
 * `apps/api/test/architecture/derived-test-port.test.ts` imports this module and
 * fails if the two ever disagree, for the real worktree and for a table of
 * synthetic paths.
 */
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The lowest port the derivation can produce. */
export const DERIVED_PORT_BASE = 55500;
/** How many ports the derivation can produce. */
export const DERIVED_PORT_SPAN = 400;

/** The repository (or worktree) root, resolved from this module's own location. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * A stable port for `root`.
 *
 * The `\u0000` domain separator is spelled as an ESCAPE, for the same reason
 * `multi.ts`'s `mint` gives: a raw NUL byte is load-bearing and invisible, and
 * neither a reader nor grep can see it. The version prefix means a future change
 * to the band does not have to pretend it produces the same numbers.
 *
 * @param {string} root absolute path of the worktree root
 * @returns {number}
 */
export function deriveTestPgPort(root) {
  const digest = createHash('sha256').update(`sp.test.pg.port.v1\u0000${root}`).digest('hex');
  return DERIVED_PORT_BASE + (Number.parseInt(digest.slice(0, 8), 16) % DERIVED_PORT_SPAN);
}

/**
 * The port this worktree's harness will actually use.
 *
 * An explicit `SP_TEST_PG_PORT` wins. A malformed one throws rather than falling
 * back to the derived value: a typo that silently pointed a run at a different
 * cluster is the failure mode this whole module exists to remove.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function resolveTestPgPort(env = process.env) {
  const override = env['SP_TEST_PG_PORT'];
  if (override !== undefined && override.trim() !== '') {
    const parsed = Number.parseInt(override, 10);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      throw new Error(
        `SP_TEST_PG_PORT is "${override}", which is not a port number between 1024 and 65535.`,
      );
    }
    return parsed;
  }
  return deriveTestPgPort(REPO_ROOT);
}
