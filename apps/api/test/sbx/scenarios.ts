import { randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import type pg from 'pg';

import { undeclaredRoutes, type RouteTableEntry } from '../../src/http/route-table.js';
import { TENANT_TABLES, type Database } from '../../src/db/schema.js';
import type { RoleName } from '../../src/db/roles.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { contextHeaders, currentCounters, type HttpHarness } from '../support/http.js';
import { NONEXISTENT_ID } from '../support/fixtures.js';
import type { MultiFixture } from '../support/multi.js';
import { ProbeFalsified, type SbxScenario } from './contract.js';

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

        if (foreignResponse.statusCode < 400) {
          throw new Error(
            `CROSS-TENANT ACCESS ALLOWED: ${entry.method} ${foreign} answered ` +
              `${String(foreignResponse.statusCode)} to a BETA principal`,
          );
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
        `${String(denied)}/${String(routed.length)} organization-scoped routes denied a foreign ` +
          'organization id to an authenticated BETA principal, byte-identically to a ' +
          `non-existent id: ${attempts.join(' | ')}`,
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
      owner: 'OPUS-M2-001 (implementer) / Fable (acceptance)',
      fixtureProvenance: 'MULTI `full` profile — every SPEC-06 role has a membership in it.',
      deterministicSetup:
        'The registered route table is read from the server itself, not from a list kept in the ' +
        'test; the matrix is therefore generated rather than transcribed.',
      externalDependency: 'None.',
      faultControls: 'None injected.',
      objectiveOracle:
        'Every registered route declares a policy (deny-by-default, I-02), and every ' +
        '(role, route) cell resolves to a declared allow or a declared deny. A route with no ' +
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
      {
        subScenario: 'sign in as each role in turn',
        dependency: 'authn milestone (no authentication subsystem exists; no M1 packet contained it)',
      },
    ],
    run: async (context) => {
      const { admin, routeTable, http, fixture } = deps();
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

      /* ── the MATRIX itself ───────────────────────────────────────────────
       * Every registered route attempted as every role-bearing principal in
       * MULTI. A cell is acceptable only if it is an explicit ALLOW (2xx) or a
       * CLEAN DENY — 403/404 with the fixed body. Anything else (a 500, a
       * stack, a body that varies with the reason) is a finding.
       * ──────────────────────────────────────────────────────────────────── */
      const alpha = fixture.alpha;
      const full = alpha.full;
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
      const substitute = (url: string): string =>
        url
          .replace(':organizationId', alpha.organizationId)
          .replace(':groupId', alpha.groupOne.id)
          .replace(':membershipId', alpha.users.member.membershipId)
          .replace(':targetMembershipId', alpha.users.groupTwoScheduler.membershipId)
          .replace(':moduleKey', 'core_scheduling');

      const matrix: string[] = [];
      let allowed = 0;
      let denied = 0;
      let refused = 0;
      let bodyRefusals = 0;
      for (const principal of principals) {
        const counters = await currentCounters(admin, {
          organizationId: alpha.organizationId,
          groupId: alpha.groupOne.id,
          userId: principal.userId,
        });
        const headers = contextHeaders(principal.userId, counters, 'sbx001rolematrix');
        const cells: string[] = [];
        for (const entry of routes) {
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
          if (!allow && !cleanDeny && !contextRefusal && !bodyRefusal) {
            throw new Error(
              `${principal.label} x ${entry.method} ${entry.url} answered ${String(status)} — ` +
                'not an explicit allow, a clean deny, or a declared context refusal',
            );
          }
          if (allow) allowed += 1;
          else if (cleanDeny) denied += 1;
          else refused += 1;
          if (bodyRefusal) bodyRefusals += 1;
          cells.push(`${entry.method} ${entry.url.split('/').slice(-2).join('/')}=${String(status)}`);
        }
        matrix.push(`${principal.label.padEnd(18)} ${cells.join('  ')}`);
      }

      if (allowed === 0) {
        throw new Error(
          'every cell denied — a matrix with no allow proves the server is off, not that it ' +
            'authorizes correctly',
        );
      }
      context.policyExercised('SPEC-06 evaluator over the HTTP surface, every role');
      context.observe(
        'role x route matrix',
        `${String(principals.length)} principals x ${String(routes.length)} routes = ` +
          `${String(principals.length * routes.length)} cells; ${String(allowed)} allow, ` +
          `${String(denied)} clean deny (403/404), ${String(refused - bodyRefusals)} context ` +
          `refusal (409), ${String(bodyRefusals)} body refusal (422, reachable only after an ` +
          `allow), 0 unclassified\n    ${matrix.join('\n    ')}`,
      );

      /* ── byte-identity, where SPEC-01 requires it ───────────────────────── */
      const probeRoute = routes.find((entry) => entry.url.endsWith('context-probe/touch'));
      if (probeRoute === undefined) throw new Error('no probe route to test disclosure against');
      const departedCounters = await currentCounters(admin, {
        organizationId: alpha.organizationId,
        groupId: alpha.groupOne.id,
        userId: alpha.users.departed.id,
      });
      const revoked = await http.app.inject({
        method: 'POST',
        url: substitute(probeRoute.url),
        headers: contextHeaders(alpha.users.departed.id, departedCounters, 'sbx001disclosure'),
        payload: {},
      });
      const forged = await http.app.inject({
        method: 'POST',
        url: substitute(probeRoute.url).replace(alpha.groupOne.id, NONEXISTENT_ID),
        headers: contextHeaders(alpha.users.departed.id, departedCounters, 'sbx001disclosure'),
        payload: {},
      });
      if (revoked.statusCode !== 404 || forged.statusCode !== 404) {
        throw new Error(
          `FAD-11: a revoked membership answered ${String(revoked.statusCode)} and a forged ` +
            `group id ${String(forged.statusCode)}; both must be 404`,
        );
      }
      if (revoked.body !== forged.body) {
        throw new Error(
          'DISCLOSURE: a revoked membership and a forged group id produce different bodies — ' +
            'the pair tells an attacker which is which',
        );
      }
      context.policyExercised('SPEC-01 §2.4 byte-identical 404 (FAD-11 revoked membership)');
      context.observe(
        'byte-identity',
        `a revoked (ended) membership and a forged group id are both 404 with an identical ` +
          `body: ${revoked.body}`,
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

  const sbx005: SbxScenario = {
    id: 'SBX-005',
    title: 'User invitation, activation, deactivation, impersonation',
    contract: {
      owner: 'OPUS-M2-001 (implementer) / Fable (acceptance)',
      fixtureProvenance: 'MULTI `full` profile — carries suspended, invited and ended memberships.',
      deterministicSetup: 'Membership state transitions are database writes; no clock dependence.',
      externalDependency:
        'A controlled mailbox for the invitation half (report 18 §4). None is provisioned, and ' +
        'per SPEC-16 §5 a test whose destination cannot be proven controlled does not run.',
      faultControls: 'None injected.',
      objectiveOracle:
        'Each transition behaves as STM-017/STM-018 specify, and history is retained after ' +
        'deactivation rather than deleted.',
      retainedArtifact: 'docs/evidence/EV-M2-SBX/sbx-005-lifecycle.txt',
      environment: 'MULTI',
      earliestExecutionPoint: 'E2',
    },
    blocked: [
      { subScenario: 'invite / token single-use / token replay / activate', dependency: 'authn milestone' },
      { subScenario: 'suspend and confirm live sessions die immediately', dependency: 'authn milestone (no session subsystem)' },
      { subScenario: 'impersonation banner, audit entry, blocked credential screens', dependency: 'authn milestone (no impersonation subsystem)' },
      { subScenario: 'invitation email to a controlled mailbox', dependency: 'controlled notification endpoint (report 18 §4)' },
    ],
    run: async (context) => {
      // The executable sub-scenario: membership suspension and deactivation
      // history retention. Its subjects exist in the fixture today.
      const { fixture, admin } = deps();
      const { rows } = await admin.query<{ status: string; n: string }>(
        `select status, count(*)::text as n from memberships
          where organization_id = $1::uuid group by status order by status`,
        [fixture.alpha.organizationId],
      );
      const byStatus = statusRetentionOracle(rows);
      context.tableExercised('memberships');
      context.policyExercised('membership status retention (STM-017/STM-018 partial)');
      context.observe(
        'membership statuses retained',
        [...byStatus.entries()].map(([status, n]) => `${status}=${String(n)}`).join(', '),
      );
      context.observe(
        'blocked',
        'invitation, activation, session death on suspend and impersonation all require the ' +
          'authn subsystem, which does not exist — reported EVIDENCE_BLOCKED, never skipped',
      );
    },
    probe: async () => {
      /* D-02, same shape as SBX-002's. This probe used to observe that a status
       * nobody holds returns 0 rows — an ABSENCE, which a nonexistent
       * organization satisfies just as well. It now perturbs a real status,
       * confirms the perturbation landed, and re-executes the shipped oracle.
       */
      const { fixture, admin: client, runtimes } = deps();
      const runtime = runtimes.get('app_runtime');
      if (runtime === undefined) throw new Error('runtime missing');
      const alpha = fixture.alpha;

      /* E-01 — restore by ROW ID, never by predicate.
       *
       * The first version flipped 'invited'→'suspended' and restored
       * 'suspended'→'invited', which also caught the fixture's PRE-EXISTING
       * suspended membership and left the post-run census with suspended=0 —
       * violating this scenario's own oracle. A broken restore inside a control
       * is worth fixing even with no consumer today, because the next consumer
       * inherits it silently.
       */
      const perturbed: string[] = [];
      const setStatusById = async (ids: readonly string[], to: string): Promise<number> => {
        if (ids.length === 0) return 0;
        let affected = 0;
        await runtime.runner.run(
          {
            organizationId: alpha.organizationId,
            groupId: null,
            membershipId: alpha.users.organizationAdmin.membershipId,
            correlationId: 'sbx005-probe',
          },
          async (uow) => {
            const result = await sql`
              update memberships set status = ${to}
               where id = any(${ids}::uuid[])
            `.execute(uow.query);
            affected = Number(result.numAffectedRows ?? 0n);
          },
        );
        return affected;
      };

      const invited = await client.query<{ id: string }>(
        `select id from memberships where organization_id = $1::uuid and status = 'invited'`,
        [alpha.organizationId],
      );
      perturbed.push(...invited.rows.map((row) => row.id));
      const touched = await setStatusById(perturbed, 'suspended');
      try {
        if (touched === 0) return; // nothing perturbed => VACUOUS, honestly
        const { rows } = await client.query<{ status: string; n: string }>(
          `select status, count(*)::text as n from memberships
            where organization_id = $1::uuid group by status`,
          [alpha.organizationId],
        );
        let rejected = false;
        try {
          statusRetentionOracle(rows);
        } catch {
          rejected = true;
        }
        if (!rejected) return;
        throw new ProbeFalsified(
          `moving ${String(touched)} invited membership(s) to suspended makes the shipped ` +
            'status-retention oracle reject — it reads live state and discriminates',
        );
      } finally {
        // Exactly the rows this probe moved, by id.
        await setStatusById(perturbed, 'invited');
      }
    },

  };

  const sbx006: SbxScenario = {
    id: 'SBX-006',
    title: 'Session timeout and persistence',
    contract: {
      owner: 'OPUS-M2-001 (implementer) / Fable (acceptance)',
      fixtureProvenance: 'MULTI — no fixture beyond a signed-in principal is needed.',
      deterministicSetup:
        'Would require the SPEC-16 §4 controllable virtual clock; wall-clock sampling is not ' +
        'evidence because it is unrepeatable.',
      externalDependency: 'None, once a session subsystem exists.',
      faultControls: 'Forced disconnection and idle simulation, once there is a session to idle.',
      objectiveOracle:
        'Measured idle and absolute lifetimes, bounded and consistent across devices — a number, ' +
        'not an impression.',
      retainedArtifact: 'docs/evidence/EV-M2-SBX/sbx-006-session.txt',
      environment: 'MULTI',
      earliestExecutionPoint: 'E2',
    },
    blocked: [
      { subScenario: 'idle session lifetime, with and without "stay signed in"', dependency: 'authn milestone (no session subsystem)' },
      { subScenario: 'absolute session lifetime', dependency: 'authn milestone (no session subsystem)' },
      { subScenario: 'concurrent-device behaviour', dependency: 'authn milestone (no session subsystem)' },
    ],
    // No `probe`: every sub-scenario is blocked, so there is nothing executable to
    // falsify. The harness records EVIDENCE_BLOCKED and states that reason rather
    // than treating the missing probe as satisfied.
    run: () => Promise.resolve(),
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
