import { randomUUID } from 'node:crypto';

import type { sql as KyselySql } from 'kysely';

/**
 * The settings slice's test fixtures and seeding helpers (OPUS-M3-007).
 *
 * **This file is OPUS-M3-007's alone** for the wave-1 window (packet 32 §10a:
 * "007 creates `test/support/settings.ts`"). It does not touch `multi.ts`,
 * `owned-multi.ts` or `staffing.ts`: `multi.ts` is the single fixture owner and
 * is not this packet's, so the sweep seeding below is invoked BY the calling
 * test file against an already-provisioned fixture rather than by extending the
 * provisioning script — exactly the arrangement OPUS-M3-002 used for `rules`.
 *
 * ## Why the seeding goes through a unit of work rather than a raw owner client
 *
 * `app_guard_location_administration` calls `app_require_capability`, and 0002's
 * guard is **not role-conditional** — it binds the table owner too. A seed
 * written as the owner with a raw client is refused, which is the control
 * working. So the seed runs through the production write path under a
 * capability-holding context, exactly as `provisionMulti` seeds the catalogue.
 *
 * The context must hold `group.location.administer`. A `group_admin` membership
 * does; a `scheduler` membership does **not** — that is the whole point of the
 * doc 08 §6 "Group settings" row — so callers must pass a group administrator.
 *
 * ## Synthetic names only
 *
 * Every fixture string below is constructed from a caller-supplied label. No
 * organization, site or person name from the research appears here, and none may
 * be added: the clean-room boundary applies to fixtures as strictly as to
 * production code.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * The seam the seeding needs
 * ──────────────────────────────────────────────────────────────────────────── */

interface SeedRunner {
  run<T>(
    context: {
      organizationId: string;
      groupId: string | null;
      membershipId: string | null;
      correlationId: string;
    },
    body: (uow: { query: unknown }) => Promise<T>,
  ): Promise<T>;
}

export interface LocationSeedTarget {
  readonly organizationId: string;
  readonly groupId: string;
  /** A membership in that group holding `group.location.administer`. */
  readonly membershipId: string;
  /** Distinguishes the rows written per target — a stray row names its origin. */
  readonly label: string;
  /**
   * An ORGANIZATION membership holding `organization.role.administer`.
   *
   * Optional, and supplied when `membershipId` does not already hold
   * `group.location.administer` by role — which is the ordinary case, because
   * the only role that holds it is `group_admin` and most fixtures' group
   * memberships are schedulers. When present, an explicit layer-4 grant is
   * written first, under an organization-scoped context.
   *
   * That is the product's own mechanism (SPEC-06 L4, doc 08 §4), not a bypass:
   * the seed still goes through the production write path, still through the
   * capability trigger, still under RLS. Changing the membership's ROLE instead
   * would have altered what every other assertion in the calling file is
   * asserting about.
   */
  readonly grantorMembershipId?: string;
}

/**
 * Opens a TEMPORARY `group.location.administer` grant for the seeding, and
 * closes it again the moment the rows are written.
 *
 * ## Why it is closed again, and how that was discovered
 *
 * The first version left the grant open. `corepack pnpm sbx` then reported, in
 * SBX-001's role × registered-surface matrix:
 *
 *     scheduler(G1+G2)  …  GET settings/locations=200  POST settings/locations=422
 *
 * — which is a TRUE statement about that principal (it held an explicit grant)
 * and a badly MISLEADING one about the row it appears on, which is labelled by
 * ROLE. A reviewer reading that matrix would reasonably conclude the scheduler
 * role reaches the locations surface, and doc 08 §6 says it does not. The
 * fixture would have been quietly asserting the opposite of the model.
 *
 * So the grant's window is closed (`valid_to = now()`) as soon as the seed
 * commits. The ROWS persist — the capability trigger fires on INSERT/UPDATE, not
 * on SELECT — so SBX-004 still observes `locations` non-vacuously, and every
 * later probe sees the principal without the capability, which is the truth.
 *
 * ## Two spellings that matter
 *
 * `WHERE NOT EXISTS` rather than `ON CONFLICT DO NOTHING`: `capability_grants`
 * prohibits overlapping windows with an **EXCLUDE** constraint (0002, P-7), and
 * `ON CONFLICT` does not catch exclusion violations.
 *
 * The existence check looks for an **open** grant specifically, so a second
 * seeding run opens a fresh window after the closed one rather than finding the
 * closed row and skipping — which would leave the seed refused by its own guard.
 */
