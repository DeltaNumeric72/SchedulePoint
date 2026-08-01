import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { FIXTURE } from './config.ts';
import { withUnitOfWork, type DbRuntime, type TenantContext } from './unit-of-work.ts';

export function orgContext(org: 'A' | 'B'): TenantContext {
  const f = org === 'A' ? FIXTURE.orgA : FIXTURE.orgB;
  return {
    organizationId: f.id,
    groupId: null,
    membershipId: f.membership,
    correlationId: randomUUID(),
  };
}

export function groupContext(org: 'A' | 'B', which: 1 | 2 = 1): TenantContext {
  const f = org === 'A' ? FIXTURE.orgA : FIXTURE.orgB;
  const groupId = org === 'A'
    ? (which === 1 ? FIXTURE.orgA.groupA1 : FIXTURE.orgA.groupA2)
    : (which === 1 ? FIXTURE.orgB.groupB1 : FIXTURE.orgB.groupB2);
  return {
    organizationId: f.id,
    groupId,
    membershipId: f.membership,
    correlationId: randomUUID(),
  };
}

/**
 * Every tenant table, and how its RLS predicate is scoped.
 *
 * SPEC-01 §7.2's preamble requires the concurrency harness to run "against
 * every tenant table". This list is what makes that literal rather than
 * aspirational — the T-15 storm probe iterates it, and so does the final
 * ground-truth census.
 */
export type TenantScope = 'org-identity' | 'org' | 'group';

export interface TenantTable {
  readonly name: string;
  readonly scope: TenantScope;
}

export const TENANT_TABLES: readonly TenantTable[] = [
  // organizations is keyed BY the organization: its predicate is `id = app.organization_id`.
  { name: 'organizations', scope: 'org-identity' },
  // groups carries organization_id but deliberately no group predicate (see 0001).
  { name: 'groups', scope: 'org' },
  { name: 'things', scope: 'group' },
  { name: 'thing_notes_naive', scope: 'group' },
  { name: 'thing_notes_scoped', scope: 'group' },
  { name: 'schedule_versions', scope: 'group' },
  { name: 'assignments', scope: 'group' },
  { name: 'picklist_turns', scope: 'group' },
] as const;

/** The four legitimate (organization, group) partitions in the fixture. */
export const VALID_PAIRS: ReadonlySet<string> = new Set([
  `${FIXTURE.orgA.id}|${FIXTURE.orgA.groupA1}`,
  `${FIXTURE.orgA.id}|${FIXTURE.orgA.groupA2}`,
  `${FIXTURE.orgB.id}|${FIXTURE.orgB.groupB1}`,
  `${FIXTURE.orgB.id}|${FIXTURE.orgB.groupB2}`,
]);

export const VALID_ORGS: ReadonlySet<string> = new Set([FIXTURE.orgA.id, FIXTURE.orgB.id]);

/**
 * Builds the "how many rows can I see that do NOT belong to my context" probe
 * for one table. Must return wrong=0 in a correct system, always.
 *
 * The table name is interpolated, not parameterised, because an identifier
 * cannot be a bind parameter. It comes only from TENANT_TABLES above — a
 * closed, hard-coded list — never from input.
 */
export function wrongTenantProbeSql(
  table: TenantTable,
  ctx: TenantContext,
): { text: string; values: unknown[] } {
  switch (table.scope) {
    case 'org-identity':
      return {
        text: `select count(*) filter (where id is distinct from $1::uuid)::int as wrong,
                      count(*)::int as visible
                 from ${table.name}`,
        values: [ctx.organizationId],
      };
    case 'org':
      return {
        text: `select count(*) filter (where organization_id is distinct from $1::uuid)::int as wrong,
                      count(*)::int as visible
                 from ${table.name}`,
        values: [ctx.organizationId],
      };
    case 'group':
      return {
        text: `select count(*) filter (
                        where organization_id is distinct from $1::uuid
                           or group_id        is distinct from $2::uuid
                      )::int as wrong,
                      count(*)::int as visible
                 from ${table.name}`,
        values: [ctx.organizationId, ctx.groupId],
      };
  }
}

/**
 * Everything is seeded THROUGH the unit of work under the application role.
 * Nothing is inserted with a superuser or with RLS bypassed — if the wrapper
 * did not work, the fixture would not exist and every test would fail loudly.
 *
 * Every one of the six group-scoped tables gets at least one row per group, so
 * the T-15 probe over all eight tables is non-vacuous: an empty table would
 * report "0 wrong rows" for the boring reason rather than the interesting one.
 */
