import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import {
  canonicalLocations,
  seedLocationsForSweep,
  type SiteFixtureLocation,
} from '../support/settings.js';

/**
 * **NAMED-CONDITION PROOF — BOTH directions of doc 06 §3.2a's site migration
 * boundary, modelled as fixtures.**
 *
 * Packet 32 §10c: "**both site-migration directions modelled as fixtures**
 * (CAR-021 §3.2a: attribute→entity and entity→attribute expressed as test
 * fixtures proving the data can move — **the alternative migration is NOT
 * built**)".
 *
 * doc 06 §3.2a, verbatim:
 *
 * | Direction | Migration |
 * |---|---|
 * | **Attribute → first-class Site** | Create `sites (organization_id, name, address, timezone)`; populate by distinct `locations.site_label` per organization; add `locations.site_id` FK; backfill; **retain `site_label` for one release** as the rollback path; then drop it |
 * | **First-class Site → attribute** *(rollback)* | Denormalise `sites.name` into `locations.site_label`; drop the FK; drop `sites` |
 *
 * and: "**Both directions are modelled with fixtures before either is built.**"
 *
 * ## What this file is, and — more importantly — what it is not
 *
 * It is a **data-movement proof in a scratch schema**, executed as real SQL over
 * rows written through the real production write path. It is not:
 *
 *   * a `sites` table in the production schema — `pg_class` is asserted below to
 *     hold none;
 *   * a migration — nothing here is in `apps/api/migrations/`;
 *   * a site surface, a site-scoped API, or a site workflow.
 *
 * PO-DEC-01 is `pending` with the working default "defer a first-class Site",
 * and doc 06 §3.2a says a first-class table with foreign keys "is not neutral
 * toward that decision". Building one — even unused — would select the
 * non-default branch by stealth (non-bypass rule 12). Proving the data CAN move
 * is what makes deferring the decision safe rather than merely convenient.
 *
 * ## The failure arms are the point
 *
 * A round-trip test that has never been seen to fail proves nothing: an
 * `expect(after).toEqual(before)` where neither transform did anything passes
 * forever. So the same round trip is run again with a **deliberately broken**
 * forward transform, and each break must be caught:
 *
 * | arm | the bug | why it is realistic |
 * |---|---|---|
 * | case folding | labels are grouped case-insensitively | a "helpful" `lower()` in the GROUP BY; the rollback then writes back one canonical spelling |
 * | organization-blind keying | sites are keyed by label ALONE, not per organization | "a site name is a site name"; §3.2a says *per organization* and this is what that clause is for |
 *
 * ## One assumed bug turned out NOT to be one, and that is recorded rather than dressed up
 *
 * A third arm was written first: a forward transform that omits
 * `where site_label is not null`, on the theory that it would give unlabelled
 * locations a site and the rollback would then invent a label for them. **It
 * round-trips exactly**, because the backfill matches on `IS NOT DISTINCT FROM`
 * — NULL matches the NULL-named site, and the rollback writes that NULL straight
 * back. The arm is kept below as an OBSERVATION asserting the correct outcome,
 * because "we assumed this was lossy and it is not" is a fact about the boundary
 * worth having written down.
 */

const multi = ownedMulti('settings-site-migration', { profile: 'full' });

let admin: pg.Client;
let runtime: Runtime;

/** A scratch schema, named per run. Dropped in `afterAll`, cascade. */
const SCHEMA = `sp_site_fixture_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

const alpha = () => multi().alpha;
const beta = () => multi().beta;

/** The rows the transforms move: the real `locations` rows, of the real shape. */
let baseline: readonly SiteFixtureLocation[] = [];

async function scratch(sql: string, values: unknown[] = []): Promise<void> {
  await admin.query(sql, values);
}

/** Rebuilds the scratch `locations_fixture` from the untouched baseline. */
async function resetFixture(): Promise<void> {
  await scratch(`drop table if exists ${SCHEMA}.locations_fixture cascade`);
  await scratch(`drop table if exists ${SCHEMA}.sites_fixture cascade`);
  await scratch(`
    create table ${SCHEMA}.locations_fixture (
      id              uuid primary key,
      organization_id uuid not null,
      group_id        uuid not null,
      name            text not null,
      site_label      text,
      address         text,
      timezone        text
    )
  `);
  for (const row of baseline) {
    await scratch(
      `insert into ${SCHEMA}.locations_fixture
         (id, organization_id, group_id, name, site_label, address, timezone)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.organizationId,
        row.groupId,
        row.name,
        row.siteLabel,
        row.address,
        row.timezone,
      ],
    );
  }
}

