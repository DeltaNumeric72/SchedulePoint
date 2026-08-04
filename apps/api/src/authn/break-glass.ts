import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import type pg from 'pg';

import { recordAuditEvent } from '../audit/recorder.js';
import type { PgUnitOfWorkRunner } from '../db/unit-of-work.js';
import type { RoleName } from '../db/roles.js';
import { systemClock, type Clock } from './clock.js';

/**
 * SPEC-11 §3.2 — **privileged access is itself audited**.
 *
 * > Every `app_readonly_support`, `app_breakglass`, and `app_migrator` session
 * > records operator identity, ticket reference, statements executed, and rows
 * > touched — written to the **same chained audit stream**, so hiding a
 * > privileged read requires breaking the chain.
 *
 * ## The four required facts, and where each comes from
 *
 * | Fact | Source |
 * |---|---|
 * | operator identity | the caller. There is no default and no anonymous variant |
 * | ticket reference | the caller. Also no default — an unticketed break-glass use is the thing this control exists to make visible |
 * | statements executed | `PgUnitOfWorkRunner.stats`, read before and after. Not a count the caller supplies |
 * | time | the audit row's own `occurred_at`, plus the elapsed milliseconds |
 *
 * Two audit rows, not one: `security.privileged_session.opened` is written
 * BEFORE the operator's work and commits with it, so a session that opens and
 * then crashes still left a trace; `security.privileged_session.closed` carries
 * the statement and row counts, which only exist afterwards.
 *
 * ## Detecting an UNAUDITED use, which is the harder half
 *
 * An auditor that only records the accesses made through itself proves nothing
 * about the ones made around it. The detector below asks PostgreSQL instead:
 * every privileged unit of work opened here sets `application_name` to
 * `sp-privileged:<sessionId>` (transaction-locally, via `set_config(..., true)`
 * — the tenant-context rule's spelling, applied to a non-tenant setting), so a
 * backend connected as a privileged role WITHOUT that marker is a use that this
 * module never saw.
 *
 * `detectUnauditedPrivilegedBackends` reads `pg_stat_activity` and returns
 * exactly those. It is what
 * `apps/api/test/authn/break-glass.test.ts` uses for its red case: a raw
 * break-glass connection is held open, the detector runs, and it reports the
 * backend. Deleting the auditor's marker makes the detector report the audited
 * session too, which is the falsifiability check.
 *
 * **The honest limit, stated rather than implied:** `pg_stat_activity` is live
 * state, so the detector catches an unaudited session while it is CONNECTED, not
 * one that has already disconnected. Catching the second requires the cluster's
 * own connection logging, which is a deployment condition (`log_connections`),
 * not something an application can assert. It is recorded in
 * `docs/evidence/EV-M3-AUTHN/INDEX.md` as a residual rather than closed here.
 */

/** The roles SPEC-11 §3.2 names. */
export const PRIVILEGED_ROLES: readonly RoleName[] = [
  'app_readonly_support',
  'app_breakglass',
  'app_migrator',
];

/** The `application_name` prefix an audited privileged unit of work carries. */
export const PRIVILEGED_MARKER_PREFIX = 'sp-privileged:';

export interface PrivilegedSessionRequest {
  /** Who. No default: an anonymous break-glass use is what this control exists to prevent. */
  readonly operator: string;
  /** Why. No default, for the same reason. */
  readonly ticketRef: string;
  /** What they are entitled to touch, as a closed token — never prose. */
  readonly scope: string;
  readonly organizationId: string;
}

export interface PrivilegedSessionRecord {
  readonly sessionId: string;
  readonly statements: number;
  readonly elapsedMs: number;
}

