import { CONTEXT_HEADER } from '@schedulepoint/contracts';
import type { PrincipalResolver } from '@schedulepoint/domain';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

import { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { InMemoryJobQueue } from '../../src/jobs/in-memory-queue.js';
import { buildServer } from '../../src/http/server.js';
import { createRuntime, type Runtime } from './harness.js';

/**
 * The HTTP harness.
 *
 * ## The principal resolver is test-only, and that is the whole point
 *
 * `src/http/context/principal.ts` ships **one** resolver and it denies
 * everything. There is deliberately no header-based resolver in `src/`, because
 * a "trust this header in development" principal is one misconfiguration away
 * from being an authentication bypass in production, and the mistake is
 * invisible in review.
 *
 * So the bypass lives here, in `test/support`, and reaches the server only
 * through `buildServer({ tenancy: { principals } })`. A production process
 * cannot enable it: there is no environment variable, no flag, and no code path
 * under `src/` that constructs it.
 * `apps/api/test/architecture/no-tenant-access-outside-unit-of-work.test.ts`,
 * describe block "no ambient tenant state (SPEC-01 §3.1)", asserts that stays true.
 */

export const TEST_PRINCIPAL_HEADER = 'x-test-principal';

interface TestPrincipalHeader {
  readonly userId: string;
  readonly sessionEpoch: number;
}

export const testPrincipalResolver: PrincipalResolver = {
  resolve: (request: unknown) => {
    const headers = (request as { headers?: Record<string, string | string[] | undefined> })
      .headers;
    const raw = headers?.[TEST_PRINCIPAL_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string' || value.length === 0) {
      return Promise.resolve({ authenticated: false, reason: 'no test principal header' });
    }
    const parsed = JSON.parse(value) as TestPrincipalHeader;
    return Promise.resolve({
      authenticated: true,
      principal: { userId: parsed.userId, sessionEpoch: parsed.sessionEpoch },
    });
  },
};

/**
 * A runner that can execute a hook **between** two units of work.
 *
 * This is how FAD-12's race is reproduced deterministically. A request runs two
 * transactions — the middleware's §2.3 resolution snapshot, then the handler's
 * command — and the interesting question is what happens when a privilege change
 * commits in the gap. Sleeping and hoping is not an answer; `beforeRun` fires at
 * a known point, so the interleaving is exact and the test cannot be flaky.
 *
 * It subclasses the production runner rather than replacing it, so everything
 * under test — the transaction boundary, the four `set_config` calls, the
 * read-back, the nesting rules — is the shipped code path.
 */
export class InterleavingRunner extends PgUnitOfWorkRunner {
  /** Called before each top-level `run`, with the 1-based call index. */
  beforeRun: ((callIndex: number) => Promise<void>) | undefined;
  #calls = 0;

  override async run<T>(
    context: Parameters<PgUnitOfWorkRunner['run']>[0],
    fn: Parameters<PgUnitOfWorkRunner['run']>[1],
  ): Promise<T> {
    // Only count and hook TOP-LEVEL runs; a nested run is a savepoint on the
    // transaction that is already open and has no gap to interleave into.
    if (this.current() === undefined) {
      this.#calls += 1;
      await this.beforeRun?.(this.#calls);
    }
    return super.run(context, fn) as Promise<T>;
  }

  resetCalls(): void {
    this.#calls = 0;
  }

  get calls(): number {
    return this.#calls;
  }
}

/** One structured log line the server emitted, parsed. */
export type CapturedLog = Record<string, unknown>;

export interface HttpHarness {
  readonly app: FastifyInstance;
  readonly runtime: Runtime;
  readonly runner: InterleavingRunner;
  readonly jobQueue: InMemoryJobQueue;
  /** Every structured log line the server wrote, oldest first. */
  readonly logs: readonly CapturedLog[];
  clearLogs(): void;
  close(): Promise<void>;
}

export async function buildHttpHarness(): Promise<HttpHarness> {
  const runtime = createRuntime('app_runtime', { max: 6 });
  const runner = new InterleavingRunner({
    role: 'app_runtime',
    pool: runtime.pool,
    alerts: runtime.alerts,
  });
  const jobQueue = new InMemoryJobQueue();

  // The log is captured rather than silenced because SPEC-01 §7.1 T-04 requires
  // a forged declaration to be "logged as a security event", and the only honest
  // way to assert that is to read what the server actually wrote.
  const logs: CapturedLog[] = [];
  const { app } = await buildServer({
    logger: {
      level: 'info',
      stream: {
        write(line: string): void {
          try {
            logs.push(JSON.parse(line) as CapturedLog);
          } catch {
            logs.push({ unparsed: line });
          }
        },
      },
    },
    tenancy: { runtime: runner, principals: testPrincipalResolver },
    jobQueue,
  });

  return {
    app,
    runtime,
    runner,
    jobQueue,
    logs,
    clearLogs: () => {
      logs.length = 0;
    },
    close: async () => {
      await app.close();
      await runtime.destroy();
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Declaring a context on the wire
 * ──────────────────────────────────────────────────────────────────────────── */

export interface DeclaredCounters {
  readonly organizationVersion: number;
  readonly groupVersion: number | null;
  readonly membershipSetVersion: number;
  readonly sessionEpoch: number;
}

export function principalHeader(userId: string, sessionEpoch: number): string {
  return JSON.stringify({ userId, sessionEpoch } satisfies TestPrincipalHeader);
}

export function contextHeaders(
  userId: string,
  counters: DeclaredCounters,
  correlationId?: string,
): Record<string, string> {
  return {
    [TEST_PRINCIPAL_HEADER]: principalHeader(userId, counters.sessionEpoch),
    [CONTEXT_HEADER]: JSON.stringify({
      contextVersion: {
        organizationVersion: counters.organizationVersion,
        groupVersion: counters.groupVersion,
        membershipSetVersion: counters.membershipSetVersion,
      },
      sessionEpoch: counters.sessionEpoch,
    }),
    ...(correlationId === undefined ? {} : { 'x-correlation-id': correlationId }),
  };
}

/**
 * Reads the CURRENT counters from ground truth, so a test declares a fresh
 * context by default and has to go out of its way to declare a stale one.
 *
 * The counters are read with the superuser precisely because the client is
 * supposed to have learnt them from a previous authorized response — the test is
 * standing in for that response, not for the server's own resolution.
 */
export async function currentCounters(
  admin: pg.Client,
  options: { organizationId: string; groupId: string | null; userId: string },
): Promise<DeclaredCounters> {
  const organization = await admin.query<{ organization_version: string }>(
    'select organization_version from organizations where id = $1',
    [options.organizationId],
  );
  const user = await admin.query<{ membership_set_version: string; session_epoch: string }>(
    'select membership_set_version, session_epoch from users where id = $1',
    [options.userId],
  );
  let groupVersion: number | null = null;
  if (options.groupId !== null) {
    const group = await admin.query<{ group_version: string }>(
      'select group_version from groups where id = $1',
      [options.groupId],
    );
    groupVersion = Number(group.rows[0]?.group_version ?? 0);
  }

  return {
    organizationVersion: Number(organization.rows[0]?.organization_version ?? 0),
    groupVersion,
    membershipSetVersion: Number(user.rows[0]?.membership_set_version ?? 0),
    sessionEpoch: Number(user.rows[0]?.session_epoch ?? 0),
  };
}

/** Reads a membership's `last_active_at` from ground truth. */
export async function lastActiveAt(admin: pg.Client, membershipId: string): Promise<Date | null> {
  const result = await admin.query<{ last_active_at: Date | null }>(
    'select last_active_at from memberships where id = $1',
    [membershipId],
  );
  return result.rows[0]?.last_active_at ?? null;
}
