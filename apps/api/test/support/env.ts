import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The harness environment, in one place.
 *
 * `globalSetup` runs in Vitest's main process and the tests run in a worker, so
 * environment variables set in one are not visible in the other. Both import
 * this module and call `applyHarnessEnv()`, which makes the configuration
 * identical by construction rather than by two lists staying in sync.
 *
 * ## About the credentials below
 *
 * They are **synthetic, local-only, throwaway** strings for a PostgreSQL cluster
 * that listens on `127.0.0.1`, is created from an empty data directory at the
 * start of every run, and is destroyed at the end of it. They are not secrets,
 * they are not reused anywhere, and they must never be copied into non-test
 * code. Every one of them starts with `fixture-local-` so that a reader — and
 * the secret-scan gate — can tell at a glance that it is not a credential.
 *
 * The production code reads exactly the same variable names and has **no
 * default** for any of them: a missing password throws rather than falling back.
 * That is why the fixture has to set them explicitly here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** `apps/api` */
export const API_ROOT = resolve(HERE, '../..');

/** The worktree root — one level above `apps/`. */
export const REPO_ROOT = resolve(API_ROOT, '../..');

/** The lowest port `deriveTestPgPort` can produce. Mirrors `scripts/sbx/test-port.mjs`. */
export const DERIVED_PORT_BASE = 55500;
/** How many ports `deriveTestPgPort` can produce. Mirrors `scripts/sbx/test-port.mjs`. */
export const DERIVED_PORT_SPAN = 400;

/**
 * A stable port derived from the worktree's own path (OPUS-M2-004, E-1).
 *
 * ## What was wrong
 *
 * This constant used to be `SP_TEST_PG_PORT ?? 55433`, and the docblock said the
 * override existed "so two worktrees can each override it (execution standards
 * §E: concurrent agents never share a database instance)". **Nothing set it.**
 * `.worktrees/m2-002` and `.worktrees/m2-003` derived the same port *and* the
 * same data directory — the directory name follows the port — and the two
 * agents' suites destroyed each other's clusters. It surfaced as the runbook's
 * documented contention signature: whole test *files* failing, tests *skipped*,
 * **zero tests failed** (`docs/evidence/EV-M2-PROFILES/INDEX.md` §1a E-1).
 *
 * A default nobody sets is not a control. The default is now derived, so "each
 * agent gets its own worktree" *implies* its own database.
 *
 * ## The band
 *
 * `55500..55899`, deliberately above every port this repository has ever named
 * (the SP-A spike's 55432, the old default 55433, and every pinned evidence
 * port, all below 55500), so a derived port cannot collide with a documented
 * fixed one.
 *
 * ## The duplicate, and the test that keeps it honest
 *
 * `scripts/sbx/test-port.mjs` carries the same arithmetic in JavaScript, because
 * `scripts/` is outside every TypeScript project here and the harness cannot
 * import from it. `apps/api/test/architecture/derived-test-port.test.ts` imports
 * that module and fails if the two ever disagree.
 *
 * The `\u0000` domain separator is spelled as an escape on purpose — the same
 * lesson `multi.ts`'s `mint` records: a raw NUL byte is load-bearing and
 * invisible to both a reader and grep.
 */
export function deriveTestPgPort(root: string): number {
  const digest = createHash('sha256').update(`sp.test.pg.port.v1\u0000${root}`).digest('hex');
  return DERIVED_PORT_BASE + (Number.parseInt(digest.slice(0, 8), 16) % DERIVED_PORT_SPAN);
}

/**
 * The port this run uses.
 *
 * An explicit `SP_TEST_PG_PORT` still wins — the red-case harness spawns a second
 * cluster on a port of its own choosing, and the NR-13 benchmarks pin theirs. A
 * malformed value throws rather than falling back: a typo that silently pointed a
 * run at a different cluster is the failure mode this exists to remove.
 */
