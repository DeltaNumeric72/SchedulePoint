import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';
import { groupContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { seedLocationsForSweep } from '../support/settings.js';

/**
 * **RED CASE — `locations` is invisible across BOTH tenant boundaries**
 * (packet 32 §10c: "locations swept by SBX-004 (floor raised)", and the
 * cross-group denial named among the key proofs).
 *
 * ## Two ways to leak, and they fail differently
 *
 *   * **organization boundary** — Alpha's context seeing Beta's rows. Caught by
 *     the `organization_id` clause;
 *   * **group boundary** — Alpha Group One's context seeing Alpha Group Two's
 *     rows. Caught by the `group_id` clause, and this is the CAR-001 defect
 *     class: an application bug that resolves the wrong group *inside the right
 *     organization*, which the organization clause cannot see.
 *
 * ## The vacuity this file is built to avoid
 *
 * The catalogue's equivalent sweep shipped VACUOUS and an independent review
 * proved it: with the fixture seeding one group per organization, dropping the
 * `group_id` clause from every policy — the CAR-001 defect exactly — left every
 * test green, because the cross-group arm was counting an empty table.
 *
 * So this file asserts, **before** it asserts zero, that each measurement is
 * capable of being non-zero:
 *
 * | Dimension | Control |
 * |---|---|
 * | organization | Beta holds location rows, read outside RLS |
 * | group | Alpha's SIBLING group holds location rows, read outside RLS |
 *
 * And the last test runs the same probe with the WRONG expectation of which
 * tenant is ours: if the probe is really reading rows it must report a non-zero
 * count there. A probe that reports zero when told to expect the wrong tenant is
 * looking at nothing.
 */

const multi = ownedMulti('settings-locations-isolation', { profile: 'full' });

let admin: pg.Client;
let runtime: Runtime;

const alpha = () => multi().alpha;
const beta = () => multi().beta;

interface Reading {
  readonly visible: number;
  readonly wrongOrganization: number;
  readonly wrongGroup: number;
}

async function readLocations(
  context: ReturnType<typeof groupContext>,
  expected: { organizationId: string; groupId: string },
): Promise<Reading> {
  const row = await runtime.runner.run(
    { ...context, correlationId: 'locations-isolation' },
    async (uow) => {
      const { rows } = await sql<{ visible: number; wrong_org: number; wrong_group: number }>`
        select count(*)::int as visible,
               count(*) filter (
                 where organization_id is distinct from ${expected.organizationId}::uuid
               )::int as wrong_org,
               count(*) filter (
                 where group_id is distinct from ${expected.groupId}::uuid
               )::int as wrong_group
          from locations
      `.execute(uow.query);
      return rows[0];
    },
  );

  return {
    visible: Number(row?.visible ?? 0),
    wrongOrganization: Number(row?.wrong_org ?? 0),
    wrongGroup: Number(row?.wrong_group ?? 0),
  };
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 3 });

  /* Seeded into Alpha Group One, Alpha Group TWO and Beta Group One.
   *
   * The middle one is the whole reason this file can fail: without rows in the
   * sibling group, "Alpha Group One sees zero of Alpha Group Two's locations"
   * is a statement about an empty table.
   *
   * The seeding runs through the production write path under a
   * capability-holding context — `app_guard_location_administration` binds the
   * table owner too, so a raw owner insert is refused, which is the control
   * working. */
  const full = alpha().full;
  if (full === undefined) throw new Error('the full profile provisions a group admin');

  /* The fixture provisions ONE `group_admin`, in Alpha Group One. The sibling
   * group and Beta hold schedulers, and a scheduler deliberately does NOT hold
   * `group.location.administer` (doc 08 §6's "Group settings" row marks it `—`)
   * — the seeding was refused when it tried, which is the capability gate
   * working and is worth recording rather than working around silently.
   *
   * So the two other seeding contexts get an EXPLICIT layer-4 grant. That is the
   * product's own mechanism (SPEC-06 L4, doc 08 §4) rather than a bypass: the
   * write still goes through the production path, still through the trigger,
   * still under RLS. What it is not is a role change, which would have altered
   * what every other assertion in the suite is asserting about. */
  const grant = async (
    organizationId: string,
    organizationAdminMembershipId: string,
    groupId: string,
    membershipId: string,
  ): Promise<void> => {
    // Written under an ORGANIZATION-scoped context as the organization
    // administrator, because `capability_grants` is itself gated by
    // `organization.role.administer` — writing a grant is a privileged act and
    // the trigger binds the table owner too. `provisionMulti` writes its grants
    // exactly this way.
    await runtime.runner.run(
      {
        organizationId,
        groupId: null,
        membershipId: organizationAdminMembershipId,
        correlationId: 'locations-isolation-grant',
      },
      async (uow) => {
        await sql`
          insert into capability_grants
            (id, organization_id, group_id, membership_id, capability_key, granted, reason)
          values (gen_random_uuid(), ${organizationId}::uuid, ${groupId}::uuid,
                  ${membershipId}::uuid, 'group.location.administer', true, 'fixture seeding')
          on conflict do nothing
        `.execute(uow.query);
      },
    );
  };

  await grant(
    alpha().organizationId,
    alpha().users.organizationAdmin.membershipId,
    alpha().groupTwo.id,
    full.dualRole.groupTwoMembershipId,
  );
  await grant(
    beta().organizationId,
    beta().users.organizationAdmin.membershipId,
    beta().groupOne.id,
    beta().users.scheduler.membershipId,
  );

  const written = await seedLocationsForSweep(runtime.runner, [
    {
      organizationId: alpha().organizationId,
      groupId: alpha().groupOne.id,
      membershipId: full.groupAdmin.membershipId,
      label: 'alpha_one',
    },
    {
      organizationId: alpha().organizationId,
      groupId: alpha().groupTwo.id,
      membershipId: full.dualRole.groupTwoMembershipId,
      label: 'alpha_two',
    },
    {
      organizationId: beta().organizationId,
      groupId: beta().groupOne.id,
      membershipId: beta().users.scheduler.membershipId,
      label: 'beta_one',
    },
  ]);
  log(`      · seeded ${String(written)} location row(s) across three groups`);
}, 180_000);

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