export async function seed(runtime: DbRuntime): Promise<void> {
  for (const org of ['A', 'B'] as const) {
    const f = org === 'A' ? FIXTURE.orgA : FIXTURE.orgB;
    const groups = org === 'A'
      ? [FIXTURE.orgA.groupA1, FIXTURE.orgA.groupA2]
      : [FIXTURE.orgB.groupB1, FIXTURE.orgB.groupB2];

    // Organization-scoped unit of work: organizations and groups only.
    await withUnitOfWork(runtime, orgContext(org), async ({ db }) => {
      await db.insertInto('organizations').values({ id: f.id, name: f.name }).execute();
      await db
        .insertInto('groups')
        .values(groups.map((id, i) => ({ id, organization_id: f.id, name: `${org}-group-${i + 1}` })))
        .execute();
    });

    // Group-scoped units of work: one per group, populating every group-scoped table.
    for (const which of [1, 2] as const) {
      const ctx = groupContext(org, which);
      const organization_id = ctx.organizationId;
      const group_id = ctx.groupId!;
      const thingA = randomUUID();
      const thingB = randomUUID();
      const versionId = randomUUID();
      const membership = randomUUID();

      await withUnitOfWork(runtime, ctx, async ({ db }) => {
        await db
          .insertInto('things')
          .values([
            { id: thingA, organization_id, group_id, name: `${org}${which}-thing-1` },
            { id: thingB, organization_id, group_id, name: `${org}${which}-thing-2` },
          ])
          .execute();

        await db
          .insertInto('thing_notes_naive')
          .values({ id: randomUUID(), organization_id, group_id, thing_id: thingA, body: `${org}${which}-note-naive` })
          .execute();

        await db
          .insertInto('thing_notes_scoped')
          .values({ id: randomUUID(), organization_id, group_id, thing_id: thingA, body: `${org}${which}-note-scoped` })
          .execute();

        await db
          .insertInto('schedule_versions')
          .values({ id: versionId, organization_id, group_id, version: 1, status: 'draft', label: `${org}${which}-v1` })
          .execute();

        await db
          .insertInto('assignments')
          .values({
            id: randomUUID(),
            organization_id,
            group_id,
            membership_id: membership,
            schedule_version_id: versionId,
            during: '[2026-03-01 08:00+00,2026-03-01 16:00+00)',
          })
          .execute();

        await db
          .insertInto('picklist_turns')
          .values({
            id: randomUUID(),
            organization_id,
            group_id,
            turn_id: randomUUID(),
            membership_id: membership,
            status: 'offered',
          })
          .execute();
      });
    }
  }
}

export interface CensusRow {
  table: string;
  organization_id: string;
  group_id: string | null;
  n: number;
}

/**
 * Ground truth across ALL eight tenant tables, read out of band with the
 * superuser. Never used to prove application behaviour — only to check that no
 * row anywhere landed in a partition that cannot legitimately exist.
 */
export async function tenantRowCensus(admin: pg.Client): Promise<CensusRow[]> {
  const groupScoped = TENANT_TABLES.filter((t) => t.scope === 'group')
    .map((t) => `select '${t.name}' as tbl, organization_id, group_id, count(*)::text as n from ${t.name} group by 1,2,3`)
    .join('\n     union all\n     ');

  const res = await admin.query<{ tbl: string; organization_id: string; group_id: string | null; n: string }>(
    `select 'organizations' as tbl, id as organization_id, null::uuid as group_id, count(*)::text as n
       from organizations group by 1,2,3
     union all
     select 'groups', organization_id, id, count(*)::text from groups group by 1,2,3
     union all
     ${groupScoped}
     order by 1, 2, 3`,
  );
  return res.rows.map((r) => ({
    table: r.tbl,
    organization_id: r.organization_id,
    group_id: r.group_id,
    n: Number(r.n),
  }));
}

/** Every census row whose (organization, group) partition cannot legitimately exist. */
export function impossibleCensusRows(rows: readonly CensusRow[]): CensusRow[] {
  return rows.filter((r) =>
    r.group_id === null
      ? !VALID_ORGS.has(r.organization_id)
      : !VALID_PAIRS.has(`${r.organization_id}|${r.group_id}`),
  );
}