async function withLocationCapability<T>(
  runner: SeedRunner,
  target: LocationSeedTarget,
  body: () => Promise<T>,
): Promise<T> {
  if (target.grantorMembershipId === undefined) return body();

  const asGrantor = async (
    statement: (sql: typeof KyselySql, uow: { query: unknown }) => Promise<void>,
  ) =>
    runner.run(
      {
        organizationId: target.organizationId,
        groupId: null,
        membershipId: target.grantorMembershipId ?? null,
        correlationId: `seed-locations-grant-${target.label}`,
      },
      async (uow) => {
        const { sql } = await import('kysely');
        await statement(sql, uow);
      },
    );

  await asGrantor(async (sql, uow) => {
    await sql`
      insert into capability_grants
        (id, organization_id, group_id, membership_id, capability_key, granted, reason)
      select gen_random_uuid(), ${target.organizationId}::uuid, ${target.groupId}::uuid,
             ${target.membershipId}::uuid, 'group.location.administer', true, 'fixture seeding'
       where not exists (
         select 1 from capability_grants
          where organization_id = ${target.organizationId}::uuid
            and membership_id = ${target.membershipId}::uuid
            and capability_key = 'group.location.administer'
            and (valid_to is null or valid_to > now())
       )
    `.execute(uow.query as never);
  });

  try {
    return await body();
  } finally {
    // Closed even if the seeding threw: a fixture that leaves a live
    // administrative grant behind on a failure path is worse than one that
    // fails, because the next assertion passes for the wrong reason.
    await asGrantor(async (sql, uow) => {
      await sql`
        update capability_grants
           set valid_to = now(), updated_at = now()
         where organization_id = ${target.organizationId}::uuid
           and membership_id = ${target.membershipId}::uuid
           and capability_key = 'group.location.administer'
           and reason = 'fixture seeding'
           and valid_to is null
      `.execute(uow.query as never);
    });
  }
}

/**
 * Writes two locations into each target through the production write path.
 *
 * **Two, not one, and the second one carries a `site_label` while the first does
 * not.** The sweep would be satisfied by any visible row, but the site-migration
 * fixtures need both shapes present to prove anything: a forward transform that
 * only ever sees labelled rows never exercises the NULL branch, and a round trip
 * that never sees a NULL cannot show that NULL survives it.
 *
 * Idempotent (`on conflict do nothing` against the tenant-qualified name key), so
 * a test file that seeds and a battery that seeds again do not fight.
 *
 * Returns the number of rows actually written — 0 on a re-run is correct and
 * expected. Callers assert the TABLE is non-empty rather than trusting this
 * count.
 */
export async function seedLocationsForSweep(
  runner: SeedRunner,
  targets: readonly LocationSeedTarget[],
): Promise<number> {
  let written = 0;

  for (const target of targets) {
    written += await withLocationCapability(runner, target, () =>
      runner.run(
      {
        organizationId: target.organizationId,
        groupId: target.groupId,
        membershipId: target.membershipId,
        correlationId: `seed-locations-${target.label}`,
      },
      async (uow) => {
        const { sql } = await import('kysely');
        const db = uow.query as never;

        const rows = await sql<{ id: string }>`
          insert into locations
            (id, organization_id, group_id, name, site_label, address, timezone)
          values
            (${randomUUID()}::uuid, ${target.organizationId}::uuid, ${target.groupId}::uuid,
             ${`Fixture ward ${target.label}`}, null,
             ${`1 Fixture Way, Unit ${target.label}`}, null),
            (${randomUUID()}::uuid, ${target.organizationId}::uuid, ${target.groupId}::uuid,
             ${`Fixture theatre ${target.label}`}, ${`Fixture campus ${target.label}`},
             null, ${'UTC'})
          on conflict (organization_id, group_id, name) do nothing
          returning id
        `.execute(db);

        return rows.rows.length;
      },
      ),
    );
  }

  return written;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Request bodies
 * ──────────────────────────────────────────────────────────────────────────── */

/** A create-location body. Synthetic, and deliberately without a site label. */
export function locationBody(label: string): Record<string, unknown> {
  return {
    name: `Location ${label}`,
    siteLabel: null,
    address: null,
    timezone: null,
  };
}

/** A create-location body that DOES carry the PO-DEC-01 attribute. */
export function labelledLocationBody(label: string, siteLabel: string): Record<string, unknown> {
  return {
    name: `Location ${label}`,
    siteLabel,
    address: `2 Fixture Road, ${label}`,
    timezone: null,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The site-migration fixture pair (doc 06 §3.2a) — BOTH directions
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One `locations` row, reduced to the fields the migration boundary moves.
 *
 * Deliberately a plain structural type rather than an import of the production
 * row type: the fixtures must keep working when the production shape gains a
 * column that has nothing to do with sites, and coupling them would make an
 * unrelated migration look like a site-migration failure.
 */
export interface SiteFixtureLocation {
  readonly id: string;
  readonly organizationId: string;
  readonly groupId: string;
  readonly name: string;
  readonly siteLabel: string | null;
  readonly address: string | null;
  readonly timezone: string | null;
}

/** A `sites` row as doc 06 §3.2a's forward direction would create it. */
export interface SiteFixtureSite {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
}

/** The state after the forward transform: sites, plus locations carrying a FK. */
export interface SiteFixtureEntityState {
  readonly sites: readonly SiteFixtureSite[];
  /**
   * `siteId` is the new foreign key; `siteLabel` is **retained**, because
   * §3.2a says so: "retain `site_label` for one release as the rollback path;
   * then drop it". A fixture that dropped it immediately would be modelling a
   * migration the document does not describe.
   */
  readonly locations: readonly (SiteFixtureLocation & { readonly siteId: string | null })[];
}

/**
 * Comparable, order-independent form. Used on both ends of the round trip so the
 * equality assertion is about CONTENT rather than about row order, which no
 * transform promises to preserve.
 */
export function canonicalLocations(
  locations: readonly SiteFixtureLocation[],
): readonly SiteFixtureLocation[] {
  return [...locations]
    .map((location) => ({
      id: location.id,
      organizationId: location.organizationId,
      groupId: location.groupId,
      name: location.name,
      siteLabel: location.siteLabel,
      address: location.address,
      timezone: location.timezone,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}