describe('locations cross-boundary isolation', () => {
  it('CONTROL: rows exist in Alpha Group One, Alpha Group TWO and Beta — read outside RLS', async () => {
    // Ground truth, as the superuser. Without this, every zero below could mean
    // "nothing was ever written", and the whole file would be decorative.
    for (const [organizationId, groupId, label] of [
      [alpha().organizationId, alpha().groupOne.id, 'Alpha Group One'],
      [alpha().organizationId, alpha().groupTwo.id, 'Alpha Group Two (the SIBLING)'],
      [beta().organizationId, beta().groupOne.id, 'Beta Group One'],
    ] as const) {
      const { rows } = await admin.query<{ n: number }>(
        `select count(*)::int as n from locations where organization_id = $1 and group_id = $2`,
        [organizationId, groupId],
      );
      expect(rows[0]?.n ?? 0, `${label} holds location rows`).toBeGreaterThan(0);
    }
    log('control: three groups populated, including the sibling');
  });

  it('Alpha Group One sees its own rows and NOTHING from Group Two or from Beta', async () => {
    const reading = await readLocations(
      groupContext(
        alpha().organizationId,
        alpha().groupOne.id,
        alpha().full?.groupAdmin.membershipId ?? null,
      ),
      { organizationId: alpha().organizationId, groupId: alpha().groupOne.id },
    );

    // Non-vacuity in the visible dimension: a probe over a table nobody ever saw
    // a row in reports "0 wrong" for the most boring possible reason.
    expect(reading.visible, 'the context sees its own locations').toBeGreaterThan(0);
    expect(reading.wrongOrganization, 'zero rows from another organization').toBe(0);
    expect(reading.wrongGroup, 'zero rows from a sibling group').toBe(0);
    log(
      `Alpha Group One: ${String(reading.visible)} visible, 0 wrong-organization, 0 wrong-group`,
    );
  });

  it('Beta sees its own rows and none of Alpha\'s', async () => {
    const reading = await readLocations(
      groupContext(
        beta().organizationId,
        beta().groupOne.id,
        beta().users.scheduler.membershipId,
      ),
      { organizationId: beta().organizationId, groupId: beta().groupOne.id },
    );

    expect(reading.visible).toBeGreaterThan(0);
    expect(reading.wrongOrganization).toBe(0);
    expect(reading.wrongGroup).toBe(0);
    log(`Beta Group One: ${String(reading.visible)} visible, 0 wrong on both boundaries`);
  });

  it('an ORGANIZATION-scoped context sees ZERO locations — there is no organization policy', async () => {
    /* SPEC-06 §1.1: "Everything not in this enumeration is group-scoped."
     * Location administration is not in that enumeration, so an
     * organization-scoped context must see nothing at all — not "its own
     * organization's rows". The policy's `app.group_id IS NOT NULL` clause is
     * what makes that true, and it is the clause that stops the next nullable
     * group column from being a leak. */
    const visible = await runtime.runner.run(
      {
        organizationId: alpha().organizationId,
        groupId: null,
        membershipId: alpha().users.organizationAdmin.membershipId,
        correlationId: 'locations-org-scope',
      },
      async (uow) => {
        const { rows } = await sql<{ n: number }>`
          select count(*)::int as n from locations
        `.execute(uow.query);
        return Number(rows[0]?.n ?? 0);
      },
    );

    expect(visible, 'an organization-scoped context reads no locations').toBe(0);
    log('organization-scoped context: 0 locations visible');
  });

  it('FALSIFIABILITY: the same probe reports non-zero when told to expect the wrong tenant', async () => {
    /* The arm that proves the probe reads rows at all.
     *
     * Same context, same statement, same counting — only the EXPECTATION is
     * wrong. If the probe were looking at nothing, it would report zero here
     * too, and every "0 wrong" above would be worth nothing. */
    const reading = await readLocations(
      groupContext(
        alpha().organizationId,
        alpha().groupOne.id,
        alpha().full?.groupAdmin.membershipId ?? null,
      ),
      { organizationId: beta().organizationId, groupId: beta().groupOne.id },
    );

    expect(
      reading.wrongOrganization,
      'the probe cannot report a violation — it is reading nothing',
    ).toBeGreaterThan(0);
    expect(reading.wrongGroup, 'likewise for the group dimension').toBeGreaterThan(0);
    log(
      `falsifiability: ${String(reading.wrongOrganization)} wrong-organization / ` +
        `${String(reading.wrongGroup)} wrong-group reported against a deliberately wrong expectation`,
    );
  });
});
