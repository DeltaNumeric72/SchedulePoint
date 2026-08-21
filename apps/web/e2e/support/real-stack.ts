import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The real-stack harness's shared vocabulary — ports, paths, and the handshake.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Why the ports are DERIVED, not fixed
 *
 * The same reason `playwright.config.ts`'s preview port is and the same reason
 * `apps/api/test/support/env.ts`'s cluster port is: a fixed default that nobody
 * overrides is not a control. Two worktrees running this at once on fixed ports
 * would destroy each other's cluster, and the symptom (E-1) is whole files
 * failing with zero test failures — an hour of debugging the wrong thing.
 *
 * Three ports are derived from the worktree path, in bands that cannot overlap
 * anything already in use:
 *
 * | Port | Band | What it is |
 * | --- | --- | --- |
 * | PostgreSQL | `55900..56299` | the real stack's OWN cluster — deliberately not the Vitest one, so a real-stack run and a unit run can coexist |
 * | API | `42200..42599` | `apps/api/src/index.ts`, the production entry point |
 * | origin | `42600..42999` | the static+proxy origin the browser talks to |
 *
 * `SP_REAL_STACK_PG_PORT`, `SP_REAL_STACK_API_PORT` and `SP_REAL_STACK_PORT`
 * still win, and a malformed value throws rather than falling back.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** `apps/web` */
export const WEB_ROOT = resolve(HERE, '../..');
/** The worktree root. */
export const REPO_ROOT = resolve(WEB_ROOT, '../..');
/** The production bundle the browser is served. */
export const WEB_DIST = resolve(WEB_ROOT, 'dist');
/** Where the daemon's handshake is written. `test-results/` is git-ignored. */
export const HANDSHAKE_PATH = resolve(WEB_ROOT, 'test-results/real-stack.json');

function derive(namespace: string, base: number, span: number): number {
  const digest = createHash('sha256').update(`${namespace}\x00${REPO_ROOT}`).digest('hex');
  return base + (Number.parseInt(digest.slice(0, 8), 16) % span);
}

function port(variable: string, namespace: string, base: number, span: number): number {
  const override = process.env[variable];
  if (override === undefined || override.trim() === '') return derive(namespace, base, span);
  const parsed = Number.parseInt(override, 10);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(`${variable} is "${override}", which is not a port between 1024 and 65535.`);
  }
  return parsed;
}

export const REAL_STACK_PG_PORT = port(
  'SP_REAL_STACK_PG_PORT',
  'sp.real-stack.pg.port.v1',
  55900,
  400,
);
export const REAL_STACK_API_PORT = port(
  'SP_REAL_STACK_API_PORT',
  'sp.real-stack.api.port.v1',
  42200,
  400,
);
export const REAL_STACK_PORT = port('SP_REAL_STACK_PORT', 'sp.real-stack.port.v1', 42600, 400);
export const REAL_STACK_ORIGIN = `http://127.0.0.1:${String(REAL_STACK_PORT)}`;

/**
 * Whether the real stack is available to this run.
 *
 * `critical-path.spec.ts` lives in the same directory as the ten intercepting
 * specs and is therefore collected by the DEFAULT Playwright config too. It
 * declares its precondition rather than assuming it: under the default config
 * the handshake does not exist and the spec skips, saying so. That is not a
 * weakened test — it is a test refusing to claim anything without the stack it
 * is about.
 *
 * **Who SETS it (FAD-50 C-3).** `e2e/support/real-stack-setup.ts`, after the
 * daemon reports READY and the origin is listening — so the variable means "the
 * stack is up" rather than "somebody meant to run it". Nothing set it at all
 * until that repair, which made the real-stack suite pass with `2 skipped`; the
 * skip path below was therefore the ONLY path, and this docblock described a
 * fork that had one branch.
 */
export function realStackAvailable(): boolean {
  return process.env['SP_REAL_STACK'] === '1';
}

/** Everything the daemon provisioned, as it reported it. */
export interface RealStackHandshake {
  readonly apiPort: number;
  readonly organizationId: string;
  readonly groupId: string;
  readonly groupTwoId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly loginEmail: string;
  readonly password: string;
  readonly recoveryCodes: readonly string[];
  readonly shiftTypeIds: readonly string[];
  readonly qualificationId: string;
  readonly solverCommand: string | null;
}

export function readHandshake(): RealStackHandshake {
  return JSON.parse(readFileSync(HANDSHAKE_PATH, 'utf8')) as RealStackHandshake;
}