async function readFixture(): Promise<readonly SiteFixtureLocation[]> {
  const { rows } = await admin.query<{
    id: string;
    organization_id: string;
    group_id: string;
    name: string;
    site_label: string | null;
    address: string | null;
    timezone: string | null;
  }>(`select * from ${SCHEMA}.locations_fixture`);

  return canonicalLocations(
    rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      groupId: row.group_id,
      name: row.name,
      siteLabel: row.site_label,
      address: row.address,
      timezone: row.timezone,
    })),
  );
}

/**
 * **Direction 1 — attribute → first-class Site**, exactly as doc 06 §3.2a
 * describes it.
 *
 * `grouping` is the expression the sites are keyed by. The correct migration
 * groups by the label itself, per organization; the failure arms pass a
 * different expression and must be caught.
 *
 * `includeNullLabels` is the branch a migration author forgets. §3.2a says
 * "populate by distinct `locations.site_label`" — a location with no label
 * names no site, so a NULL label must produce no site row and leave `site_id`
 * NULL. The broken arm sets it `true`.
 *
 * **`sites_fixture.address` and `sites_fixture.timezone` are left NULL, and
 * that is a finding rather than an omission.** §3.2a names those columns on the
 * new table but does not say what populates them: `locations` carries its own
 * address and zone per place, and there is no rule for reducing several
 * locations' addresses to one site's. The fixture does not invent one. Recorded
 * in `docs/evidence/EV-M3-SETTINGS/INDEX.md` for the decision, if it is ever
 * taken.
 */
async function forward(
  options: {
    grouping?: string;
    includeNullLabels?: boolean;
    organizationBlind?: boolean;
  } = {},
): Promise<void> {
  const grouping = options.grouping ?? 'site_label';
  const nullFilter = options.includeNullLabels === true ? '' : 'where site_label is not null';
  // The organization-blind arm keys sites by label ALONE, attributing each to
  // one arbitrary organization — the "we can key sites globally by name" bug.
  const blind = options.organizationBlind === true;
  const selectOrganization = blind ? 'min(organization_id::text)::uuid' : 'organization_id';
  const groupBy = blind ? grouping : `organization_id, ${grouping}`;

  // Create `sites (organization_id, name, address, timezone)`.
  await scratch(`
    create table ${SCHEMA}.sites_fixture (
      id              uuid primary key,
      organization_id uuid not null,
      name            text,
      address         text,
      timezone        text,
      unique (organization_id, name)
    )
  `);

  // Populate by DISTINCT site_label PER ORGANIZATION.
  await scratch(`
    insert into ${SCHEMA}.sites_fixture (id, organization_id, name)
    select gen_random_uuid(), ${selectOrganization}, ${grouping}
      from ${SCHEMA}.locations_fixture
      ${nullFilter}
     group by ${groupBy}
  `);

  // Add `locations.site_id` FK.
  await scratch(`alter table ${SCHEMA}.locations_fixture add column site_id uuid`);
  await scratch(`
    alter table ${SCHEMA}.locations_fixture
      add constraint locations_fixture_site_fk
      foreign key (site_id) references ${SCHEMA}.sites_fixture (id)
  `);

  // Backfill.
  await scratch(`
    update ${SCHEMA}.locations_fixture l
       set site_id = s.id
      from ${SCHEMA}.sites_fixture s
     where s.organization_id = l.organization_id
       and s.name is not distinct from ${grouping.replace(/site_label/g, 'l.site_label')}
  `);

  // `site_label` is RETAINED — §3.2a: "retain `site_label` for one release as
  // the rollback path; then drop it". A fixture that dropped it here would be
  // modelling a migration the document does not describe, and would make the
  // rollback below unfalsifiable for the wrong reason.
}

/**
 * **Direction 2 — first-class Site → attribute** (the rollback), exactly as
 * doc 06 §3.2a describes it.
 *
 * The denormalisation reads `sites.name`, NOT the retained `site_label`. That is
 * the whole point: after the one-release retention window the label would be
 * gone, and the rollback has to work from the entity. Reading the retained copy
 * would make every arm below pass trivially — including the broken ones.
 */
