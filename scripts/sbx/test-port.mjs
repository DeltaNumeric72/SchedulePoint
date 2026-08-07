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

/* ---------------------------------------------------------------------------
 * The NESTED cluster port -- OPUS-M3-008 revision, orchestrator finding O-1
 * ------------------------------------------------------------------------- */

/**
 * The lowest port `deriveNestedTestPgPort` can produce.
 *
 * `55900..56299`: the main band (`55500..55899`) shifted up by exactly its own
 * span, so the two bands are adjacent and disjoint by construction rather than
 * by two numbers that have to be kept in agreement.
 */
export const DERIVED_NESTED_PORT_BASE = DERIVED_PORT_BASE + DERIVED_PORT_SPAN;

/**
 * The port a NESTED api-project run uses -- a run spawned from inside a test that
 * is itself running against a cluster.
 *
 * ## The finding this closes (O-1)
 *
 * `apps/api/test/red-cases/gates-fail-on-violations.test.ts` proves that the real
 * api project exits non-zero on a failing spec, by spawning the whole project --
 * globalSetup, cluster daemon and all -- from inside a test. That nested run needs
 * a port of its own, and it had a hard-coded `55455`.
 *
 * A fixed port is the exact class E-1 closed for the main cluster and this packet
 * closed for the preview server, and it failed the same way: under two concurrent
 * batteries the nested runs collided, the RED arm failed, and fixed seed 8675309
 * reported a failure that passes 12/12 serially. **It had already been recorded
 * once, at the same seed, by OPUS-M3-002.** FAD-15 ruling 3 says a seed failure is
 * a defect to fix; twice is once too many.
 *
 * ## Why an offset rather than a second hash
 *
 * The offset is taken from `deriveTestPgPort`'s OWN digest, so the nested port
 * and the main port move together and cannot drift into disagreeing about which
 * worktree they belong to. Two worktrees collide on a nested port only when they
 * already collide on the main one -- so this adds no new collision class, and the
 * band arithmetic has one source of truth.
 *
 * `SP_TEST_NESTED_PG_PORT` overrides it, on the same terms as the others: an
 * explicit value wins and a malformed one throws.
 *
 * @param {string} root absolute path of the worktree root
 * @returns {number}
 */
export function deriveNestedTestPgPort(root) {
  return DERIVED_NESTED_PORT_BASE + (deriveTestPgPort(root) - DERIVED_PORT_BASE);
}

/**
 * The nested port this worktree will actually use.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function resolveNestedTestPgPort(env = process.env) {
  const override = env['SP_TEST_NESTED_PG_PORT'];
  if (override !== undefined && override.trim() !== '') {
    const parsed = Number.parseInt(override, 10);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      throw new Error(
        `SP_TEST_NESTED_PG_PORT is "${override}", which is not a port number between 1024 and 65535.`,
      );
    }
    return parsed;
  }
  return deriveNestedTestPgPort(REPO_ROOT);
}

/* ---------------------------------------------------------------------------
 * The Playwright preview port — OPUS-M3-008, closing E-2 the way E-1 was closed
 * ------------------------------------------------------------------------- */

/**
 * The lowest preview port the derivation can produce.
 *
 * `41730..42129`. Deliberately far above `4173` — vite preview's default, and
 * the fixed port this repository used until now — so a derived port can never
 * collide with the documented one, and clearly related to it so a reader
 * recognises the band. The same 400-slot span as the database band, for the same
 * reason.
 */
export const DERIVED_PREVIEW_PORT_BASE = 41730;
/** How many preview ports the derivation can produce. */
export const DERIVED_PREVIEW_PORT_SPAN = 400;

/**
 * A stable preview port for `root`.
 *
 * ## Why this is now derived, when OPUS-M2-004 argued it should not be
 *
 * M2-004 closed E-2 with an override (`SP_TEST_PREVIEW_PORT`) and NO derived
 * default, on an argument that was correct as far as it went: a database-port
 * collision is silent and destructive, while a preview-port collision is loud
 * and harmless because `--strictPort` refuses to start and says so.
 *
 * **The argument held and the conclusion still failed.** OPUS-M3-004's report
 * records two red-case arms "not proven" whose cause turned out to be exactly
 * this collision between concurrent worktrees — because the failure is loud in
 * the *preview server's* output and, by the time it reaches a red-case summary
 * line, indistinguishable from the gate under test simply not firing. An agent
 * then spends its budget on the wrong hypothesis. A fix that leaves that trap
 * open is not the proportionate one.
 *
 * The override still wins, and still throws on a malformed value: the red-case
 * harness and anyone debugging a preview server want to pin it.
 *
 * ## The domain separator is a VISIBLE colon, and that is a correction
 *
 * `deriveTestPgPort` above uses `\u0000` — spelled as an escape precisely
 * because, as its own docblock says, "a raw NUL byte is load-bearing and
 * invisible, and neither a reader nor grep can see it". That warning was earned
 * again here, immediately: the first version of THIS function was written with a
 * literal NUL in the source while `apps/web/playwright.config.ts`'s mirror had a
 * SPACE, so the two implementations silently derived different ports — and the
 * equality test passed anyway, because it compared the constants and the version
 * prefix as TEXT rather than comparing the numbers.
 *
 * Both halves are fixed. The separator is a `:` — visible, greppable, and
 * impossible to get wrong by copying — and the test now compares the SEPARATOR
 * BYTES of the two files and the derived port VALUES, not their wording. The
 * database port keeps its `\u0000` because changing it would move every derived
 * database port; this one is new in OPUS-M3-008 and has no history to preserve.
 *
 * @param {string} root absolute path of the worktree root
 * @returns {number}
 */
export function deriveTestPreviewPort(root) {
  const digest = createHash('sha256').update(`sp.test.preview.port.v1:${root}`).digest('hex');
  return (
    DERIVED_PREVIEW_PORT_BASE +
    (Number.parseInt(digest.slice(0, 8), 16) % DERIVED_PREVIEW_PORT_SPAN)
  );
}

/**
 * The preview port this worktree's Playwright run will actually use.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function resolveTestPreviewPort(env = process.env) {
  const override = env['SP_TEST_PREVIEW_PORT'];
  if (override !== undefined && override.trim() !== '') {
    const parsed = Number.parseInt(override, 10);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      throw new Error(
        `SP_TEST_PREVIEW_PORT is "${override}", which is not a port number between 1024 and 65535.`,
      );
    }
    return parsed;
  }
  return deriveTestPreviewPort(REPO_ROOT);
}
