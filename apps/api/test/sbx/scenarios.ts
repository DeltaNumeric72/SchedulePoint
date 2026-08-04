import { randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import type pg from 'pg';

import { CONTEXT_HEADER } from '@schedulepoint/contracts';

import { preAuthRouteConfig } from '../../src/http/policy.js';
import { undeclaredRoutes, type RouteTableEntry } from '../../src/http/route-table.js';
import { TENANT_TABLES, type Database } from '../../src/db/schema.js';
import type { RoleName } from '../../src/db/roles.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { contextHeaders, currentCounters, type DeclaredCounters, type HttpHarness } from '../support/http.js';
import { NONEXISTENT_ID } from '../support/fixtures.js';
import type { MultiFixture } from '../support/multi.js';
import { ControllableClock } from '../../src/authn/clock.js';
import { AuthnError } from '../../src/authn/errors.js';
import { AuthnService } from '../../src/authn/service.js';
import * as authnStore from '../../src/authn/store.js';
import { SESSION_COOKIE_NAME, encodeSessionCookie } from '../../src/authn/tokens.js';
import { FIXTURE_PASSWORD, FIXTURE_SCRYPT, fixtureSecretBox } from '../support/authn.js';
import { ProbeFalsified, type SbxScenario } from './contract.js';

/** The instant every clock-driven SBX arm starts at. Fixed, UTC, locale-free. */
const SBX_EPOCH = new Date('2026-04-01T08:00:00.000Z');
/**
 * The one password every authn SBX arm activates and signs in with.
 *
 * It is `FIXTURE_PASSWORD` deliberately, not a second value: SBX-001 activates
 * the role-holders (for its real-session matrix) and SBX-005/006 later sign the
 * SAME accounts in. One password across all three is what makes those helpers
 * idempotent — whichever arm activates an account first, the others just sign in
 * — rather than fighting over its credential.
 */
const SBX_PASSWORD = FIXTURE_PASSWORD;

/**
 * An `AuthnService` on an injected clock.
 *
 * The clock is a CONSTRUCTOR parameter and there is no other way in — see
 * `apps/api/src/authn/clock.ts` for why that shape was chosen over a settable
 * module-level clock or an environment switch.
 */
function sbxAuthn(clock: ControllableClock): AuthnService {
  return new AuthnService({
    clock,
    scrypt: FIXTURE_SCRYPT,
    secretBox: fixtureSecretBox(),
    totpIssuer: 'SchedulePoint-SBX',
  });
}

/** Rolls a probe's perturbation back without reporting a failure. */
class SbxProbeRollback extends Error {
  constructor() {
    super('sbx probe rollback');
    this.name = 'SbxProbeRollback';
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The G-ARCH tenancy subset, against the M1 kernel.
 *
 * SBX-001 · role x registered-surface matrix over MULTI
 * SBX-002 · the capability mapping: grant x entitlement x role, server-side
 * SBX-004 · the full cross-tenant sweep
 * SBX-005 · account lifecycle — partly executable, partly EVIDENCE_BLOCKED
 * SBX-006 · session lifetime — entirely EVIDENCE_BLOCKED
 *
 * **G-ARCH is not closed by this subset.** It also needs SBX-011, 013, 014b,
 * 022, 023 and 028 at later milestones. This clears the tenancy part and files
 * the evidence.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ScenarioDependencies {
  readonly fixture: MultiFixture;
  readonly admin: pg.Client;
  readonly runtimes: ReadonlyMap<RoleName, Runtime>;
  /** The routes the server ACTUALLY registered, via buildServer's onRoute hook. */
  readonly routeTable: readonly RouteTableEntry[];
  /** The real HTTP surface, for the arms that must go through it rather than round it. */
  readonly http: HttpHarness;
}

/** Which column carries the tenant, per `TENANT_TABLES` scope. */
function tenantColumn(scope: string): string {
  return scope === 'organization-identity' ? 'id' : 'organization_id';
}

interface ProbeReading {
  readonly role: RoleName;
  readonly context: string;
  readonly table: string;
  readonly wrong: number;
  readonly visible: number;
  /**
   * Set when the read was REFUSED outright rather than returning rows.
   *
   * Some roles hold no EXECUTE on the helper functions an RLS policy calls, so
   * the read raises 42501 instead of returning zero rows. That is a STRONGER
   * isolation result than "saw nothing", and it is recorded distinctly: rolling
   * it into `visible = 0` would hide which mechanism did the work, and letting it
   * throw would abort a sweep over a role that is in fact more locked down.
   */
  readonly refused?: string;
}

async function probeUnder(
  runtime: Runtime,
  contextLabel: string,
  context: { organizationId: string; groupId: string | null; membershipId: string | null },
  ownOrganizationId: string,
): Promise<ProbeReading[]> {
  const readings: ProbeReading[] = [];

  for (const table of TENANT_TABLES) {
    // `users` is global by PO-DEC-06 and reached through a membership, so
    // "wrong tenant" is not a column comparison for it. It gets its own probe.
    if (table.scope === 'through-membership') continue;

    /* ── ONE TRANSACTION PER TABLE, and this is load-bearing ───────────────
     * The first version swept all thirteen tables inside ONE unit of work with
     * a per-table try/catch. The independent review showed what that produced:
     * the first GENUINE refusal (42501 on capability_grants for
     * app_readonly_support) aborts the transaction, so every later table
     * returns 25P02 "current transaction is aborted" — and each was recorded as
     * a refusal with `wrong: 0`. Six of seven refusals therefore carried a FALSE
     * CAUSE, that role's sweep really covered 5 of 12 tables, and — the part
     * that matters — a genuine leak on any table after the first refusal would
     * have been recorded as `wrong: 0` and passed.
     *
     * A fresh transaction per table makes the cascade impossible by
     * construction rather than by care, and `assertNoCascade` below fails the
     * run if 25P02 is ever observed again.
     * ──────────────────────────────────────────────────────────────────── */
    try {
      const reading = await runtime.runner.run(
        { ...context, correlationId: `sbx-004-${contextLabel}` },
        async (uow) => {
          // Identifiers cannot be bind parameters. Both come from
          // `TENANT_TABLES`, the closed registry in `src/db/schema.ts`.
          const { rows } = await sql<{ wrong: number; visible: number }>`
            select count(*) filter (
                     where ${sql.raw(tenantColumn(table.scope))} is distinct from ${ownOrganizationId}::uuid
                   )::int as wrong,
                   count(*)::int as visible
              from ${sql.raw(table.name)}
          `.execute(uow.query);
          return {
            wrong: Number(rows[0]?.wrong ?? 0),
            visible: Number(rows[0]?.visible ?? 0),
          };
        },
      );
      readings.push({
        role: runtime.role,
        context: contextLabel,
        table: table.name,
        wrong: reading.wrong,
        visible: reading.visible,
      });
    } catch (error) {
      readings.push({
        role: runtime.role,
        context: contextLabel,
        table: table.name,
        wrong: 0,
        visible: 0,
        refused: (error as { code?: string }).code ?? 'error',
      });
    }
  }

  return readings;
}

/**
 * Every (role, table) pair must be EXACTLY ONE of: a reading with row counts, or
 * a genuine refusal carrying its own SQLSTATE. `25P02` — "current transaction is
 * aborted" — is neither: it means an earlier statement's failure cascaded, so the
 * reading describes the harness rather than the system. It is a HARNESS DEFECT
 * and fails the run.
 */
export const ACCEPTABLE_REFUSAL_CODES: ReadonlySet<string> = new Set(['42501']);

export function assertNoCascade(readings: readonly ProbeReading[]): void {
  // A WHITELIST, not a blacklist. The first version blacklisted 25P02 alone, and
  // the reviewer injected 08006 (connection failure): three readings silently
  // became wrong: 0 carrying a false grant-cause in the artifact. Any refusal
  // that is not an insufficient-privilege denial is a harness fault — the read
  // did not happen, so the reading describes the harness rather than the system.
  const unexpected = readings.filter(
    (reading) => reading.refused !== undefined && !ACCEPTABLE_REFUSAL_CODES.has(reading.refused),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `HARNESS DEFECT: ${String(unexpected.length)} reading(s) were refused with a code that is ` +
        'not an insufficient-privilege denial, so the read never happened and any leak they ' +
        'might have seen is invisible. Only 42501 is an acceptable refusal: ' +
        unexpected.map((r) => `${r.role}/${r.context}/${r.table}=${String(r.refused)}`).join(', '),
    );
  }
  for (const reading of readings) {
    const hasCounts = reading.refused === undefined;
    const hasRefusal = reading.refused !== undefined && reading.refused.length > 0;
    if (hasCounts === hasRefusal) {
      throw new Error(
        `HARNESS DEFECT: ${reading.role}/${reading.table} is neither a clean reading nor a ` +
          'genuine refusal',
      );
    }
  }
}

/**
 * SBX-005's oracle: every membership status the fixture is supposed to retain is
 * actually present. Extracted for the same reason as SBX-002's (D-02).
 */
function statusRetentionOracle(
  rows: readonly { status: string; n: string }[],
): Map<string, number> {
  const byStatus = new Map(rows.map((row) => [row.status, Number(row.n)]));
  for (const status of ['active', 'suspended', 'invited', 'ended']) {
    if ((byStatus.get(status) ?? 0) === 0) {
      throw new Error(`no membership in status ${status} — the retention claim is vacuous`);
    }
  }
  return byStatus;
}

/**
 * SBX-002's oracle, extracted so its PROBE can re-execute exactly what ships.
 */
async function entitlementArmsOracle(
  admin: pg.Client,
  fixture: MultiFixture,
): Promise<{ alphaModules: Set<string>; gammaModules: Set<string> }> {
  const gamma = fixture.gamma;
  if (gamma === undefined) throw new Error('the full profile did not provision Gamma');
  const alphaRows = await admin.query<{ module_key: string; state: string }>(
    'select module_key, state from entitlements where organization_id = $1::uuid',
    [fixture.alpha.organizationId],
  );
  const gammaRows = await admin.query<{ module_key: string }>(
    'select module_key from entitlements where organization_id = $1::uuid',
    [gamma.organizationId],
  );
  const alphaCore = alphaRows.rows.find((row) => row.module_key === 'core_scheduling');
  if (alphaCore === undefined) throw new Error('Alpha has no core_scheduling row — the ON arm is missing');
  if (alphaCore.state !== 'active' && alphaCore.state !== 'trial') {
    throw new Error(`Alpha's core_scheduling is ${alphaCore.state} — the ON arm is not ON`);
  }
  const gammaModules = new Set(gammaRows.rows.map((row) => row.module_key));
  if (gammaModules.has('core_scheduling')) throw new Error('Gamma IS entitled — the OFF arm is missing');
  return { alphaModules: new Set(alphaRows.rows.map((row) => row.module_key)), gammaModules };
}

export function buildScenarios(deps: () => ScenarioDependencies): readonly SbxScenario[] {
  const sbx004: SbxScenario = {
    id: 'SBX-004',
    title: 'Cross-tenant isolation sweep — every resource type, both boundaries, every role',
    // G-ARCH depends on this evidence, so EVIDENCE_BLOCKED here would be a failed
    // run rather than an acceptable resting state.
    gateRequired: true,
    contract: {
      owner: 'OPUS-M2-001 (implementer) / Fable (acceptance)',
      fixtureProvenance:
        'MULTI `full` profile, provisioned by apps/api/test/support/multi.ts from a slug — the ' +
        'single fixture owner. Synthetic throughout; every address at example.invalid. ' +
        'Reproducible from the slug alone (proved in apps/api/test/fixture/multi.test.ts).',
      deterministicSetup:
        'One embedded PostgreSQL cluster per run, initialised from empty; migrations up -> down ' +
        '-> up; the fixture seeded through the unit of work. No wall-clock dependence and no ' +
        'concurrency: each read arm issues one statement PER TABLE (13) inside a single unit of ' +
        'work per (role, context), and each write attempt is one statement in its own ' +
        'always-rolled-back transaction. Nothing runs in parallel, so no result depends on ' +
        'interleaving.',
      externalDependency: 'None. Nothing outside this process and its local cluster.',
      faultControls:
        'None injected. This scenario measures the steady state; SPEC-01 T-07..T-15 inject the ' +
        'faults and are asserted separately in apps/api/test/tenancy/unit-of-work.test.ts.',
      objectiveOracle:
        'wrong-tenant row count == 0 on EVERY (role, context, table) reading, AND every tenant ' +
        'table observed with at least one VISIBLE row in at least one reading — a probe over a ' +
        'table it cannot see reports 0 wrong for the boring reason.',
      retainedArtifact: 'docs/evidence/EV-M2-SBX/sbx-004-sweep.txt',
      environment: 'MULTI',
      earliestExecutionPoint: 'E0',
    },
    run: async (context) => {
      const { fixture, runtimes, admin } = deps();
      const runtime = runtimes.get('app_runtime');
      const worker = runtimes.get('app_worker');
      if (runtime === undefined || worker === undefined) throw new Error('runtimes missing');

      const alpha = fixture.alpha;
      const readings: ProbeReading[] = [];

      // ORGANIZATION boundary and GROUP boundary, under both RLS-bound roles that
      // hold read grants. Both roles are needed for full coverage: audit_checkpoints
      // and outbox_effects are app_worker's alone (0003's grants, SPEC-11 §2), so an
      // app_runtime-only sweep reports 0 visible for them — which is exactly the
      // vacuous reading this oracle forbids.
      readings.push(
        ...(await probeUnder(
          runtime,
          'runtime/organization',
          { organizationId: alpha.organizationId, groupId: null, membershipId: alpha.users.organizationAdmin.membershipId },
          alpha.organizationId,
        )),
      );
      readings.push(
        ...(await probeUnder(
          runtime,
          'runtime/group-one',
          {
            organizationId: alpha.organizationId,
            groupId: alpha.groupOne.id,
            membershipId: alpha.users.scheduler.membershipId,
          },
          alpha.organizationId,
        )),
      );
      readings.push(
        ...(await probeUnder(
          worker,
          'worker/organization',
          { organizationId: alpha.organizationId, groupId: null, membershipId: null },
          alpha.organizationId,
        )),
      );
      readings.push(
        ...(await probeUnder(
          worker,
          'worker/group-one',
          { organizationId: alpha.organizationId, groupId: alpha.groupOne.id, membershipId: null },
          alpha.organizationId,
        )),
      );
      // The other side of the ORGANIZATION boundary: Beta's own context must see
      // Beta and nothing of Alpha. A one-sided sweep proves half the boundary.
      readings.push(
        ...(await probeUnder(
          runtime,
          'runtime/beta-organization',
          {
            organizationId: fixture.beta.organizationId,
            groupId: null,
            membershipId: fixture.beta.users.organizationAdmin.membershipId,
          },
          fixture.beta.organizationId,
        )),
      );

      // R-03 — the remaining three application roles, so the sweep covers all
      // five. `app_breakglass` is the DECLARED exception and is handled below.
      for (const role of ['app_migrator', 'app_readonly_support'] as const) {
        const bound = runtimes.get(role);
        if (bound === undefined) throw new Error(`${role} runtime missing`);
        readings.push(
          ...(await probeUnder(
            bound,
            `${role}/organization`,
            { organizationId: alpha.organizationId, groupId: null, membershipId: null },
            alpha.organizationId,
          )),
        );
      }

      /* ── the FAD-14 maintenance-plane read, pinned rather than omitted ───
       * Extending the sweep to all five roles immediately surfaced ONE
       * cross-tenant read: `app_migrator` sees every organization's
       * `audit_checkpoints`. That is not a leak — it is FAD-14's sanctioned
       * maintenance-plane exception, the alternative to giving the worker
       * BYPASSRLS: two `FOR SELECT TO app_migrator` policies, SELECT-only, no
       * tenant content beyond organization ids (EV-M1-AUDIT §5 #16).
       *
       * It is asserted POSITIVELY here — it must be present and non-vacuous —
       * and excluded from the leak check by an exact (role, table) pair rather
       * than by a role-wide or table-wide waiver. A waiver any wider would let a
       * genuine second path hide behind the sanctioned one, which is the whole
       * risk of having an exception at all.
       * ──────────────────────────────────────────────────────────────────── */
      const isMaintenancePlane = (reading: ProbeReading): boolean =>
        reading.role === 'app_migrator' && reading.table === 'audit_checkpoints';

      // D-05: scoped to THIS fixture's organizations. The raw reading counts
      // every checkpoint in the cluster, so it varied (17 vs 6) with whatever
      // other fixtures shared the process — which made the committed artifact
      // irreproducible. What the claim needs is "app_migrator sees checkpoints
      // belonging to organizations other than the one it declared", and that is
      // answerable within this fixture.
      const scopedMaintenance = await admin.query<{ n: string }>(
        `select count(*)::text as n from audit_checkpoints
          where organization_id = any($1::uuid[]) and organization_id <> $2::uuid`,
        [fixture.organizationIds, alpha.organizationId],
      );
      const maintenanceCrossTenant = Number(scopedMaintenance.rows[0]?.n ?? '0');
      if (maintenanceCrossTenant === 0) {
        throw new Error(
          'the FAD-14 maintenance-plane read saw NO foreign checkpoints — either the exception ' +
            'has been removed (in which case this assertion is stale) or this probe is vacuous',
        );
      }
      context.policyExercised('FAD-14 maintenance-plane read (app_migrator, SELECT-only)');
      context.observe(
        'declared exception (FAD-14), pinned',
        `app_migrator reads ${String(maintenanceCrossTenant)} foreign audit_checkpoints rows ` +
          "belonging to THIS fixture's other organizations (scoped, so the number does not " +
          'depend on what else shares the run) — ' +
          'the sanctioned maintenance-plane path, SELECT-only, no tenant content beyond ' +
          'organization ids. Excluded from the leak check by the exact (role, table) pair only; ' +
          'every OTHER pair, including app_migrator on all twelve remaining tables, must read 0.',
      );

      // Cascade check FIRST: a false cause would make every number below suspect.
      assertNoCascade(readings);

      const wrong = readings.filter((reading) => reading.wrong > 0 && !isMaintenancePlane(reading));
      if (wrong.length > 0) {
        throw new Error(
          `CROSS-TENANT ROWS VISIBLE: ${wrong
            .map((r) => `${r.role}/${r.context}/${r.table}=${String(r.wrong)}`)
            .join(', ')}`,
        );
      }

      // Non-vacuity: every tenant table must have been SEEN somewhere.
      const seen = new Set(readings.filter((r) => r.visible > 0).map((r) => r.table));
      const expected = TENANT_TABLES.filter((t) => t.scope !== 'through-membership').map((t) => t.name);
      const unseen = expected.filter((name) => !seen.has(name));
      if (unseen.length > 0) {
        throw new Error(
          `VACUOUS PROBE: no reading ever saw a row in ${unseen.join(', ')} — "0 wrong" there ` +
            'means nothing',
        );
      }
      for (const name of expected) context.tableExercised(name);
      context.policyExercised('RLS row-level policies on every tenant table');

      // `users` — the through-membership table, probed on its own terms: an Alpha
      // context must not see a user reachable only through a Beta membership.
      const betaOnly = fixture.beta.users.scheduler.id;
      const leaked = await runtime.runner.run(
        {
          organizationId: alpha.organizationId,
          groupId: null,
          membershipId: alpha.users.organizationAdmin.membershipId,
          correlationId: 'sbx-004-users',
        },
        async ({ query }) =>
          query.selectFrom('users').select('id').where('id', '=', betaOnly).execute(),
      );
      if (leaked.length > 0) throw new Error('a Beta-only user was visible under an Alpha context');
      context.tableExercised('users');
      context.policyExercised('users_readable_through_membership');

      /* ── the API-SURFACE arm ────────────────────────────────────────────
       * The SQL arm above proves RLS refuses a foreign row to a role. It does
       * not prove the HTTP surface refuses a foreign IDENTIFIER, which is the
       * attack an authenticated user of another organization actually has. So
       * every registered route that names an :organizationId is attempted with
       * ALPHA's identifier while authenticated as BETA's administrator.
       *
       * Pass is 100% denial AND no distinction between "not permitted" and "not
       * found": the response to a foreign-but-real organization must be
       * BYTE-IDENTICAL to the response to one that does not exist.
       * ──────────────────────────────────────────────────────────────────── */
      const { http, routeTable } = deps();
      const beta = fixture.beta;
      const attempts: string[] = [];
      let denied = 0;
      let preAuthRoutes = 0;

      const routed = routeTable.filter(
        (entry) => entry.method !== 'HEAD' && entry.url.includes(':organizationId'),
      );
      if (routed.length === 0) throw new Error('no organization-scoped routes registered');

      const counters = await currentCounters(admin, {
        organizationId: beta.organizationId,
        groupId: null,
        userId: beta.users.organizationAdmin.id,
      });

      for (const entry of routed) {
        const foreign = entry.url
          .replace(':organizationId', alpha.organizationId)
          .replace(':groupId', alpha.groupOne.id)
          .replace(':membershipId', alpha.users.scheduler.membershipId)
          .replace(':targetMembershipId', alpha.users.groupTwoScheduler.membershipId)
          .replace(':moduleKey', 'core_scheduling');
        const absent = entry.url
          .replace(':organizationId', NONEXISTENT_ID)
          .replace(':groupId', NONEXISTENT_ID)
          .replace(':membershipId', NONEXISTENT_ID)
          .replace(':targetMembershipId', NONEXISTENT_ID)
          .replace(':moduleKey', 'core_scheduling');

        const headers = contextHeaders(
          beta.users.organizationAdmin.id,
          counters,
          'sbx004apisurface',
        );
        const request = (url: string) =>
          http.app.inject({ method: entry.method as 'POST', url, headers, payload: {} });

        const [foreignResponse, absentResponse] = await Promise.all([
          request(foreign),
          request(absent),
        ]);

        /* ── the pre-auth class (OPUS-M3-001) ────────────────────────────
         *
         * A `preauth/anonymous` route deliberately answers the SAME thing to
         * everybody — `POST …/authn/password-reset` acknowledges every request,
         * because a 4xx for an unknown address is an account-enumeration
         * oracle (14 §2). So "must be >= 400" is the wrong oracle for it, and
         * relaxing the check for the whole class would be worse.
         *
         * The requirement applied instead is STRICTLY STRONGER for these
         * routes: the response to a FOREIGN organization must be byte-identical
         * to the response to one that DOES NOT EXIST (already checked below),
         * **and** the body must contain no identifier belonging to the foreign
         * tenant. A 2xx that discloses nothing crosses no boundary; a 2xx that
         * named an Alpha row would fail here whatever its status code was.
         */
        const preAuth = preAuthRouteConfig(entry.config);
        if (preAuth === undefined && foreignResponse.statusCode < 400) {
          throw new Error(
            `CROSS-TENANT ACCESS ALLOWED: ${entry.method} ${foreign} answered ` +
              `${String(foreignResponse.statusCode)} to a BETA principal`,
          );
        }
        if (preAuth !== undefined) {
          const leaked = [
            alpha.organizationId,
            alpha.groupOne.id,
            alpha.users.scheduler.id,
            alpha.users.scheduler.membershipId,
            alpha.users.member.id,
          ].filter((identifier) => foreignResponse.body.includes(identifier));
          if (leaked.length > 0) {
            throw new Error(
              `CROSS-TENANT DISCLOSURE: preauth route ${entry.method} ${entry.url} echoed ` +
                `Alpha identifier(s) ${leaked.join(', ')} to a BETA principal`,
            );
          }
          preAuthRoutes += 1;
        }
        if (foreignResponse.statusCode !== absentResponse.statusCode) {
          throw new Error(
            `DISCLOSURE: ${entry.method} ${entry.url} answers ` +
              `${String(foreignResponse.statusCode)} for a foreign organization and ` +
              `${String(absentResponse.statusCode)} for one that does not exist — the pair ` +
              'distinguishes "not permitted" from "not found"',
          );
        }
        if (foreignResponse.body !== absentResponse.body) {
          throw new Error(
            `DISCLOSURE: ${entry.method} ${entry.url} bodies differ between a foreign ` +
              'organization and a non-existent one',
          );
        }
        denied += 1;
        attempts.push(`${entry.method} ${entry.url} -> ${String(foreignResponse.statusCode)}`);
      }

      context.policyExercised('HTTP surface cross-organization denial (SPEC-01 §2.4 byte-identity)');
      context.observe(
        'API-surface arm',
        `${String(denied)}/${String(routed.length)} organization-scoped routes answered a ` +
          'foreign organization id byte-identically to a non-existent one for an authenticated ' +
          `BETA principal (${String(preAuthRoutes)} of them are preauth routes, held to the ` +
          'stronger no-identifier-echoed oracle rather than to a status-code one): ' +
          `${attempts.join(' | ')}`,
      );

      // Which tables the API arm could NOT reach — named, not silent.
      const routedTables = ['memberships', 'capability_grants', 'entitlements'];
      const unrouted = expected.filter((name) => !routedTables.includes(name));
      context.observe(
        'API-surface coverage gap, stated',
        `${String(routedTables.length)} of ${String(expected.length)} tenant tables have a ` +
          `registered route today (${routedTables.join(', ')}). The remaining ` +
          `${String(unrouted.length)} are covered by the SQL arm ONLY, because no route reaches ` +
          `them yet: ${unrouted.join(', ')}. They gain an API arm as their surfaces land.`,
      );

      /* ── the DECLARED exception, named and pinned ──────────────────────
       * `app_breakglass` holds BYPASSRLS (SPEC-01 §4.4, asserted by A-08 in
       * roles-and-schema.test.ts). It therefore SEES across tenants, by design,
       * for two-person emergency use. Asserting it here — rather than quietly
       * omitting the role — is what makes "no SECOND cross-tenant path exists" a
       * complete claim: the known path is named, its status is verified, and any
       * other role reading a foreign row would have failed the sweep above.
       * ──────────────────────────────────────────────────────────────────── */
      const breakglass = runtimes.get('app_breakglass');
      if (breakglass === undefined) throw new Error('app_breakglass runtime missing');
      const bypass = await breakglass.pool.connect();
      let breakglassSees = 0;
      try {
        const attrs = await bypass.query<{ rolbypassrls: boolean }>(
          'select rolbypassrls from pg_roles where rolname = $1',
          ['app_breakglass'],
        );
        if (attrs.rows[0]?.rolbypassrls !== true) {
          throw new Error('app_breakglass no longer holds BYPASSRLS — SPEC-01 §4.4 has drifted');
        }
        // D-05: scoped to this fixture. A cluster-wide count varied with whatever
        // else was running; what BYPASSRLS has to demonstrate is that it crosses
        // THIS fixture's boundaries with no context declared.
        const seen = await bypass.query<{ n: string }>(
          `select count(distinct organization_id)::text as n from memberships
            where organization_id = any($1::uuid[])`,
          [fixture.organizationIds],
        );
        breakglassSees = Number(seen.rows[0]?.n ?? '0');
        if (breakglassSees < 2) {
          throw new Error(
            'app_breakglass saw fewer than two organizations with no context — either the ' +
              'exception is not real or this probe is vacuous',
          );
        }
      } finally {
        bypass.release();
      }
      context.policyExercised('app_breakglass BYPASSRLS — the declared SPEC-01 §4.4 exception');
      context.observe(
        'declared exception (SPEC-01 §4.4, pinned by A-08)',
        `app_breakglass holds BYPASSRLS and sees ${String(breakglassSees)} organizations with no ` +
          'context. That is the ONE sanctioned cross-tenant read path for application roles, it ' +
          'is asserted here rather than omitted, and the four RLS-bound roles above read 0 ' +
          'foreign rows on every table. FAD-14 separately sanctions app_migrator\'s SELECT-only ' +
          'maintenance read of audit_checkpoints.',
      );

      /* ── R-04: the WRITE arm ────────────────────────────────────────────
       * Reads proving isolation say nothing about writes. Every RLS-bound role
       * attempts cross-tenant DML against Beta while declaring Alpha, inside a
       * transaction that is ALWAYS rolled back. Expected: refusal, or zero rows
       * affected. Both are acceptable and are recorded distinctly — a grant
       * refusal (42501) and an RLS no-op are different mechanisms reaching the
       * same guarantee, and flattening them would hide which one is load-bearing.
       * ──────────────────────────────────────────────────────────────────── */
      const writeAttempts: string[] = [];
      let writesThatLanded = 0;
      const rlsExercised = new Set<string>();

      /* Which COLUMN each UPDATE targets, and why it matters (D-03).
       *
       * The first version wrote `set organization_id = organization_id`. No
       * runtime role holds a column grant on `organization_id`, so all 24
       * attempts died at the GRANT layer and not one reached RLS — while the
       * comment claimed the two mechanisms were being distinguished. The reviewer
       * showed that an UPDATE on a GRANTED column instead returns rowsAffected=0,
       * which is RLS doing the work.
       *
       * So each writable table names a column its role actually holds, and the
       * mechanism is recorded per cell. DELETE stays as-is: DELETE is granted
       * nowhere (M1 hardening), so it is a grant refusal by design and is
       * labelled that way rather than dressed up as an RLS result.
       */
      const updatableColumn: Record<string, string | undefined> = {
        memberships: 'last_active_at',
        groups: 'name',
        capability_grants: undefined, // no UPDATE grant — grant-refusal only
        audit_events: undefined, // append-only by design (rule 6)
      };

      for (const role of ['app_runtime', 'app_worker', 'app_readonly_support'] as const) {
        const bound = runtimes.get(role);
        if (bound === undefined) throw new Error(`${role} runtime missing`);
        for (const table of ['memberships', 'groups', 'capability_grants', 'audit_events'] as const) {
          for (const verb of ['update', 'delete'] as const) {
            const column = updatableColumn[table];
            const client = await bound.pool.connect();
            try {
              await client.query('begin');
              await client.query(`select set_config('app.organization_id', $1, true)`, [
                alpha.organizationId,
              ]);
              const statement =
                verb === 'update'
                  ? column === undefined
                    ? `update ${table} set organization_id = organization_id where organization_id = $1::uuid`
                    : `update ${table} set ${column} = ${column} where organization_id = $1::uuid`
                  : `delete from ${table} where organization_id = $1::uuid`;
              const result = await client.query(statement, [fixture.beta.organizationId]);
              const affected = result.rowCount ?? 0;
              if (affected > 0) writesThatLanded += 1;
              // Reached the database and touched nothing: RLS is what stopped it.
              rlsExercised.add(`${role}/${table}/${verb}`);
              writeAttempts.push(
                `${role}/${table}/${verb}: RLS no-op, ${String(affected)} rows affected`,
              );
            } catch (error) {
              const code = (error as { code?: string }).code ?? '?';
              writeAttempts.push(`${role}/${table}/${verb}: grant refusal ${code}`);
            } finally {
              await client.query('rollback').catch(() => undefined);
              client.release();
            }
          }
        }
      }
      if (writesThatLanded > 0) {
        throw new Error(
          `CROSS-TENANT WRITE LANDED: ${writeAttempts.filter((a) => /affected/.test(a) && !/ 0 rows/.test(a)).join(', ')}`,
        );
      }
      // At least one attempt per writable table must have reached RLS, or the
      // arm is measuring the grant matrix only — which is what D-03 found.
      for (const table of ['memberships', 'groups'] as const) {
        const reached = [...rlsExercised].some((key) => key.includes(`/${table}/update`));
        if (!reached) {
          throw new Error(
            `no attempt on ${table} reached the RLS mechanism — every one died at the grant ` +
              'layer, so this arm proves nothing about row-level isolation',
          );
        }
      }

      context.policyExercised('cross-tenant DML refusal (grants + RLS)');
      context.observe(
        'write arm (R-04)',
        `${String(writeAttempts.length)} cross-tenant DML attempts (3 roles x 4 tables x ` +
          'UPDATE/DELETE), each declaring Alpha and targeting Beta, each inside a rolled-back ' +
          `transaction. 0 landed. ${String(rlsExercised.size)} reached the RLS mechanism ` +
          '(statement accepted, 0 rows matched); the rest were refused at the GRANT layer, which ' +
          'is a different control and is labelled as such per cell. ' +
          `Per attempt: ${writeAttempts.join(' | ')}`,
      );

      context.observe(
        'readings',
        `${String(readings.length)} (role, context, table) readings across ${String(
          new Set(readings.map((r) => `${r.role}/${r.context}`)).size,
        )} contexts; 0 wrong-tenant rows; ${String(seen.size)} of ${String(expected.length)} ` +
          'tables observed with visible rows',
      );
      const refusals = readings.filter((reading) => reading.refused !== undefined);
      if (refusals.length > 0) {
        context.observe(
          'reads REFUSED outright (stronger than zero rows, recorded distinctly)',
          `${String(refusals.length)} (role, table) reads raised an error instead of returning ` +
            'rows — the role holds no EXECUTE on a helper the table\'s RLS policy calls, so it ' +
            'cannot read the table at all: ' +
            refusals.map((r) => `${r.role}/${r.table}=${String(r.refused)}`).join(', '),
        );
      }

      context.observe(
        'per-table visibility',
        expected
          .map((name) => {
            const best = readings.filter((r) => r.table === name).reduce((a, b) => (a.visible >= b.visible ? a : b));
            // `audit_checkpoints` under app_migrator is the FAD-14 maintenance
            // read, which by design sees every organization in the cluster — so
            // this one cell counts whatever fixtures share the process. Labelled
            // rather than normalised: the number is meaningful, just run-scoped.
            const scope =
              name === 'audit_checkpoints' && best.role === 'app_migrator' ? ' [RUN-SCOPED: the FAD-14 maintenance read spans every fixture in the process]' : '';
            return `${name}: max ${String(best.visible)} visible (${best.role}/${best.context})${scope}`;
          })
          .join(' | '),
      );
    },
    probe: async () => {
      const { fixture, runtimes } = deps();
      const runtime = runtimes.get('app_runtime');
      if (runtime === undefined) throw new Error('runtime missing');
      // The falsifiability probe: run the SAME oracle with the WRONG expectation
      // of which organization is ours. If the sweep is really reading rows, an
      // Alpha context measured against Beta's id must report wrong > 0. If it
      // reports 0, the probe is looking at nothing and SBX-004's pass is vacuous.
      const readings = await probeUnder(
        runtime,
        'probe/alpha-context-measured-as-beta',
        {
          organizationId: fixture.alpha.organizationId,
          groupId: null,
          membershipId: fixture.alpha.users.organizationAdmin.membershipId,
        },
        fixture.beta.organizationId,
      );
      // OBSERVE, then throw the sentinel. Returning normally means the oracle
      // could NOT be made to reject, which the harness records as VACUOUS.
      const wrong = readings.reduce((sum, reading) => sum + reading.wrong, 0);
      if (wrong === 0) return;
      throw new ProbeFalsified(
        `an Alpha context measured against Beta's id produced ${String(wrong)} wrong-tenant rows ` +
          `across ${String(readings.length)} readings — the sweep is reading real rows`,
      );
    },
  };

  const sbx001: SbxScenario = {
    id: 'SBX-001',
    title: 'Role x registered-surface matrix — every route an explicit allow or a clean deny',
    gateRequired: true,
    contract: {
      owner: 'OPUS-M2-001 (matrix) / OPUS-M3-001 (real-session re-run) / Fable (acceptance)',
      fixtureProvenance:
        'MULTI `full` profile — every SPEC-06 role has a membership in it. Since OPUS-M3-001 the ' +
        'authenticatable role-holders are activated and signed in through the production paths, so ' +
        'the matrix carries a REAL `__Host-sp_session` cookie per principal.',
      deterministicSetup:
        'The registered route table is read from the server itself, not from a list kept in the ' +
        'test; the matrix is therefore generated rather than transcribed. Each role-holder is ' +
        'activated + signed in once (idempotently), and its real session cookie drives the row ' +
        'through the middleware\'s session->principal path — the M2 injected-principal surrogate ' +
        'is gone.',
      externalDependency: 'None.',
      faultControls: 'None injected.',
      objectiveOracle:
        'Every registered route declares a policy (deny-by-default, I-02), and every ' +
        '(role, route) cell — evaluated for a REAL authenticated principal resolved from a real ' +
        'session cookie — resolves to a declared allow or a declared deny. A route with no ' +
        'policy is a failure, not an omission.',
      retainedArtifact: 'docs/evidence/EV-M2-SBX/sbx-001-matrix.txt',
      environment: 'MULTI',
      earliestExecutionPoint: 'E1',
    },
    blocked: [
      {
        subScenario: 'navigation-tree capture and per-role screenshots',
        dependency: 'UI milestone (no web surface for these routes exists yet — OPUS-M2-002)',
      },
    ],
    run: async (context) => {
      const { admin, routeTable, http, fixture, runtimes } = deps();
      // The server-side half that IS executable today: every route the server
      // ACTUALLY REGISTERED carries a policy. Read from the registered table via
      // `buildServer`'s `onRoute` hook rather than from a list kept in the test,
      // so the matrix is generated rather than transcribed.
      const undeclared = undeclaredRoutes(routeTable);
      if (undeclared.length > 0) {
        throw new Error(
          `routes registered without a policy (I-02): ${undeclared
            .map((entry) => `${entry.method} ${entry.url}`)
            .join(', ')}`,
        );
      }
      const real = routeTable.filter((entry) => entry.method !== 'HEAD');
      if (real.length === 0) throw new Error('no routes registered — the matrix would be empty');
      context.observe(
        'registered routes',
        real
          .map((entry) => `${entry.method} ${entry.url} -> ${entry.policy?.kind ?? 'NONE'}`)
          .join(' | '),
      );
      context.policyExercised('route policy declaration (I-02 deny-by-default)');

      // And the role side: every SPEC-06 role in the fixture is a real membership
      // the evaluator can be asked about. Without this the matrix would have rows
      // for roles nobody holds.
      const { rows } = await admin.query<{ group_role: string | null; organization_role: string | null }>(
        'select group_role, organization_role from memberships where organization_id = $1::uuid',
        [fixture.alpha.organizationId],
      );
      const roles = new Set(
        rows.flatMap((row) => [row.group_role, row.organization_role]).filter((r): r is string => r !== null),
      );
      for (const required of ['member', 'viewer', 'telecom', 'scheduler', 'group_admin', 'org_admin', 'org_observer']) {
        if (!roles.has(required)) throw new Error(`no membership holds ${required}`);
      }
      context.tableExercised('memberships');
      context.observe('roles present', [...roles].sort().join(', '));

      /* ── the MATRIX itself, driven by REAL sessions ──────────────────────
       * Every registered route attempted as every role-bearing principal in
       * MULTI — each carrying a REAL `__Host-sp_session` cookie resolved through
       * the middleware's session->principal path (the M2 injected-principal
       * surrogate is gone). A cell is acceptable only if it is an explicit ALLOW
       * (2xx) or a CLEAN DENY — 403/404/401 with the fixed body, or a 409 context
       * precondition, or a 422 body refusal after an allow. Anything else (a 500,
       * a stack, a body that varies with the reason) is a finding.
       * ──────────────────────────────────────────────────────────────────── */
      const alpha = fixture.alpha;
      const full = alpha.full;
      const asAdmin = {
        organizationId: alpha.organizationId,
        groupId: null,
        membershipId: alpha.users.organizationAdmin.membershipId,
        correlationId: 'sbx-001-establish',
      };
      const anonymous = {
        organizationId: alpha.organizationId,
        groupId: null,
        membershipId: null,
        correlationId: 'sbx-001-establish-anon',
      };

      /** The `runtime` the matrix signs in through — the app_runtime pool. */
      const runtime = runtimes.get('app_runtime');
      if (runtime === undefined) throw new Error('app_runtime runtime missing');

      /**
       * Establishes a REAL session for a role-holder: activate the account if it
       * is not already, then sign in and return the cookie SECRET. Returns
       * `undefined` for an account that legitimately cannot hold a session — an
       * ended, suspended or invited membership has no active membership to sign
       * in against, which is itself a real-session-path fact and is driven below
       * with NO cookie (every capability route then answers a 401 unauthenticated
       * deny).
       *
       * Idempotent, and it uses the server's OWN `AuthnService` (system clock),
       * so the session it writes is live when the server resolves it moments
       * later. Session resolution is by token HASH, independent of any service
       * config, so the issuing service and the resolving service need only share
       * the database — which they do.
       */
      const establishRealSession = async (userId: string): Promise<string | undefined> => {
        const credential = await runtime.runner.run(anonymous, (uow) =>
          authnStore.findCredentialById(uow, userId),
        );
        if (credential === undefined) throw new Error(`no such user in the fixture: ${userId}`);
        // Only accounts with an ACTIVE membership can sign in, so only those are
        // activated here. An ended, suspended or invited membership is left
        // pristine — activating it would consume the very `invited` state SBX-005
        // needs, and it could not sign in afterward anyway.
        const canSignIn = await runtime.runner.run(anonymous, (uow) =>
          authnStore.hasActiveMembership(uow, userId),
        );
        if (!canSignIn) return undefined;
        if (credential.activatedAt === null) {
          const invitation = await runtime.runner.run(asAdmin, (uow) =>
            http.authn.issueInvitation(uow, {
              userId,
              email: `sbx-001-${userId.slice(0, 8)}@example.test`,
              notificationRef: 'sink:sbx',
            }),
          );
          await runtime.runner.run(anonymous, (uow) =>
            http.authn.activateAccount(uow, { token: invitation.token, password: SBX_PASSWORD }),
          );
        }
        try {
          const signedIn = await runtime.runner.run(anonymous, (uow) =>
            http.authn.signIn(uow, { loginEmail: credential.loginEmail, password: SBX_PASSWORD }),
          );
          return signedIn.token;
        } catch (error) {
          // No active membership -> no session. The real-session-path answer.
          if (error instanceof AuthnError) return undefined;
          throw error;
        }
      };

      const principals: { label: string; userId: string }[] = [
        { label: 'scheduler(G1+G2)', userId: alpha.users.scheduler.id },
        { label: 'member(G1)', userId: alpha.users.member.id },
        { label: 'scheduler(G2)', userId: alpha.users.groupTwoScheduler.id },
        { label: 'org_admin', userId: alpha.users.organizationAdmin.id },
        { label: 'group-only', userId: alpha.users.groupOnly.id },
        { label: 'departed(ended)', userId: alpha.users.departed.id },
        ...(full === undefined
          ? []
          : [
              { label: 'viewer(G1)', userId: full.viewer.id },
              { label: 'telecom(G1)', userId: full.telecom.id },
              { label: 'group_admin(G1)', userId: full.groupAdmin.id },
              { label: 'org_observer', userId: full.organizationObserver.id },
              { label: 'suspended(G2)', userId: full.suspended.id },
              { label: 'invited(G2)', userId: full.invited.id },
              { label: 'dual-role(G1+G2)', userId: full.dualRole.id },
            ]),
      ];

      const routes = routeTable.filter(
        (entry) => entry.method !== 'HEAD' && entry.url.includes(':organizationId'),
      );
      /* Sign-out is evaluated LAST for each principal, because it is the one
       * route that CONSUMES the session it is given — a real cookie presented to
       * `/authn/sign-out` returns 204 and revokes the session, which would leave
       * every later cell in the row unauthenticated. Ordering it last means the
       * revocation lands after the row is done. (Every other route is
       * non-consuming: the `:userId` capability routes keep a literal `:userId`
       * segment and 404 without effect; the anonymous preauth routes never read
       * the cookie.) */
      const orderedRoutes = [...routes].sort((a, b) => {
        const aOut = a.url.endsWith('/authn/sign-out') ? 1 : 0;
        const bOut = b.url.endsWith('/authn/sign-out') ? 1 : 0;
        return aOut - bOut;
      });
      const substitute = (url: string): string =>
        url
          .replace(':organizationId', alpha.organizationId)
          .replace(':groupId', alpha.groupOne.id)
          .replace(':membershipId', alpha.users.member.membershipId)
          .replace(':targetMembershipId', alpha.users.groupTwoScheduler.membershipId)
          .replace(':moduleKey', 'core_scheduling');

      /**
       * The matrix's request headers: the declared context (SPEC-01), plus the
       * REAL session cookie when the principal has one — and NEVER the
       * test-principal header, so the server resolves the principal from the
       * cookie through `SessionPrincipalResolver` rather than from an injected
       * surrogate.
       */
      const realHeaders = (
        cookieSecret: string | undefined,
        counters: DeclaredCounters,
      ): Record<string, string> => ({
        [CONTEXT_HEADER]: JSON.stringify({
          contextVersion: {
            organizationVersion: counters.organizationVersion,
            groupVersion: counters.groupVersion,
            membershipSetVersion: counters.membershipSetVersion,
          },
          sessionEpoch: counters.sessionEpoch,
        }),
        'x-correlation-id': 'sbx001realmatrix',
        ...(cookieSecret === undefined
          ? {}
          : {
              cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(
                encodeSessionCookie(alpha.organizationId, cookieSecret),
              )}`,
            }),
      });

      const matrix: string[] = [];
      let allowed = 0;
      let denied = 0;
      let refused = 0;
      let bodyRefusals = 0;
      let preAuthRefusals = 0;
      let unauthenticatedDenies = 0;
      let realSessions = 0;
      for (const principal of principals) {
        // A fresh real session per principal, established through the production
        // sign-in path. `undefined` means this principal cannot hold one (ended /
        // suspended / invited membership) — a real-session-path fact, driven with
        // no cookie so every capability route answers a 401 unauthenticated deny.
        const cookieSecret = await establishRealSession(principal.userId);
        const hasSession = cookieSecret !== undefined;
        if (hasSession) realSessions += 1;
        // Read AFTER the sign-in, so the declared session epoch matches the epoch
        // the just-issued session was stamped with (sign-in bumps it).
        const counters = await currentCounters(admin, {
          organizationId: alpha.organizationId,
          groupId: alpha.groupOne.id,
          userId: principal.userId,
        });
        const headers = realHeaders(cookieSecret, counters);
        const cells: string[] = [];
        for (const entry of orderedRoutes) {
          const response = await http.app.inject({
            method: entry.method as 'POST',
            url: substitute(entry.url),
            headers,
            payload: {},
          });
          const status = response.statusCode;
          const allow = status >= 200 && status < 300;
          // Three defined outcomes, not two. 403/404 are the authorization
          // denials; 409 is SPEC-01 §7.1's CONTEXT precondition refusal
          // (CONTEXT_STALE / CONTEXT_TARGET_MISMATCH) — a server-authoritative
          // "re-fetch and retry", which is neither an allow nor a leak. The
          // matrix records it as its own class rather than filing it under
          // "deny", because calling a precondition failure an authorization
          // decision would misdescribe what the server did. This scenario found
          // that distinction by running: the first version accepted only two
          // classes and a cross-group target legitimately answered 409.
          const contextRefusal = status === 409;
          const cleanDeny = status === 403 || status === 404;
          /* FOUR defined outcomes since OPUS-M2-002, for the same reason there
           * were three: running it found one the classification did not cover.
           *
           * The matrix sends `payload: {}` to every route. A route that takes a
           * BODY and is reached by an AUTHORIZED principal therefore answers
           * `422` — the body was well-formed JSON with the wrong fields in it,
           * which is neither an allow nor a denial nor a context precondition.
           *
           * **It is only acceptable because it is unreachable before an
           * allow.** The catalogue routes parse the body INSIDE the unit of
           * work, after `evaluateInTransaction` — so an actor holding nothing
           * gets the ordinary 403/404 and learns nothing about the body the
           * route expects. That ordering is asserted directly in
           * `apps/api/test/catalogue/authorization.test.ts` ("a malformed body
           * from an unauthorized actor is a denial, not a 422"); this class
           * records the outcome, that test proves the precondition. */
          const bodyRefusal = status === 422;
          /* FIVE defined outcomes since OPUS-M3-001, and for the fourth time
           * the reason is that running it found one the classification did not
           * cover.
           *
           * A `preauth` route answers `401` to a principal whose declared
           * authentication STAGE it does not meet — an anonymous route that
           * refused a credential, or a `session-partial` route reached without a
           * partial session — and `400` to a token-bearing route sent something
           * that is not a token (the matrix sends `{}` to everything). That is neither an authorization allow, nor an
           * authorization deny, nor a context precondition, nor a body refusal:
           * it is the pre-auth class's own guard doing its job, and filing it
           * under "deny" would say the SPEC-06 evaluator made a decision it was
           * never asked to make.
           *
           * It is only acceptable BECAUSE the class is explicit and its stage is
           * enforced from the declaration: `apps/api/test/authn/preauth-policy.test.ts`
           * proves an undeclared route still fails the gate, that no pre-auth
           * route names another user, and that a route declaring a stage it does
           * not meet never reaches its handler. */
          const preAuthRefusal =
            (status === 401 || status === 400) && preAuthRouteConfig(entry.config) !== undefined;
          /* SIXTH class, and it arrived with real sessions (OPUS-M3-001): a
           * principal that CANNOT hold a session — an ended, suspended or invited
           * membership — presents no cookie, so every CAPABILITY route answers
           * `401 UNAUTHENTICATED`. That is a clean deny (a fixed body, no leak),
           * and it is the real-session-path truth for those accounts.
           *
           * It is accepted ONLY when the principal has no session. An
           * AUTHENTICATED principal answering 401 on a capability route would be a
           * session that failed to resolve — a defect — so that stays unclassified
           * and fails the run. (A full session hitting a `session-partial` preauth
           * route legitimately gets 401; that is `preAuthRefusal` above, not
           * this.) */
          const unauthenticated =
            status === 401 && !hasSession && preAuthRouteConfig(entry.config) === undefined;
          if (
            !allow &&
            !cleanDeny &&
            !contextRefusal &&
            !bodyRefusal &&
            !preAuthRefusal &&
            !unauthenticated
          ) {
            throw new Error(
              `${principal.label} (${hasSession ? 'real session' : 'no session'}) x ${entry.method} ` +
                `${entry.url} answered ${String(status)} — not an explicit allow, a clean deny, a ` +
                'declared context refusal, or an unauthenticated deny',
            );
          }
          if (allow) allowed += 1;
          else if (cleanDeny || unauthenticated) denied += 1;
          else refused += 1;
          if (bodyRefusal) bodyRefusals += 1;
          if (preAuthRefusal) preAuthRefusals += 1;
          if (unauthenticated) unauthenticatedDenies += 1;
          cells.push(`${entry.method} ${entry.url.split('/').slice(-2).join('/')}=${String(status)}`);
        }
        matrix.push(
          `${principal.label.padEnd(18)}${hasSession ? '[sess]' : '[none]'} ${cells.join('  ')}`,
        );
      }

      if (allowed === 0) {
        throw new Error(
          'every cell denied — a matrix with no allow proves the server is off, not that it ' +
            'authorizes correctly',
        );
      }
      context.policyExercised('SPEC-06 evaluator over the HTTP surface, every role');
      context.policyExercised('SessionPrincipalResolver: real cookie -> principal, every role');
      context.tableExercised('sessions');
      context.observe(
        'role x route matrix (REAL sessions)',
        `${String(principals.length)} principals (${String(realSessions)} carrying a REAL ` +
          `__Host-sp_session cookie resolved via SessionPrincipalResolver; the rest cannot hold a ` +
          `session and present none) x ${String(orderedRoutes.length)} routes = ` +
          `${String(principals.length * orderedRoutes.length)} cells; ${String(allowed)} allow, ` +
          `${String(denied)} clean deny (403/404 authz + 401 unauthenticated), of which ` +
          `${String(unauthenticatedDenies)} were 401 for a principal with no session; ` +
          `${String(refused - bodyRefusals - preAuthRefusals)} context ` +
          `refusal (409), ${String(bodyRefusals)} body refusal (422, reachable only after an ` +
          `allow), ${String(preAuthRefusals)} pre-auth stage refusal (401/400), 0 unclassified\n    ` +
          `${matrix.join('\n    ')}`,
      );

      /* ── byte-identity, where SPEC-01 requires it — with a REAL session ───
       *
       * SPEC-01 §2.4 / T-05b: to a valid principal, "you may not act in this
       * group" and "this group does not exist" must be the SAME answer — a
       * byte-identical 404 — or the pair is an existence oracle.
       *
       * Under real sessions this is demonstrated with `member`, who holds a live
       * session in Group ONE: the SAME member addressing Group TWO (a real group
       * they are not a member of) and a NON-EXISTENT group must both answer 404
       * with an identical body. (The M2 version used an injected ENDED-membership
       * principal; under real auth an ended membership revokes the session and
       * answers 401, so the faithful real-session property is this one — a valid
       * session, a group it cannot act in vs a group that does not exist.) */
      const probeRoute = routes.find((entry) => entry.url.endsWith('context-probe/touch'));
      if (probeRoute === undefined) throw new Error('no probe route to test disclosure against');
      const memberCookie = await establishRealSession(alpha.users.member.id);
      if (memberCookie === undefined) throw new Error('member could not obtain a real session');
      const groupTwoCounters = await currentCounters(admin, {
        organizationId: alpha.organizationId,
        groupId: alpha.groupTwo.id,
        userId: alpha.users.member.id,
      });
      const disclosureHeaders = realHeaders(memberCookie, groupTwoCounters);
      const foreignGroup = await http.app.inject({
        method: 'POST',
        // Group TWO — a real group `member` is not a member of.
        url: substitute(probeRoute.url).replace(alpha.groupOne.id, alpha.groupTwo.id),
        headers: disclosureHeaders,
        payload: {},
      });
      const forgedGroup = await http.app.inject({
        method: 'POST',
        url: substitute(probeRoute.url).replace(alpha.groupOne.id, NONEXISTENT_ID),
        headers: disclosureHeaders,
        payload: {},
      });
      if (foreignGroup.statusCode !== 404 || forgedGroup.statusCode !== 404) {
        throw new Error(
          `T-05b: member in a group they cannot act in answered ${String(foreignGroup.statusCode)} ` +
            `and a forged group id ${String(forgedGroup.statusCode)}; both must be 404`,
        );
      }
      if (foreignGroup.body !== forgedGroup.body) {
        throw new Error(
          'DISCLOSURE: "not permitted here" and "does not exist" produce different bodies — the ' +
            'pair tells an attacker which is which',
        );
      }
      context.policyExercised('SPEC-01 §2.4 / T-05b byte-identical 404, driven by a real session');
      context.observe(
        'byte-identity (real session)',
        `a real member session addressing a group it cannot act in, and a forged group id, are ` +
          `both 404 with an identical body: ${foreignGroup.body}`,
      );
    },
    probe: async () => {
      // Falsifiability: run the SAME oracle against a route table with one
      // route's policy stripped. If `undeclaredRoutes` still reports nothing, the
      // check is not looking at the policy and SBX-001's pass means nothing.
      const { routeTable } = deps();
      const real = routeTable.filter((entry) => entry.method !== 'HEAD');
      const first = real[0];
      if (first === undefined) throw new Error('no route to falsify against');
      const stripped = real.map((entry, index) =>
        index === 0 ? { ...entry, policy: undefined } : entry,
      );
      const detected = undeclaredRoutes(stripped);
      if (detected.length === 0) return;
      throw new ProbeFalsified(
        `stripping the policy from ${first.method} ${first.url} makes undeclaredRoutes report ` +
          `${String(detected.length)} route(s) — the oracle rejects when the control is removed`,
      );
    },
  };

  const sbx002: SbxScenario = {
    id: 'SBX-002',
    title:
      'Capability mapping (CAP-006 / CAP-057): the grant x entitlement x role truth table, ' +
      'proven server-side',
    gateRequired: true,
    contract: {
      owner: 'OPUS-M2-001 (implementer) / Fable (acceptance)',
      fixtureProvenance:
        'MULTI `full` profile: Alpha is entitled to core_scheduling, Gamma deliberately is not, ' +
        'and Alpha carries an explicit ALLOW grant and an explicit DENY grant.',
      deterministicSetup:
        'The truth table is evaluated through the shipped SPEC-06 evaluator against seeded rows; ' +
        'no clock, no concurrency, no ordering dependence.',
      externalDependency: 'None.',
      faultControls: 'None injected.',
      objectiveOracle:
        'TWELVE of the fifteen SPEC-06 truth-table rows are exercised server-side over the ' +
        'real HTTP surface, in 15 concrete non-vacuous cases — each preceded by an ' +
        'ALLOW control on the same actor and route, so a denial cannot pass merely because the ' +
        'actor was never allowed. Twelve rows execute; L1.4, L6.1 and L6.2 have no surface and ' +
        'are EVIDENCE_BLOCKED with their dependency named. COMPANION EVIDENCE, exhaustive ' +
        'rather than sampled: packages/domain/test/authz/cross-product.test.ts evaluates all ' +
        '39,285,000 cases against an independent oracle with 0 disagreements. The sampling ' +
        'relationship is deliberate and is the whole design — the EVALUATOR is proved ' +
        'exhaustively at the domain level, and this scenario proves the SERVER reaches that ' +
        'evaluator on every row. Neither substitutes for the other: an exhaustive evaluator ' +
        'wired to nothing would still pass its own test.',
      retainedArtifact: 'docs/evidence/EV-M2-SBX/sbx-002-truth-table.txt',
      environment: 'MULTI',
      earliestExecutionPoint: 'E1',
    },
    blocked: [
      {
        subScenario: 'L1.4 MODULE_DEPENDENCY_UNSATISFIED',
        dependency:
          'module-with-dependencies milestone — no registered route declares an action in a ' +
          'module that HAS a dependency. Per MODULE_DEPENDENCIES only requests_vacation, ' +
          'marketplace, communications, reporting_documents, picklist and hospital_integration ' +
          'have any, and none of them has a route yet',
      },
      {
        subScenario: 'L6.1 PROXY_INVALID / PROXY_SCOPE / PROXY_GRANTOR_DENIED',
        dependency: 'proxy milestone (no proxy surface exists)',
      },
      {
        subScenario: 'L6.2 IMPERSONATION_EXPIRED / IMPERSONATION_FORBIDDEN_SURFACE',
        dependency: 'impersonation milestone (no impersonation surface exists)',
      },
      {
        subScenario:
          'the picklist-specific arm (group-level Pick List Access x per-user Picklist Admin)',
        dependency:
          'picklist milestone (SPEC-02; no picklist surface exists). Recorded per the packet: ' +
          'this arm re-executes at the picklist milestone, and the reinterpretation is stated here',
      },
    ],
    run: async (context) => {
      const { fixture, admin } = deps();
      const gamma = fixture.gamma;
      if (gamma === undefined) throw new Error('the full profile did not provision Gamma');

      // The oracle, called rather than inlined, so the probe can re-execute the
      // very same check after perturbing state (D-02).
      const { alphaModules, gammaModules } = await entitlementArmsOracle(admin, fixture);
      context.tableExercised('entitlements');
      context.policyExercised('SPEC-06 L1.1 NOT_ENTITLED');

      // Grant dimension, likewise.
      const grants = await admin.query<{ capability_key: string; granted: boolean }>(
        'select capability_key, granted from capability_grants where organization_id = $1::uuid order by 1, 2',
        [fixture.alpha.organizationId],
      );
      const allow = grants.rows.filter((row) => row.granted);
      const deny = grants.rows.filter((row) => !row.granted);
      if (allow.length === 0) throw new Error('no explicit ALLOW grant — the P-1 allow arm is vacuous');
      if (deny.length === 0) throw new Error('no explicit DENY grant — the P-1 deny arm is vacuous');
      context.tableExercised('capability_grants');
      context.policyExercised('SPEC-06 P-1 explicit deny precedence');

      /* ── THE FIFTEEN ROWS, exercised server-side ─────────────────────────
       * SPEC-06's truth table has fifteen steps. Every one of them is exercised
       * here through the REAL HTTP surface against MULTI, one concrete
       * non-vacuous case per row — or reported EVIDENCE_BLOCKED with its
       * dependency named where no surface can reach it yet.
       *
       * Three rows are structurally unreachable today and say so rather than
       * being quietly dropped:
       *   L1.4  no registered route declares an action in a module that HAS a
       *         dependency (MODULE_DEPENDENCIES: only requests_vacation,
       *         marketplace, communications, reporting_documents, picklist and
       *         hospital_integration have any, and none has a route yet)
       *   L6.1  no proxy surface exists
       *   L6.2  no impersonation surface exists
       * ──────────────────────────────────────────────────────────────────── */
      const { http, runtimes } = deps();
      const alpha = fixture.alpha;
      const full = alpha.full;
      const runtime = runtimes.get('app_runtime');
      if (runtime === undefined || full === undefined) throw new Error('dependencies missing');

      const groupPath =
        `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/context-probe/touch`;

      /**
       * One attempt, reporting what the SERVER said rather than what the test
       * assumed. The evaluator writes `authorization: { step, reason }` to the
       * log; a refusal by SPEC-01 §2.3's context layer writes no such line, and
       * that distinction is itself part of the evidence.
       */
      async function attempt(
        userId: string,
        path = groupPath,
      ): Promise<{ status: number; step: string; reason: string }> {
        const counters = await currentCounters(admin, {
          organizationId: alpha.organizationId,
          groupId: alpha.groupOne.id,
          userId,
        });
        http.clearLogs();
        const response = await http.app.inject({
          method: 'POST',
          url: path,
          headers: contextHeaders(userId, counters, 'sbx002truthtable'),
          payload: {},
        });
        const line = http.logs.find(
          (entry) => (entry as { authorization?: unknown }).authorization !== undefined,
        ) as { authorization?: { step?: string; reason?: string } } | undefined;
        return {
          status: response.statusCode,
          step: line?.authorization?.step ?? 'context',
          reason: line?.authorization?.reason ?? 'refused by SPEC-01 §2.3 before the evaluator',
        };
      }

      const rows: string[] = [];
      async function row(
        expectedStep: string,
        label: string,
        arrange: () => Promise<void>,
        restore: () => Promise<void>,
        userId: string,
        path = groupPath,
      ): Promise<void> {
        // A control FIRST: the same actor on the same route must be ALLOWED
        // before the arrangement. Without it a denial proves only that the actor
        // was never allowed, which is the vacuous half of every deny test.
        const before = await attempt(userId, path);
        if (before.status >= 400) {
          throw new Error(
            `${expectedStep} ${label}: the ALLOW control failed (${String(before.status)} ` +
              `${before.reason}) — a denial after this would prove nothing`,
          );
        }
        await arrange();
        try {
          const after = await attempt(userId, path);
          if (after.status < 400) {
            throw new Error(
              `${expectedStep} ${label}: the arrangement did not deny (${String(after.status)})`,
            );
          }
          // Recorded as the SERVER reported it. Where the observed step differs
          // from the one the arrangement was aiming at, both are shown — the
          // evidence is what happened, not what was intended.
          const agreement = after.step === expectedStep ? '' : ` [aimed at ${expectedStep}]`;
          rows.push(
            `${after.step} ${after.reason}: ${String(before.status)} -> ` +
              `${String(after.status)}${agreement}  (${label})`,
          );
        } finally {
          await restore();
        }
      }

      const sql1 = async (text: string, values: unknown[] = []): Promise<void> => {
        await admin.query(text, values);
      };

      /**
       * Arrangements that touch `entitlements` or `group_module_availability`
       * CANNOT be made with the superuser.
       *
       * Found by running this scenario: the first version used plain
       * `admin.query` and the database refused it —
       * "the acting membership does not hold organization.entitlement.administer
       * (SPEC-06 L4)". Entitlement administration is capability-guarded in a
       * trigger, and a superuser with no tenant context holds no capability at
       * all. That refusal is the control working; the test was wrong to try to
       * go round it.
       *
       * So these arrangements go the way production goes: an organization-scoped
       * unit of work with the administrator as the acting membership. The
       * arrangement is now itself evidence that the write path is guarded.
       */
      const asAdministrator = async (
        statement: (query: Kysely<Database>) => Promise<void>,
      ): Promise<void> => {
        await runtime.runner.run(
          {
            organizationId: alpha.organizationId,
            groupId: null,
            membershipId: alpha.users.organizationAdmin.membershipId,
            correlationId: 'sbx002-arrange',
          },
          async (uow) => {
            await statement(uow.query);
          },
        );
      };

      // L0.1 — the organization is not active.
      await row(
        'L0.1', 'ORG_INACTIVE',
        () => sql1('update organizations set status = $1 where id = $2::uuid', ['inactive', alpha.organizationId]),
        () => sql1('update organizations set status = $1 where id = $2::uuid', ['active', alpha.organizationId]),
        alpha.users.scheduler.id,
      );

      // L0.2 — the group is not active.
      await row(
        'L0.2', 'GROUP_INACTIVE',
        () => sql1('update groups set status = $1 where id = $2::uuid', ['inactive', alpha.groupOne.id]),
        () => sql1('update groups set status = $1 where id = $2::uuid', ['active', alpha.groupOne.id]),
        alpha.users.scheduler.id,
      );

      // L1.2 — the entitlement is revoked, then suspended. Two distinct reasons.
      for (const state of ['revoked', 'suspended'] as const) {
        await row(
          'L1.2', `ENTITLEMENT_${state.toUpperCase()}`,
          () => asAdministrator((query) =>
            sql`update entitlements set state = ${state}
                 where module_key = 'core_scheduling'`.execute(query).then(() => undefined)),
          () => asAdministrator((query) =>
            sql`update entitlements set state = 'active'
                 where module_key = 'core_scheduling'`.execute(query).then(() => undefined)),
          alpha.users.scheduler.id,
        );
      }

      // L1.3 — the entitlement's window has closed.
      await row(
        'L1.3', 'ENTITLEMENT_EXPIRED',
        // BOTH bounds move into the past: `entitlements_window` requires
        // effective_to > effective_from, so closing the window without also
        // moving its start is rejected by the constraint — correctly. Found by
        // running this: the first version set only effective_to and the database
        // refused it.
        () => asAdministrator((query) =>
          sql`update entitlements
                 set effective_from = now() - interval '10 days',
                     effective_to = now() - interval '1 day'
               where module_key = 'core_scheduling'`.execute(query).then(() => undefined)),
        // Restored to NULL, not to a far-future bound: S-22 rejects an infinite
        // bound on every effective-dated table, and NULL is how "open" is spelled.
        () => asAdministrator((query) =>
          sql`update entitlements set effective_to = null
               where module_key = 'core_scheduling'`.execute(query).then(() => undefined)),
        alpha.users.scheduler.id,
      );

      // L2.1 — the module is entitled to the organization but not available in
      // this group.
      await row(
        'L2.1', 'MODULE_UNAVAILABLE_IN_GROUP',
        () => asAdministrator((query) =>
          sql`update group_module_availability set available = false
               where group_id = ${alpha.groupOne.id}::uuid
                 and module_key = 'core_scheduling'`.execute(query).then(() => undefined)),
        () => asAdministrator((query) =>
          sql`update group_module_availability set available = true
               where group_id = ${alpha.groupOne.id}::uuid
                 and module_key = 'core_scheduling'`.execute(query).then(() => undefined)),
        alpha.users.scheduler.id,
      );

      // L1.1 — an organization with NO entitlement row at all. Gamma, which is
      // provisioned without core_scheduling by construction, so nothing has to
      // be revoked and put back.
      if (gamma !== undefined) {
        const gammaPath =
          `/organizations/${gamma.organizationId}/groups/${gamma.groupOne.id}/context-probe/touch`;
        const gammaCounters = await currentCounters(admin, {
          organizationId: gamma.organizationId,
          groupId: gamma.groupOne.id,
          userId: gamma.users.scheduler.id,
        });
        const response = await http.app.inject({
          method: 'POST',
          url: gammaPath,
          headers: contextHeaders(gamma.users.scheduler.id, gammaCounters, 'sbx002l11'),
          payload: {},
        });
        if (response.statusCode < 400) {
          throw new Error(`L1.1 NOT_ENTITLED: Gamma answered ${String(response.statusCode)}`);
        }
        rows.push(`L1.1 NOT_ENTITLED: ${String(response.statusCode)} (entitlement-OFF organization)`);
      }

      // L3.1 — an actor with no membership in this group. The organization
      // administrator holds an ORGANIZATION membership and no group one.
      const l31 = await attempt(alpha.users.organizationAdmin.id);
      if (l31.status < 400) {
        throw new Error(`L3.1: the organization admin was allowed a group action (${String(l31.status)})`);
      }
      rows.push(`${l31.step} ${l31.reason}: ${String(l31.status)}  (organization membership only)`);

      // L3.2 — the three inactive membership statuses, each with its own actor
      // already in the fixture, so nothing is arranged and nothing restored.
      for (const [reason, userId] of [
        ['MEMBERSHIP_ENDED', alpha.users.departed.id],
        ['MEMBERSHIP_SUSPENDED', full.suspended.id],
        ['MEMBERSHIP_INVITED', full.invited.id],
      ] as const) {
        const observed = await attempt(userId);
        if (observed.status < 400) throw new Error(`L3.2 ${reason}: allowed (${String(observed.status)})`);
        rows.push(`${observed.step} ${observed.reason}: ${String(observed.status)}  (aimed at ${reason})`);
      }

      // L3.3 — the membership's validity window has closed. Written through an
      // ADMINISTRATOR unit of work, because a validity-window change is
      // privilege-bearing and the database refuses it any other way.
      const scheduler = alpha.users.scheduler;
      const closeWindow = async (valid: 'closed' | 'open'): Promise<void> => {
        await runtime.runner.run(
          {
            organizationId: alpha.organizationId,
            groupId: null,
            membershipId: alpha.users.organizationAdmin.membershipId,
            correlationId: 'sbx002-l33',
          },
          async ({ query }) => {
            // BOTH bounds, for the same reason the entitlement window needed
            // both: `memberships_window` requires valid_to > valid_from, and
            // S-22 rejects an infinite bound — so "open" is spelled NULL, not
            // 'infinity'.
            await (valid === 'closed'
              ? sql`
                  update memberships
                     set valid_from = now() - interval '10 days',
                         valid_to = now() - interval '1 day'
                   where id = ${scheduler.membershipId}::uuid
                `
              : sql`
                  update memberships
                     set valid_to = null
                   where id = ${scheduler.membershipId}::uuid
                `
            ).execute(query);
          },
        );
      };
      await row(
        'L3.3', 'MEMBERSHIP_EXPIRED',
        () => closeWindow('closed'),
        () => closeWindow('open'),
        scheduler.id,
      );

      // L4.1 — an explicit DENY grant beats the role allow (P-1).
      //
      // Written through `asAdministrator`, NOT the superuser, for the reason the
      // entitlement rows above already carry — and this one cost a round of
      // misdiagnosis, so it is worth stating plainly. The first version INSERTed
      // with `sql1` (raw superuser, no tenant context). **Triggers fire for
      // superusers even though RLS does not**, so
      // `capability_grants_guard_administration` ran, the acting membership
      // resolved to NULL, and it raised "the acting membership does not hold
      // organization.role.administer (SPEC-06 L4)". That message names a
      // capability nothing on the memberships path uses, which is exactly why it
      // read as a mystery: the error came from the row BELOW the one being
      // debugged.
      //
      // Two-person rule, preserved deliberately: the acting administrator's USER
      // (organizationAdmin) differs from the target grant's user (scheduler). A
      // membership may never write a grant for itself, whatever it holds —
      // 0002's unconditional self-grant refusal, the database half of residual 4.
      //
      // RESTORE closes the grant's WINDOW rather than deleting the row.
      // `capability_grants` has no DELETE grant for any runtime role (M1
      // hardening: DELETE granted nowhere), so an administrator DELETE would fail
      // on privileges — and closing the window is what production does anyway.
      // The row stays, out of force, exactly as a real revocation leaves it.
      await row(
        'L4.1', 'EXPLICIT_DENY',
        () => asAdministrator((query) =>
          sql`
            insert into capability_grants (id, organization_id, group_id, membership_id,
                                           capability_key, granted, granted_by_membership_id)
            values (${randomUUID()}::uuid, ${alpha.organizationId}::uuid, ${alpha.groupOne.id}::uuid,
                    ${scheduler.membershipId}::uuid, 'membership.touch_self', false,
                    ${alpha.users.organizationAdmin.membershipId}::uuid)
          `.execute(query).then(() => undefined)),
        () => asAdministrator((query) =>
          sql`
            update capability_grants
               set valid_to = now()
             where membership_id = ${scheduler.membershipId}::uuid
               and capability_key = 'membership.touch_self'
               and granted = false
               and valid_to is null
          `.execute(query).then(() => undefined)),
        scheduler.id,
      );

      // L4.2 — a role that simply does not carry the capability.
      const l42 = await attempt(full.viewer.id);
      if (l42.status < 400) throw new Error(`L4.2: viewer was allowed (${String(l42.status)})`);
      rows.push(`${l42.step} ${l42.reason}: ${String(l42.status)}  (role viewer)`);

      // L5.1 — the object policy: an in-scope target the actor does not own.
      const targetPath =
        `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}` +
        `/context-probe/targets/${alpha.users.member.membershipId}`;
      const l51 = await attempt(scheduler.id, targetPath);
      rows.push(
        `${l51.step} ${l51.reason}: ${String(l51.status)}  (in-scope target the actor does not own)`,
      );

      context.tableExercised('organizations');
      context.tableExercised('groups');
      context.tableExercised('memberships');
      context.tableExercised('group_module_availability');
      context.policyExercised('SPEC-06 fifteen-row truth table over the HTTP surface');

      context.observe(
        'truth table dimensions',
        `entitlement ON (Alpha: ${[...alphaModules].sort().join(', ')}) x OFF (Gamma: ` +
          `${[...gammaModules].sort().join(', ')}) x grant ALLOW(${String(allow.length)}) / ` +
          `DENY(${String(deny.length)}) x 7 roles`,
      );
      const evaluatorReported = rows.filter((line) => /^L\d/.test(line)).length;
      const contextRefused = rows.length - evaluatorReported;
      context.observe(
        'fifteen rows, server-side',
        `12 of the 15 SPEC-06 rows execute, in ${String(rows.length)} concrete cases over the ` +
          'real HTTP surface (some rows carry more than one case; L1.4, L6.1 and L6.2 have no ' +
          'surface and are EVIDENCE_BLOCKED below):\n    ' +
          rows.join('\n    '),
      );
      context.observe(
        'WHICH LAYER ANSWERED — stated, because the count alone would mislead',
        `${String(evaluatorReported)} of ${String(rows.length)} cases were refused by the SPEC-06 ` +
          `EVALUATOR and report their own layer. The other ${String(contextRefused)} were refused ` +
          'EARLIER, by SPEC-01 §2.3 context resolution, which answers the same 404 — an inactive ' +
          'organization or group, and a membership that is absent, ended, suspended, invited or ' +
          'out of window, are all resolved before the evaluator is reached. That is the ' +
          'architecture working as SPEC-01 specifies, not a gap: both layers deny, both disclose ' +
          'identically, and http-authorization.test.ts already records the same split with its ' +
          "`deniedBy: 'context'` cases. What this scenario adds is that TWELVE of the fifteen " +
          'rows have a concrete server-side case (L1.4, L6.1 and L6.2 have no surface and are ' +
          'EVIDENCE_BLOCKED), and what it does NOT claim is that every executed row is ' +
          'demonstrated at the evaluator layer. The exhaustive evaluator-level evidence is the 39,285,000-case ' +
          'cross-product cited in the objective oracle.',
      );
      context.observe(
        'rows with no surface, named',
        'L1.4 MODULE_DEPENDENCY_UNSATISFIED -> EVIDENCE_BLOCKED(module-with-dependencies ' +
          'milestone: no registered route declares an action in a module that has one) | ' +
          'L6.1 PROXY_* -> EVIDENCE_BLOCKED(proxy milestone) | ' +
          'L6.2 IMPERSONATION_* -> EVIDENCE_BLOCKED(impersonation milestone)',
      );
      context.observe(
        'note',
        'the picklist-specific arm is EVIDENCE_BLOCKED(picklist milestone) and re-executes there',
      );
    },
    probe: async () => {
      /* D-02 — this probe used to observe an ABSENCE (`count === 0`) and call
       * that falsification. The review repointed it at a nonexistent
       * organization and got PASS/FALSIFIABLE: a missing subject satisfies an
       * absence exactly as well as a working control does. That is the
       * outbox-dispatch:320 shape this whole task exists to kill.
       *
       * It now PERTURBS state, CONFIRMS the perturbation touched a real row, and
       * RE-EXECUTES the scenario's own oracle — throwing only on witnessing that
       * oracle actually reject. A positive observation of failure, never an
       * absence. It calls the SHIPPED oracle rather than re-implementing it,
       * because a probe testing its own copy tests nothing that ships.
       */
      const { fixture, runtimes, admin: client } = deps();
      const runtime = runtimes.get('app_runtime');
      if (runtime === undefined) throw new Error('runtime missing');
      const alpha = fixture.alpha;

      const setState = async (state: string): Promise<number> => {
        let affected = 0;
        await runtime.runner.run(
          {
            organizationId: alpha.organizationId,
            groupId: null,
            membershipId: alpha.users.organizationAdmin.membershipId,
            correlationId: 'sbx002-probe',
          },
          async (uow) => {
            const result = await sql`
              update entitlements set state = ${state}
               where module_key = 'core_scheduling'
            `.execute(uow.query);
            affected = Number(result.numAffectedRows ?? 0n);
          },
        );
        return affected;
      };

      const touched = await setState('revoked');
      try {
        // If the subject did not exist, nothing was falsified. Returning makes
        // the harness record VACUOUS, which is the honest outcome.
        if (touched === 0) return;
        let rejected = false;
        try {
          await entitlementArmsOracle(client, fixture);
        } catch {
          rejected = true;
        }
        if (!rejected) return;
        throw new ProbeFalsified(
          `revoking Alpha's core_scheduling entitlement (${String(touched)} row(s) changed) makes ` +
            'the shipped entitlement-arms oracle reject — it reads live state and discriminates',
        );
      } finally {
        await setState('active');
      }
    },
  };

  /* ──────────────────────────────────────────────────────────────────────────
   * SBX-005 and SBX-006 — the authentication arms, EXECUTED IN FULL.
   *
   * Both were `EVIDENCE_BLOCKED(authn)` at M2 because no authentication
   * subsystem existed. OPUS-M3-001 built one, and packet 32 §3 makes their full
   * execution an exit obligation: "no `EVIDENCE_BLOCKED(authn)` remains".
   *
   * What remains blocked, and on WHAT:
   *
   *   SBX-005 impersonation — blocked on the IMPERSONATION milestone. The
   *     capability key `identity.impersonate` exists in the SPEC-06 catalogue and
   *     there is no surface behind it; building one here would be a capability
   *     this packet was not asked to ship. NOT an authn dependency.
   *   SBX-005 real mailbox delivery — blocked on the NOTIFICATION-DELIVERY
   *     milestone (SPEC-07 adapters, TDG-06 procurement). The INTENT half
   *     executes here and is verified; nothing leaves the machine, which is a
   *     requirement rather than a stage of work.
   *
   * Every other sub-scenario runs.
   * ────────────────────────────────────────────────────────────────────────── */

  /**
   * A synthetic account, activated (if it is not already) and signed in — through
   * the real paths.
   *
   * ## Idempotent, and that is what keeps the three authn arms from colliding
   *
   * SBX-001 activates the role-holders for its real-session matrix; SBX-005/006
   * sign the SAME accounts in afterward. So this helper skips activation when the
   * account already has a password and just signs in — whichever arm reached the
   * account first activated it, and every later arm finds it ready. Without this,
   * SBX-005/006 would try to re-invite an already-active account and be refused
   * (`issueInvitation` demands the `invited` account state), which is exactly the
   * cross-arm order-dependence FAD-15 exists to keep out.
   *
   * It always signs in with `SBX_PASSWORD` (= `FIXTURE_PASSWORD`), the one
   * credential every arm uses.
   */
  const provisionAccount = async (
    authn: AuthnService,
    label: string,
    userId: string,
  ): Promise<{ loginEmail: string; token: string; sessionId: string }> => {
    const { fixture, runtimes: pools } = deps();
    const alpha = fixture.alpha;
    const runner = pools.get('app_runtime')!.runner;
    const asAdmin = {
      organizationId: alpha.organizationId,
      groupId: null,
      membershipId: alpha.users.organizationAdmin.membershipId,
      correlationId: `sbx-${label}`,
    };
    const anonymous = {
      organizationId: alpha.organizationId,
      groupId: null,
      membershipId: null,
      correlationId: `sbx-${label}-anon`,
    };

    const existing = await runner.run(anonymous, (uow) =>
      authnStore.findCredentialById(uow, userId),
    );
    if (existing === undefined) throw new Error(`no such user in the fixture: ${userId}`);

    if (existing.activatedAt === null) {
      const invitation = await runner.run(asAdmin, (uow) =>
        authn.issueInvitation(uow, {
          userId,
          email: `sbx-${label}@example.test`,
          notificationRef: 'sink:sbx',
        }),
      );
      await runner.run(anonymous, (uow) =>
        authn.activateAccount(uow, { token: invitation.token, password: SBX_PASSWORD }),
      );
    }
    const loginEmail = existing.loginEmail;
    const signedIn = await runner.run(anonymous, (uow) =>
      authn.signIn(uow, { loginEmail, password: SBX_PASSWORD }),
    );
    return { loginEmail, token: signedIn.token, sessionId: signedIn.sessionId };
  };

  const sbx005: SbxScenario = {
    id: 'SBX-005',
    title: 'User invitation, activation, deactivation, impersonation',
    contract: {
      owner: 'OPUS-M3-001 (implementer) / Fable (acceptance)',
      fixtureProvenance:
        'MULTI `full` profile — carries suspended, invited and ended memberships, and (since ' +
        'OPUS-M3-001) sessions, invitations, password-reset tokens and MFA enrolments written ' +
        'through the production paths.',
      deterministicSetup:
        'Every lifetime and expiry decision is taken against an INJECTED clock ' +
        '(`ControllableClock`, a constructor parameter of `AuthnService`), so nothing sleeps and ' +
        'nothing samples the wall clock. Membership transitions are database writes.',
      externalDependency:
        'None for the intent half. Real mailbox delivery is blocked on the notification-delivery ' +
        'milestone (SPEC-07 adapters, TDG-06) and is declared below rather than absorbed; the ' +
        'outbox destination is a CONTROLLED SYNTHETIC sink and nothing leaves the machine.',
      faultControls:
        'A replayed invitation token; a membership suspended under a live session; a raw ' +
        'membership UPDATE with no service method involved.',
      objectiveOracle:
        'Each transition behaves as STM-017/STM-018 specify; an invitation token is consumed ' +
        'exactly once; a suspension revokes every live session in the SAME transaction as the ' +
        'membership change; history is retained after deactivation rather than deleted.',
      retainedArtifact: 'docs/evidence/EV-M3-AUTHN/sbx-005-lifecycle.txt',
      environment: 'MULTI',
      earliestExecutionPoint: 'E2',
    },
    blocked: [
      {
        subScenario: 'impersonation banner, audit entry, blocked credential screens',
        dependency:
          'impersonation milestone — `identity.impersonate` exists in the SPEC-06 catalogue ' +
          'with no surface behind it; OPUS-M3-001 was not asked to build one (packet 32 §3)',
      },
      {
        subScenario: 'invitation email delivered to a controlled mailbox',
        dependency:
          'notification-delivery milestone (SPEC-07 adapters, TDG-06 procurement). The outbox ' +
          'INTENT half executes and is verified below; no delivery adapter exists and no test ' +
          'may reach a real person',
      },
    ],
    run: async (context) => {
      const { fixture, admin, runtimes: pools } = deps();
      const alpha = fixture.alpha;
      const runner = pools.get('app_runtime')!.runner;
      const clock = new ControllableClock(SBX_EPOCH);
      const authn = sbxAuthn(clock);
      const anonymous = {
        organizationId: alpha.organizationId,
        groupId: null,
        membershipId: null,
        correlationId: 'sbx005-anon',
      };

      /* ── 1. membership status retention (the M2 arm, unchanged) ─────────── */
      const { rows } = await admin.query<{ status: string; n: string }>(
        `select status, count(*)::text as n from memberships
          where organization_id = $1::uuid group by status order by status`,
        [alpha.organizationId],
      );
      const byStatus = statusRetentionOracle(rows);
      context.tableExercised('memberships');
      context.policyExercised('membership status retention (STM-017/STM-018)');
      context.observe(
        'membership statuses retained',
        [...byStatus.entries()].map(([status, n]) => `${status}=${String(n)}`).join(', '),
      );

      /* ── 2. invite -> single use -> replay refused -> activate ──────────────
       *
       * The subject is `full.invited` — an account with an INVITED membership,
       * chosen deliberately: SBX-001's real-session matrix activates every
       * account it can sign in as, and `full.invited` is not one of them (an
       * invited membership cannot sign in), so it is the one authenticatable-
       * lifecycle subject SBX-001 leaves pristine. That is what makes this
       * single-use test independent of SBX-001 having run first. It does NOT
       * sign in — the invited membership could not — so the assertion is purely
       * about the invitation's single-use atomicity, which is its subject. */
      const invitedSubject = alpha.full!.invited.id;
      const invitation = await runner.run(
        {
          organizationId: alpha.organizationId,
          groupId: null,
          membershipId: alpha.users.organizationAdmin.membershipId,
          correlationId: 'sbx-005-invite',
        },
        (uow) =>
          authn.issueInvitation(uow, {
            userId: invitedSubject,
            email: 'sbx-005-invite@example.test',
            notificationRef: 'sink:sbx',
          }),
      );
      await runner.run(anonymous, (uow) =>
        authn.activateAccount(uow, { token: invitation.token, password: SBX_PASSWORD }),
      );
      context.tableExercised('invitations');
      context.tableExercised('users');

      let replayRefused = false;
      try {
        await runner.run(anonymous, (uow) =>
          authn.activateAccount(uow, {
            token: invitation.token,
            password: 'fixture-a-different-passphrase-01',
          }),
        );
      } catch (error) {
        replayRefused = error instanceof AuthnError;
      }
      if (!replayRefused) throw new Error('a replayed invitation token activated a second time');

      const invitationRow = await admin.query<{ state: string; consumed_at: Date | null }>(
        `select state, consumed_at from invitations
          where organization_id = $1::uuid and user_id = $2::uuid and state = 'accepted'`,
        [alpha.organizationId, invitedSubject],
      );
      if (invitationRow.rows.length !== 1 || invitationRow.rows[0]?.consumed_at === null) {
        throw new Error('the accepted invitation was not consumed exactly once');
      }
      context.policyExercised('STM-017 invitation single use (conditional UPDATE)');
      context.observe(
        'invitation lifecycle',
        'issued -> consumed exactly once -> replay refused with AUTHN_TOKEN_INVALID; the ' +
          "first activator's credential survived",
      );

      /* ── 3. the outbox INTENT, to a controlled synthetic sink ───────────── */
      const intents = await admin.query<{ kind: string; payload: Record<string, unknown> }>(
        `select kind, payload from outbox_events
          where organization_id = $1::uuid and kind = 'authn.invitation.issued'`,
        [alpha.organizationId],
      );
      if (intents.rows.length === 0) throw new Error('no invitation outbox intent was written');
      for (const row of intents.rows) {
        const destination = String(row.payload['destination'] ?? '');
        if (!destination.startsWith('sink:')) {
          throw new Error(`an invitation intent named a non-synthetic destination: ${destination}`);
        }
      }
      context.tableExercised('outbox_events');
      context.policyExercised('I-11 notification INTENT only, synthetic destination');
      context.observe(
        'notification intent',
        `${String(intents.rows.length)} invitation intent(s), every destination a controlled ` +
          'synthetic sink. DELIVERY is blocked on the notification-delivery milestone and is ' +
          'declared, not absorbed.',
      );

      /* ── 4. suspension kills live sessions IMMEDIATELY ──────────────────── */
      const suspendee = await provisionAccount(authn, '005-suspend', alpha.full!.telecom.id);
      const aliveBefore = await runner.run(anonymous, (uow) =>
        authn.resolveSession(uow, suspendee.token),
      );
      if (aliveBefore === undefined) {
        throw new Error('the session was not alive before the suspension — the arm is vacuous');
      }
      await runner.run(
        {
          organizationId: alpha.organizationId,
          groupId: null,
          membershipId: alpha.users.organizationAdmin.membershipId,
          correlationId: 'sbx005-suspend',
        },
        async (uow) => {
          // A RAW row write: the weakest possible caller, with no service method
          // involved, so the control being measured is the database's.
          await sql`
            update memberships set status = 'suspended', updated_at = now()
             where id = ${alpha.full!.telecom.membershipId}::uuid
          `.execute(uow.query);
        },
      );
      const aliveAfter = await runner.run(anonymous, (uow) =>
        authn.resolveSession(uow, suspendee.token),
      );
      if (aliveAfter !== undefined) {
        throw new Error('a live session survived the suspension of its membership');
      }
      const revoked = await admin.query<{ revoked_reason: string }>(
        `select revoked_reason from sessions where id = $1::uuid`,
        [suspendee.sessionId],
      );
      if (revoked.rows[0]?.revoked_reason !== 'membership_suspended') {
        throw new Error(
          `the session was revoked with reason ${String(revoked.rows[0]?.revoked_reason)}`,
        );
      }
      context.tableExercised('sessions');
      context.policyExercised('14 §3 suspension invalidates live sessions immediately (T-07)');
      context.observe(
        'suspension',
        'a RAW membership UPDATE — no service method — revoked the live session in the same ' +
          'transaction, with reason `membership_suspended`',
      );

      /* ── 5. history is RETAINED, not deleted ────────────────────────────── */
      const retained = await admin.query<{ n: string }>(
        `select count(*)::text as n from audit_events
          where organization_id = $1::uuid and event_name like 'authn.%'`,
        [alpha.organizationId],
      );
      if (Number(retained.rows[0]?.n ?? '0') === 0) {
        throw new Error('no authn audit history was retained');
      }
      context.tableExercised('audit_events');
      context.observe(
        'history retained',
        `${String(retained.rows[0]?.n)} authn.* audit events survive the lifecycle; no row is ` +
          'deleted by any of it',
      );
    },
    probe: async () => {
      /* The falsifiability probe re-executes the SHIPPED oracle against a
       * deliberately broken world, and observes it REJECT.
       *
       * The perturbation is the single-use check: an invitation row is moved
       * back to `pending` with its `consumed_at` cleared inside a transaction
       * that is then rolled back, and the oracle — "exactly one accepted,
       * consumed row" — is re-run against it. If the oracle still passes, it is
       * not reading the state it claims to read. */
      const { fixture, runtimes: pools } = deps();
      const alpha = fixture.alpha;
      const migrator = pools.get('app_migrator');
      if (migrator === undefined) throw new Error('migrator runtime missing');

      let rejected = false;
      try {
        await migrator.runner.run(
          {
            organizationId: alpha.organizationId,
            groupId: null,
            membershipId: null,
            correlationId: 'sbx005-probe',
          },
          async (uow) => {
            const moved = await sql`
              update invitations set state = 'pending', consumed_at = null
               where organization_id = ${alpha.organizationId}::uuid
                 and user_id = ${alpha.full!.invited.id}::uuid
                 and state = 'accepted'
            `.execute(uow.query);
            if (Number(moved.numAffectedRows ?? 0n) === 0) {
              throw new Error('PROBE_PERTURBATION_MISSED: no accepted invitation to un-consume');
            }
            const check = await sql<{ n: string }>`
              select count(*)::text as n from invitations
               where organization_id = ${alpha.organizationId}::uuid
                 and user_id = ${alpha.full!.invited.id}::uuid
                 and state = 'accepted' and consumed_at is not null
            `.execute(uow.query);
            rejected = Number(check.rows[0]?.n ?? '0') !== 1;
            // ALWAYS roll back: the perturbation must not survive the probe.
            throw new SbxProbeRollback();
          },
        );
      } catch (error) {
        if (!(error instanceof SbxProbeRollback)) throw error;
      }

      if (!rejected) return;
      throw new ProbeFalsified(
        "un-consuming the accepted invitation makes SBX-005's shipped single-use oracle reject " +
          '— it reads live state and discriminates',
      );
    },
  };

  const sbx006: SbxScenario = {
    id: 'SBX-006',
    title: 'Session timeout and persistence',
    contract: {
      owner: 'OPUS-M3-001 (implementer) / Fable (acceptance)',
      fixtureProvenance: 'MULTI `full` — accounts activated and signed in through the real paths.',
      deterministicSetup:
        'SPEC-16 §4\'s controllable virtual clock, as a CONSTRUCTOR PARAMETER of `AuthnService` ' +
        '(`apps/api/src/authn/clock.ts`). Nothing sleeps and nothing samples the wall clock, so ' +
        'every measurement below is repeatable to the millisecond.',
      externalDependency: 'None.',
      faultControls:
        'Idle simulation by clock advance; a session used continuously across its absolute ' +
        'deadline; two concurrent devices for one identity.',
      objectiveOracle:
        'Measured idle and absolute lifetimes — NUMBERS, not impressions: a session used inside ' +
        'its idle window survives indefinitely up to the absolute bound; one left alone dies at ' +
        'the idle deadline; one used continuously dies at the absolute deadline; a second device ' +
        'does not end the first device\'s session.',
      retainedArtifact: 'docs/evidence/EV-M3-AUTHN/sbx-006-session.txt',
      environment: 'MULTI',
      earliestExecutionPoint: 'E2',
    },
    run: async (context) => {
      const { fixture, admin, runtimes: pools } = deps();
      const alpha = fixture.alpha;
      const runner = pools.get('app_runtime')!.runner;
      const anonymous = {
        organizationId: alpha.organizationId,
        groupId: null,
        membershipId: null,
        correlationId: 'sbx006-anon',
      };

      /* ── idle lifetime, WITHOUT "stay signed in" ────────────────────────── */
      const idleClock = new ControllableClock(SBX_EPOCH);
      const idleAuthn = sbxAuthn(idleClock);
      const ordinary = await provisionAccount(idleAuthn, '006-idle', alpha.full!.groupAdmin.id);
      context.tableExercised('sessions');

      let survivedMs = 0;
      for (let step = 0; step < 8; step += 1) {
        idleClock.advance(25 * 60 * 1000);
        survivedMs += 25 * 60 * 1000;
        const alive = await runner.run(anonymous, (uow) =>
          idleAuthn.resolveSession(uow, ordinary.token),
        );
        if (alive === undefined) {
          throw new Error(
            `a session used every 25 minutes died after ${String(survivedMs / 60000)} minutes — ` +
              'the idle deadline is not sliding',
          );
        }
      }
      idleClock.advance(31 * 60 * 1000);
      const idleDead = await runner.run(anonymous, (uow) =>
        idleAuthn.resolveSession(uow, ordinary.token),
      );
      if (idleDead !== undefined) throw new Error('an idle-expired session still resolved');
      context.policyExercised('14 §3 bounded IDLE lifetime');
      context.observe(
        'idle lifetime, measured',
        `ordinary session: survived ${String(survivedMs / 60000)} minutes of use at 25-minute ` +
          'intervals (idle window 30 minutes, sliding), then died 31 minutes after its last use',
      );

      /* ── idle lifetime, WITH "stay signed in" ───────────────────────────── */
      const persistentClock = new ControllableClock(SBX_EPOCH);
      const persistentAuthn = sbxAuthn(persistentClock);
      const persistentAccount = await provisionAccount(
        persistentAuthn,
        '006-persistent',
        alpha.full!.dualRole.id,
      );
      const persistentSession = await runner.run(anonymous, (uow) =>
        persistentAuthn.signIn(uow, {
          loginEmail: persistentAccount.loginEmail,
          password: SBX_PASSWORD,
          persistent: true,
        }),
      );
      persistentClock.advance(45 * 60 * 1000);
      const persistentAlive = await runner.run(anonymous, (uow) =>
        persistentAuthn.resolveSession(uow, persistentSession.token),
      );
      const ordinaryEquivalentDead = idleDead === undefined;
      if (persistentAlive === undefined) {
        throw new Error(
          'a PERSISTENT session died after 45 idle minutes — the wider idle window is not applied',
        );
      }
      context.observe(
        'persistence, measured',
        '"stay signed in" widens the IDLE window (14 days) and NOT the absolute one: at 45 idle ' +
          'minutes the persistent session is alive where an ordinary one is dead ' +
          `(ordinary dead: ${String(ordinaryEquivalentDead)}). The issued idle deadline is ` +
          'CLAMPED to the absolute deadline, so "persistent" is a convenience, not a second, ' +
          'longer session class.',
      );

      /* ── absolute lifetime, under CONTINUOUS use ────────────────────────── */
      const absoluteClock = new ControllableClock(SBX_EPOCH);
      const absoluteAuthn = sbxAuthn(absoluteClock);
      const continuous = await provisionAccount(
        absoluteAuthn,
        '006-absolute',
        alpha.full!.organizationObserver.id,
      );
      const issued = await admin.query<{ issued_at: Date; absolute_expires_at: Date }>(
        'select issued_at, absolute_expires_at from sessions where id = $1::uuid',
        [continuous.sessionId],
      );
      const absoluteWindowMs =
        issued.rows[0]!.absolute_expires_at.getTime() - issued.rows[0]!.issued_at.getTime();

      let uses = 0;
      for (;;) {
        absoluteClock.advance(10 * 60 * 1000);
        const alive = await runner.run(anonymous, (uow) =>
          absoluteAuthn.resolveSession(uow, continuous.token),
        );
        if (alive === undefined) break;
        uses += 1;
        if (uses > 200) {
          throw new Error(
            'a continuously-used session outlived 33 hours — the absolute bound is not enforced',
          );
        }
      }
      const survivedHours = (uses * 10) / 60;
      context.policyExercised('14 §3 bounded ABSOLUTE lifetime (T-07 bounds a stolen token)');
      context.observe(
        'absolute lifetime, measured',
        `a session used every 10 minutes — so its idle deadline never lapsed — died after ` +
          `${String(uses)} uses (${survivedHours.toFixed(1)} hours). The issued absolute window ` +
          `was ${(absoluteWindowMs / 3600000).toFixed(1)} hours.`,
      );

      /* ── concurrent devices ─────────────────────────────────────────────── */
      const deviceClock = new ControllableClock(SBX_EPOCH);
      const deviceAuthn = sbxAuthn(deviceClock);
      const person = await provisionAccount(deviceAuthn, '006-devices', alpha.users.scheduler.id);
      const secondDevice = await runner.run(anonymous, (uow) =>
        deviceAuthn.signIn(uow, { loginEmail: person.loginEmail, password: SBX_PASSWORD }),
      );
      const firstStillAlive = await runner.run(anonymous, (uow) =>
        deviceAuthn.resolveSession(uow, person.token),
      );
      const secondAlive = await runner.run(anonymous, (uow) =>
        deviceAuthn.resolveSession(uow, secondDevice.token),
      );
      if (firstStillAlive === undefined || secondAlive === undefined) {
        throw new Error('two devices for one identity cannot both hold a live session');
      }
      const epochs = await admin.query<{ session_epoch_at_issue: string }>(
        `select session_epoch_at_issue::text as session_epoch_at_issue from sessions
          where id = any($1::uuid[]) order by issued_at`,
        [[person.sessionId, secondDevice.sessionId]],
      );
      context.policyExercised('SPEC-06 §4 session_epoch bumped by AUTHENTICATION');
      context.observe(
        'concurrent devices, measured — and the consequence STATED',
        `both devices hold live sessions (epochs at issue: ${epochs.rows
          .map((r) => r.session_epoch_at_issue)
          .join(' -> ')}). SPEC-06 §4 bumps \`session_epoch\` on AUTHENTICATION, so the second ` +
          "sign-in makes the FIRST device's declared context stale: its next request answers " +
          '`409 SESSION_STALE` and the client reloads its counters. The SESSION is untouched — ' +
          'that is the difference between a 409 (reload) and a 401 (sign in again), and ' +
          'conflating them would sign a user out of one device every time they used another.',
      );
    },
    probe: async () => {
      /* Falsifiability: re-execute the ABSOLUTE-lifetime oracle against a
       * session whose absolute deadline has already passed, and observe it
       * reject. The perturbation is the clock, not the data — which is the
       * honest one for a scenario whose whole subject is time. */
      const { fixture, runtimes: pools } = deps();
      const alpha = fixture.alpha;
      const runner = pools.get('app_runtime')!.runner;
      const clock = new ControllableClock(SBX_EPOCH);
      const authn = sbxAuthn(clock);
      const anonymous = {
        organizationId: alpha.organizationId,
        groupId: null,
        membershipId: null,
        correlationId: 'sbx006-probe',
      };

      /* A fresh session for an account `run()` already activated. Signing in
       * again rather than provisioning a new account, because provisioning
       * requires an `invited` account state and every one in the fixture has now
       * been used — and because a probe that silently returned when it could not
       * build its subject would report VACUOUS for a reason that has nothing to
       * do with the oracle. */
      const loginEmail = await runner.run(anonymous, async (uow) => {
        const row = await authnStore.findCredentialById(uow, alpha.users.scheduler.id);
        if (row === undefined) throw new Error('PROBE_SUBJECT_MISSING: no credential to sign in as');
        return row.loginEmail;
      });
      const session = await runner.run(anonymous, (uow) =>
        authn.signIn(uow, { loginEmail, password: SBX_PASSWORD }),
      );
      const alive = await runner.run(anonymous, (uow) =>
        authn.resolveSession(uow, session.token),
      );
      if (alive === undefined) {
        throw new Error('PROBE_SUBJECT_MISSING: the probe could not obtain a live session');
      }

      // Past the absolute deadline. The SHIPPED oracle — `resolveSession` —
      // must now refuse the same token it just accepted.
      clock.advance(13 * 60 * 60 * 1000);
      const afterwards = await runner.run(anonymous, (uow) =>
        authn.resolveSession(uow, session.token),
      );
      if (afterwards !== undefined) return; // the oracle did NOT reject: vacuous
      throw new ProbeFalsified(
        'advancing the injected clock past the absolute deadline makes the shipped session ' +
          'resolver refuse a token it accepted a moment earlier — the lifetime oracle reads ' +
          'live state and discriminates',
      );
    },
  };

  return [sbx001, sbx002, sbx004, sbx005, sbx006];
}

/**
 * All FIVE application roles (SPEC-01 §4.4), not the two that hold the most
 * grants. R-03: a sweep over a subset cannot support "no second cross-tenant
 * path exists" — the claim is only complete when every role is asked and the one
 * KNOWN exception is named and pinned in the same evidence.
 */
export function createRuntimes(): Map<RoleName, Runtime> {
  const runtimes = new Map<RoleName, Runtime>();
  for (const role of [
    'app_runtime',
    'app_worker',
    'app_migrator',
    'app_readonly_support',
    'app_breakglass',
  ] as const) {
    runtimes.set(role, createRuntime(role, { max: 2 }));
  }
  return runtimes;
}