async function backward(): Promise<void> {
  // Denormalise `sites.name` into `locations.site_label`.
  await scratch(`
    update ${SCHEMA}.locations_fixture l
       set site_label = s.name
      from ${SCHEMA}.sites_fixture s
     where s.id = l.site_id
  `);
  // A location with no site has no label. Without this the rollback would leave
  // a stale label on a row whose site was removed.
  await scratch(
    `update ${SCHEMA}.locations_fixture set site_label = null where site_id is null`,
  );

  // Drop the FK; drop `sites`.
  await scratch(`
    alter table ${SCHEMA}.locations_fixture drop constraint locations_fixture_site_fk
  `);
  await scratch(`alter table ${SCHEMA}.locations_fixture drop column site_id`);
  await scratch(`drop table ${SCHEMA}.sites_fixture`);
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 3 });

  const full = alpha().full;
  if (full === undefined) throw new Error('the full profile provisions a group admin');

  /* Beta's scheduler needs the location capability to seed there. Written as an
   * explicit layer-4 grant under an organization-scoped context, which is the
   * product's own mechanism (SPEC-06 L4) — `capability_grants` is itself gated
   * by `organization.role.administer`, and the trigger binds the table owner
   * too. */
  await runtime.runner.run(
    {
      organizationId: beta().organizationId,
      groupId: null,
      membershipId: beta().users.organizationAdmin.membershipId,
      correlationId: 'site-fixture-grant',
    },
    async (uow) => {
      const { sql } = await import('kysely');
      await sql`
        insert into capability_grants
          (id, organization_id, group_id, membership_id, capability_key, granted, reason)
        values (gen_random_uuid(), ${beta().organizationId}::uuid, ${beta().groupOne.id}::uuid,
                ${beta().users.scheduler.membershipId}::uuid,
                'group.location.administer', true, 'fixture seeding')
        on conflict do nothing
      `.execute(uow.query as never);
    },
  );

  // Real rows, through the real write path, under the real capability gate.
  await seedLocationsForSweep(runtime.runner, [
    {
      organizationId: alpha().organizationId,
      groupId: alpha().groupOne.id,
      membershipId: full.groupAdmin.membershipId,
      label: 'site_fixture',
    },
    {
      organizationId: beta().organizationId,
      groupId: beta().groupOne.id,
      membershipId: beta().users.scheduler.membershipId,
      label: 'site_fixture_beta',
    },
  ]);

  /* Three more rows that make the transforms non-trivial, written through the
   * same path:
   *
   *   * TWO locations sharing ONE label — so "distinct label per organization"
   *     is a real reduction rather than an identity;
   *   * one whose label differs only by CASE — so the case-folding failure arm
   *     has something to fold;
   *   * (the seed already supplies a NULL-label row, which is what the NULL
   *     branch arm needs). */
  await runtime.runner.run(
    {
      organizationId: alpha().organizationId,
      groupId: alpha().groupOne.id,
      membershipId: full.groupAdmin.membershipId,
      correlationId: 'site-fixture-seed',
    },
    async (uow) => {
      const { sql } = await import('kysely');
      await sql`
        insert into locations (id, organization_id, group_id, name, site_label, address, timezone)
        values
          (gen_random_uuid(), ${alpha().organizationId}::uuid, ${alpha().groupOne.id}::uuid,
           'Fixture annexe one', 'Shared campus', '3 Fixture Lane', null),
          (gen_random_uuid(), ${alpha().organizationId}::uuid, ${alpha().groupOne.id}::uuid,
           'Fixture annexe two', 'Shared campus', null, 'Europe/Dublin'),
          (gen_random_uuid(), ${alpha().organizationId}::uuid, ${alpha().groupOne.id}::uuid,
           'Fixture annexe three', 'SHARED CAMPUS', null, null)
        on conflict (organization_id, group_id, name) do nothing
      `.execute(uow.query as never);
    },
  );

  /* A row in a DIFFERENT organization carrying the SAME label.
   *
   * This is what makes §3.2a's "per organization" clause testable at all: with
   * one organization in the fixture, keying sites globally by name and keying
   * them per organization produce identical results, and the arm that breaks the
   * scoping would pass. */
  await runtime.runner.run(
    {
      organizationId: beta().organizationId,
      groupId: beta().groupOne.id,
      membershipId: beta().users.scheduler.membershipId,
      correlationId: 'site-fixture-seed-beta',
    },
    async (uow) => {
      const { sql } = await import('kysely');
      await sql`
        insert into locations (id, organization_id, group_id, name, site_label, address, timezone)
        values (gen_random_uuid(), ${beta().organizationId}::uuid, ${beta().groupOne.id}::uuid,
                'Fixture annexe beta', 'Shared campus', null, null)
        on conflict (organization_id, group_id, name) do nothing
      `.execute(uow.query as never);
    },
  );

  /* The baseline: the real rows, read through the real GROUP-SCOPED path, once
   * per tenant. Two reads rather than one superuser `select *`, deliberately —
   * the rows the transforms move are exactly the rows the product can see, and a
   * read that bypassed RLS could quietly include something no context ever
   * reaches. */
  const readLocations = async (
    organizationId: string,
    groupId: string,
    membershipId: string,
  ): Promise<readonly SiteFixtureLocation[]> =>
    runtime.runner.run(
      { organizationId, groupId, membershipId, correlationId: 'site-fixture-read' },
      async (uow) => {
        const { sql } = await import('kysely');
        const { rows } = await sql<{
          id: string;
          organization_id: string;
          group_id: string;
          name: string;
          site_label: string | null;
          address: string | null;
          timezone: string | null;
        }>`
          select id, organization_id, group_id, name, site_label, address, timezone from locations
        `.execute(uow.query as never);
        return rows.map((row) => ({
          id: row.id,
          organizationId: row.organization_id,
          groupId: row.group_id,
          name: row.name,
          siteLabel: row.site_label,
          address: row.address,
          timezone: row.timezone,
        }));
      },
    );

  baseline = canonicalLocations([
    ...(await readLocations(
      alpha().organizationId,
      alpha().groupOne.id,
      full.groupAdmin.membershipId,
    )),
    ...(await readLocations(
      beta().organizationId,
      beta().groupOne.id,
      beta().users.scheduler.membershipId,
    )),
  ]);

  await scratch(`create schema ${SCHEMA}`);
  await resetFixture();
  log(`      · scratch schema ${SCHEMA}, ${String(baseline.length)} baseline location row(s)`);
}, 180_000);