function resolveClusterPort(): number {
  const override = process.env['SP_TEST_PG_PORT'];
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

export const CLUSTER_PORT = resolveClusterPort();

/**
 * The lowest port `deriveNestedTestPgPort` can produce. Mirrors
 * `scripts/sbx/test-port.mjs`.
 */
export const DERIVED_NESTED_PORT_BASE = DERIVED_PORT_BASE + DERIVED_PORT_SPAN;

/**
 * A port for a NESTED api-project run — one spawned from inside a test that is
 * itself running against a cluster (OPUS-M3-008 revision, orchestrator O-1).
 *
 * `apps/api/test/red-cases/gates-fail-on-violations.test.ts` hard-coded `55455`
 * for that spawn. A fixed port is the class E-1 closed for the main cluster and
 * this packet closed for the preview server, and it failed the same way: under
 * two concurrent batteries the nested runs collided and fixed seed 8675309
 * reported a failure that passes 12/12 serially — **the same seed OPUS-M3-002
 * had already recorded it at.**
 *
 * The offset comes from `deriveTestPgPort`'s own digest, so the nested and main
 * ports move together and cannot drift. Two worktrees collide here only when
 * they already collide on the main port, so this adds no new collision class.
 */
export function deriveNestedTestPgPort(root: string): number {
  return DERIVED_NESTED_PORT_BASE + (deriveTestPgPort(root) - DERIVED_PORT_BASE);
}

/**
 * The nested port this run uses. `SP_TEST_NESTED_PG_PORT` wins; a malformed one
 * throws, on the same terms as the other two.
 *
 * It is deliberately derived from the WORKTREE, not from {@link CLUSTER_PORT}: an
 * outer run whose port was overridden must still not be shadowed by the nested
 * one, and deriving both from the same root keeps the two independent of whatever
 * the outer override happened to be. The one case that could still collide — an
 * outer override landing exactly on this worktree's nested port — is refused
 * below rather than left to chance.
 */
export function nestedClusterPort(): number {
  const override = process.env['SP_TEST_NESTED_PG_PORT'];
  if (override !== undefined && override.trim() !== '') {
    const parsed = Number.parseInt(override, 10);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      throw new Error(
        `SP_TEST_NESTED_PG_PORT is "${override}", which is not a port number between 1024 and 65535.`,
      );
    }
    return parsed;
  }
  const derived = deriveNestedTestPgPort(REPO_ROOT);
  /* Fail loudly rather than silently nesting a run onto its own parent's
   * cluster: that is precisely the destructive, silent failure E-1 was about.
   * Reachable only from a doubly-nested run — see the note above the export. */
  if (derived === CLUSTER_PORT) {
    throw new Error(
      `the nested cluster port (${String(derived)}) equals the outer cluster port. Set ` +
        'SP_TEST_NESTED_PG_PORT to a free port for this run.',
    );
  }
  return derived;
}

/* Deliberately a FUNCTION and not a module-level const.
 *
 * A const is evaluated on import, in every run — **including the nested one**,
 * which inherits `SP_TEST_PG_PORT` set to this very port. There, `CLUSTER_PORT`
 * legitimately equals the derived nested port, the guard below fired, globalSetup
 * threw, and the red case reported "the injected spec did not run" — the nested
 * run never got as far as failing on purpose.
 *
 * Computing it lazily means only the spawn site asks, so the guard keeps its
 * meaning (a DOUBLY nested run would still refuse to land on its parent) without
 * firing on the ordinary case it exists to protect. */

/**
 * Throwaway cluster data directory. Destroyed and recreated on every run.
 *
 * **The port is part of the path, and that is load-bearing.** A fixed path made
 * `SP_TEST_PG_PORT` a half-measure: a second harness on a different port still
 * `rm -rf`'d the first one's data directory on startup, and the first cluster
 * died mid-query with `could not open file "global/pg_filenode.map"`. The
 * exit-code red case spawns exactly that second harness, so the collision was
 * real rather than hypothetical — it is what `pnpm check` caught. Deriving the
 * directory from the port makes "a distinct port" mean a genuinely distinct
 * instance, which is what execution standards §E asks for.
 */
export const CLUSTER_DATA_DIR = resolve(API_ROOT, `.pgdata-test-${String(CLUSTER_PORT)}`);

export const CLUSTER_DATABASE = 'schedulepoint_test';

export const HARNESS_ENV: Readonly<Record<string, string>> = {
  SP_PG_HOST: '127.0.0.1',
  SP_PG_PORT: String(CLUSTER_PORT),
  SP_PG_DATABASE: CLUSTER_DATABASE,
  SP_PG_SUPERUSER: 'postgres',
  SP_PG_SUPERUSER_PASSWORD: 'fixture-local-superuser',
  SP_PG_PASSWORD_APP_MIGRATOR: 'fixture-local-migrator',
  SP_PG_PASSWORD_APP_RUNTIME: 'fixture-local-runtime',
  SP_PG_PASSWORD_APP_WORKER: 'fixture-local-worker',
  SP_PG_PASSWORD_APP_READONLY_SUPPORT: 'fixture-local-support',
  SP_PG_PASSWORD_APP_BREAKGLASS: 'fixture-local-breakglass',
};

export function applyHarnessEnv(): void {
  for (const [key, value] of Object.entries(HARNESS_ENV)) {
    process.env[key] = value;
  }
}