/**
 * A closed vocabulary for `operator`, `ticketRef` and `scope`.
 *
 * The audit payload validator would reject prose anyway (I-07: printable ASCII,
 * no spaces, ≤64 characters), but failing at the audit write means the operator's
 * work has already happened. Checking here means an unusable value is refused
 * before anything privileged runs.
 */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export class PrivilegedSessionAuditor {
  readonly #runner: PgUnitOfWorkRunner;
  readonly #role: RoleName;
  readonly #clock: Clock;

  constructor(options: { runner: PgUnitOfWorkRunner; role: RoleName; clock?: Clock }) {
    if (!PRIVILEGED_ROLES.includes(options.role)) {
      throw new Error(
        `PrivilegedSessionAuditor is for the roles SPEC-11 §3.2 names (${PRIVILEGED_ROLES.join(
          ', ',
        )}); ${options.role} is not one of them`,
      );
    }
    this.#runner = options.runner;
    this.#role = options.role;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Runs privileged work inside an audited unit of work.
   *
   * The two audit rows are written in the SAME transaction as the operator's
   * statements, so a rollback takes the evidence with it — which is correct: a
   * rolled-back privileged transaction touched nothing, and recording that it
   * did would be a false positive in the one log an incident review trusts.
   */
  async run<T>(
    request: PrivilegedSessionRequest,
    work: (uow: Parameters<Parameters<PgUnitOfWorkRunner['run']>[1]>[0]) => Promise<T>,
  ): Promise<{ readonly result: T; readonly record: PrivilegedSessionRecord }> {
    for (const [field, value] of [
      ['operator', request.operator],
      ['ticketRef', request.ticketRef],
      ['scope', request.scope],
    ] as const) {
      if (!TOKEN.test(value)) {
        throw new Error(
          `PRIVILEGED_SESSION_${field.toUpperCase()}_MALFORMED: "${value}" is not a closed token. ` +
            'SPEC-11 §3.2 requires an operator identity and a ticket reference; I-07 requires ' +
            'them to be identifiers rather than prose.',
        );
      }
    }

    const sessionId = randomUUID();
    const startedAt = this.#clock.now();
    const before = this.#runner.stats.statements;

    const result = await this.#runner.run(
      {
        organizationId: request.organizationId,
        groupId: null,
        membershipId: null,
        // `^[A-Za-z0-9_-]{1,64}$` (migration 0003): a colon here would fail the
        // audit insert's CHECK, so the marker uses a hyphen. The
        // `application_name` marker keeps its colon — that value is not a
        // correlation id and `pg_stat_activity` has no such constraint.
        correlationId: `privileged-${sessionId}`,
      },
      async (uow) => {
        // The marker the detector looks for. Transaction-local, and set with
        // `set_config(name, value, true)` — the only permitted spelling in this
        // repository, applied here to a non-tenant setting for the same reason
        // it is required for tenant ones: a session-scoped value would survive
        // into the next borrower of a pooled connection and mark somebody
        // else's work as this session's.
        await sql`select set_config('application_name', ${
          PRIVILEGED_MARKER_PREFIX + sessionId
        }, true)`.execute(uow.query);

        await recordAuditEvent(uow, {
          eventName: 'security.privileged_session.opened',
          subjectType: 'privileged_session',
          subjectId: sessionId,
          payload: {
            role: this.#role,
            operator: request.operator,
            ticketRef: request.ticketRef,
            scope: request.scope,
          },
          systemActor: true,
        });

        const value = await work(uow);

        await recordAuditEvent(uow, {
          eventName: 'security.privileged_session.closed',
          subjectType: 'privileged_session',
          subjectId: sessionId,
          payload: {
            role: this.#role,
            operator: request.operator,
            ticketRef: request.ticketRef,
            // Read from the runner, not supplied by the caller: a count the
            // operator provides is a count the operator chooses.
            statements: this.#runner.stats.statements - before,
            elapsedMs: this.#clock.now().getTime() - startedAt.getTime(),
          },
          systemActor: true,
        });

        return value;
      },
    );

    return {
      result,
      record: {
        sessionId,
        statements: this.#runner.stats.statements - before,
        elapsedMs: this.#clock.now().getTime() - startedAt.getTime(),
      },
    };
  }
}

export interface UnauditedBackend {
  readonly pid: number;
  readonly role: string;
  readonly applicationName: string;
  readonly state: string | null;
}

/**
 * Backends connected as a privileged role WITHOUT an audited-session marker.
 *
 * Non-empty means somebody reached the database as `app_breakglass`,
 * `app_readonly_support` or `app_migrator` without going through
 * `PrivilegedSessionAuditor` — which is precisely the "unaudited use" SPEC-11
 * §3.2 requires to be detectable.
 *
 * Read with an out-of-band client (the superuser), because a privileged role
 * reading `pg_stat_activity` sees only its own rows unless it holds
 * `pg_read_all_stats` — and granting that to the role being watched would be a
 * watchdog the subject controls.
 */
export async function detectUnauditedPrivilegedBackends(
  admin: pg.Client,
  options: { readonly roles?: readonly string[] } = {},
): Promise<UnauditedBackend[]> {
  const roles = options.roles ?? PRIVILEGED_ROLES;
  const result = await admin.query<{
    pid: number;
    usename: string;
    application_name: string;
    state: string | null;
  }>(
    `select pid, usename, application_name, state
       from pg_stat_activity
      where usename = any($1::text[])
        and pid <> pg_backend_pid()
        and (application_name is null or application_name not like $2)`,
    [roles, `${PRIVILEGED_MARKER_PREFIX}%`],
  );
  return result.rows.map((row) => ({
    pid: row.pid,
    role: row.usename,
    applicationName: row.application_name,
    state: row.state,
  }));
}