afterAll(async () => {
  // Cascade, and unconditional: a scratch schema that outlived its run would be
  // a table the census cannot account for on the next one.
  await admin.query(`drop schema if exists ${SCHEMA} cascade`);
  await runtime.destroy();
  await admin.end();
});

describe('the production schema has no site table, and this file does not create one', () => {
  it('`sites` does not exist in the public schema', async () => {
    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('sites', 'group_sites', 'shift_type_sites')`,
    );
    expect(rows[0]?.n, 'PO-DEC-01 default: no site entity exists').toBe(0);
  });

  it('`locations` carries a free-form label and NO site foreign key', async () => {
    const { rows } = await admin.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'locations'`,
    );
    const columns = rows.map((row) => row.column_name);
    expect(columns).toContain('site_label');
    expect(columns, 'no site_id — a FK is not neutral toward PO-DEC-01').not.toContain('site_id');

    const { rows: fks } = await admin.query<{ n: number }>(
      `select count(*)::int as n from pg_constraint c join pg_class t on t.oid = c.conrelid
        where t.relname = 'locations' and c.contype = 'f' and pg_get_constraintdef(c.oid) ilike '%site%'`,
    );
    expect(fks[0]?.n, 'no site-shaped foreign key on locations').toBe(0);
  });
});

describe('BOTH directions of the doc 06 §3.2a migration boundary', () => {
  it('CONTROL: the baseline exercises every case the transforms must handle', () => {
    const labels = baseline.map((row) => row.siteLabel);
    expect(baseline.length, 'the fixture has rows').toBeGreaterThan(3);
    expect(labels.filter((label) => label === null).length, 'a NULL-label row').toBeGreaterThan(0);
    // Three locations share `Shared campus`: two in Alpha and one in Beta. The
    // Alpha pair makes the reduction real; the Beta one makes the
    // "per organization" clause testable.
    expect(
      labels.filter((label) => label === 'Shared campus').length,
      'three locations share one label',
    ).toBe(3);
    expect(
      new Set(
        baseline.filter((row) => row.siteLabel === 'Shared campus').map((row) => row.organizationId),
      ).size,
      'the shared label spans BOTH organizations',
    ).toBe(2);
    expect(labels, 'a case variant of that label').toContain('SHARED CAMPUS');
    expect(
      new Set(baseline.map((row) => row.organizationId)).size,
      'two organizations — without which the per-organization clause is untestable',
    ).toBe(2);
    log(
      `control: ${String(baseline.length)} rows — ` +
        `${String(labels.filter((l) => l === null).length)} unlabelled, ` +
        `${String(new Set(labels.filter((l) => l !== null)).size)} distinct labels`,
    );
  });

  it('DIRECTION 1 — attribute → entity: one site per distinct label, per organization', async () => {
    await resetFixture();
    await forward();

    const { rows: sites } = await admin.query<{ name: string; organization_id: string }>(
      `select name, organization_id from ${SCHEMA}.sites_fixture order by name`,
    );

    /* One site per distinct (organization, label) PAIR — not per distinct label.
     * `Shared campus` exists in both fixture organizations and must become TWO
     * sites, one per tenant. That is the whole content of §3.2a's "per
     * organization" clause, and the organization-blind failure arm below is what
     * happens when it is ignored. */
    const distinctPairs = new Set(
      baseline
        .filter((row) => row.siteLabel !== null)
        .map((row) => `${row.organizationId}|${String(row.siteLabel)}`),
    );
    expect(sites, 'one site per distinct (organization, label) pair').toHaveLength(
      distinctPairs.size,
    );
    expect(new Set(sites.map((site) => `${site.organization_id}|${site.name}`))).toEqual(
      distinctPairs,
    );
    expect(
      sites.filter((site) => site.name === 'Shared campus'),
      'the shared label became one site PER organization',
    ).toHaveLength(2);

    // Every labelled location points at the site its label names; every
    // unlabelled one points at nothing. The NULL branch, asserted rather than
    // assumed — it is the branch the failure arm below breaks.
    const { rows: joined } = await admin.query<{
      site_label: string | null;
      site_name: string | null;
      unmatched: number;
    }>(`
      select l.site_label, s.name as site_name,
             (case when l.site_label is not null and l.site_id is null then 1 else 0 end) as unmatched
        from ${SCHEMA}.locations_fixture l
        left join ${SCHEMA}.sites_fixture s on s.id = l.site_id
    `);

    for (const row of joined) {
      expect(row.site_name, `label ${String(row.site_label)} resolves to its own site`).toBe(
        row.site_label,
      );
      expect(row.unmatched, 'no labelled location was left unlinked').toBe(0);
    }

    // `site_label` is RETAINED for one release — the rollback path §3.2a names.
    const { rows: retained } = await admin.query<{ n: number }>(
      `select count(*)::int as n from information_schema.columns
        where table_schema = '${SCHEMA}' and table_name = 'locations_fixture'
          and column_name = 'site_label'`,
    );
    expect(retained[0]?.n, 'site_label retained as the rollback path').toBe(1);

    log(
      `direction 1: ${String(sites.length)} site(s) from ${String(baseline.length)} location(s), ` +
        'NULL labels linked to nothing, site_label retained',
    );
  });

  it('DIRECTION 2 — entity → attribute: the rollback recovers the exact baseline', async () => {
    await resetFixture();
    await forward();
    await backward();

    const after = await readFixture();

    // Byte-for-byte on every field the boundary touches, and on the fields it
    // must not touch either. The rollback read `sites.name`, not the retained
    // copy — so this is the entity genuinely being denormalised back.
    expect(after).toEqual(canonicalLocations(baseline));

    // And the site table is gone.
    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
        where table_schema = '${SCHEMA}' and table_name = 'sites_fixture'`,
    );
    expect(rows[0]?.n, 'sites dropped by the rollback').toBe(0);

    log(`direction 2: round trip recovered all ${String(after.length)} rows exactly`);
  });
});

describe('FAILURE ARMS — the round trip can fail, and does', () => {
  it('RED: a forward transform that is BLIND to the organization is CAUGHT', async () => {
    /* The bug: keying sites by label ALONE — "a site name is a site name" —
     * instead of per organization, which is exactly what §3.2a's "per
     * organization" clause is there to prevent.
     *
     * The damage is not cosmetic. One site row is created for `Shared campus`
     * and attributed to whichever organization sorts first; the backfill still
     * joins on `s.organization_id = l.organization_id`, so the OTHER
     * organization's locations match nothing and are left unlinked. The rollback
     * then nulls their label, and a tenant loses data because of a decision made
     * about a different tenant. */
    await resetFixture();
    await forward({ organizationBlind: true });
    await backward();

    const after = await readFixture();
    expect(after).not.toEqual(canonicalLocations(baseline));

    const byId = new Map(after.map((row) => [row.id, row]));
    const orphaned = baseline.filter(
      (row) => row.siteLabel !== null && byId.get(row.id)?.siteLabel === null,
    );
    expect(orphaned.length, 'a labelled row came back unlabelled').toBeGreaterThan(0);
    // And the loss is confined to the organization the site was NOT attributed
    // to — which is the signature of this specific bug rather than of any
    // difference at all.
    expect(
      new Set(orphaned.map((row) => row.organizationId)).size,
      'exactly one organization lost its labels',
    ).toBe(1);
    log(
      `RED (organization-blind): ${String(orphaned.length)} labelled row(s) in one tenant came ` +
        'back unlabelled — caught',
    );
  });

  it('OBSERVATION: omitting the NULL filter is NOT lossy — the assumption was wrong', async () => {
    /* This arm was written as a third RED case, on the theory that a forward
     * transform omitting `where site_label is not null` would give unlabelled
     * locations a site and the rollback would invent a label for them.
     *
     * **It round-trips exactly.** `GROUP BY` treats all NULLs as one group, so a
     * single site named NULL is created; the backfill matches it with
     * `IS NOT DISTINCT FROM`, where NULL matches NULL; and the rollback writes
     * that NULL straight back into `site_label`.
     *
     * The arm is kept, asserting the CORRECT outcome, because a fixture that
     * quietly dropped a disproved hypothesis would leave the next reader to form
     * it again. What it does NOT say is that the filter is unnecessary: a site
     * row named NULL is a meaningless row in a real `sites` table, and the
     * rollback happens to be indifferent to it. The data survives; the schema
     * would be untidy. */
    await resetFixture();
    await forward({ includeNullLabels: true });

    const { rows: nullSites } = await admin.query<{ n: number }>(
      `select count(*)::int as n from ${SCHEMA}.sites_fixture where name is null`,
    );
    expect(nullSites[0]?.n, 'a site named NULL really is created').toBeGreaterThan(0);

    await backward();
    expect(await readFixture()).toEqual(canonicalLocations(baseline));
    log(
      `OBSERVATION: the NULL-inclusive transform creates ${String(nullSites[0]?.n)} meaningless ` +
        'site row(s) and still round-trips exactly',
    );
  });

  it('RED: a forward transform that folds case is CAUGHT', async () => {
    /* The bug: a "helpful" `lower()` in the GROUP BY, so `Shared campus` and
     * `SHARED CAMPUS` merge into one site. The forward direction looks tidier;
     * the rollback then writes ONE canonical spelling back over both, and a
     * distinction somebody typed on purpose is gone.
     *
     * The retained `site_label` would have hidden this entirely — which is
     * exactly why `backward()` reads `sites.name`. */
    await resetFixture();
    await forward({ grouping: 'lower(site_label)' });
    await backward();

    const after = await readFixture();
    expect(after).not.toEqual(canonicalLocations(baseline));

    const byId = new Map(after.map((row) => [row.id, row]));
    const foldedAway = baseline.filter(
      (row) => row.siteLabel === 'SHARED CAMPUS' && byId.get(row.id)?.siteLabel !== 'SHARED CAMPUS',
    );
    expect(foldedAway.length, 'the case variant is what was lost').toBeGreaterThan(0);
    log(`RED (case folding): ${String(foldedAway.length)} row(s) lost their spelling — caught`);
  });

  it('the CORRECT transform still passes after the broken ones — the fixture is not left dirty', async () => {
    // The control that makes the two RED arms mean something: run the correct
    // round trip once more, from the same baseline, and get equality back. If
    // this failed, the RED arms would only have shown that the fixture had been
    // damaged.
    await resetFixture();
    await forward();
    await backward();
    expect(await readFixture()).toEqual(canonicalLocations(baseline));
    log('control: the correct round trip is still exact after both failure arms');
  });
});
