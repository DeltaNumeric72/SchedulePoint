import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import { LocalCheckpointSigner } from '../../src/audit/checkpoint-signer.js';
import { writeCheckpoint } from '../../src/audit/checkpoints.js';
import { recordAuditEvent } from '../../src/audit/recorder.js';
import { provisionAuthorization } from '../../src/authz/provisioning.js';
import * as catalogue from '../../src/catalogue/service.js';
import type { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { publishOutboxEvent } from '../../src/outbox/publisher.js';

/* ────────────────────────────────────────────────────────────────────────────
 * MULTI — the multi-organization fixture, as a FACTORY (FAD-15 Layer 2, and
 * OPUS-M2-001 deliverable C).
 *
 * ## Why this is a factory and not a constant
 *
 * NR-13: 551 tests across 36 files shared ONE seeded fixture, and six tests
 * across five files were measurably order-dependent because of it
 * (`docs/evidence/EV-M2-NR13/`). FAD-15 ruled that the shared baseline becomes
 * read-only and that any file needing to write provisions its own tenant.
 *
 * A file therefore calls `ownedMulti('<slug>')` (see `owned-multi.ts`) and gets
 * a fixture of exactly this shape with **fresh identifiers**. Two files cannot
 * see each other's rows, because RLS says so — not because they agreed not to
 * look. Cleanup is by construction: the cluster is destroyed at the end of the
 * run, and an owned tenant is invisible to every other file's queries meanwhile.
 *
 * ## The shape is defined ONCE
 *
 * `FIXTURE` in `fixtures.ts` — the immutable shared baseline — is built by this
 * same function with fixed identifiers. There is one definition of what a MULTI
 * fixture *is*, which is what makes "the provisioning script is the single
 * fixture owner" true rather than aspirational.
 *
 * ## Two profiles
 *
 * `core` is the six-user / two-organization shape the suite has always used.
 * `full` adds what doc 16 §3 requires of MULTI and the `core` shape lacked:
 * a user for **every** SPEC-06 role, suspended / invited / ended membership
 * cases, and a third organization with `core_scheduling` **not** entitled. The
 * profiles are separate so that adding MULTI's missing dimensions could not
 * silently change a row count an existing test asserts on.
 *
 * ## Synthetic data, and what that means here
 *
 * No real organization, site, or person name appears — not from the research
 * corpus, not from anywhere. Organizations are "Organization Alpha/Beta/Gamma
 * (synthetic)"; people are role-descriptive labels; every email is at
 * `example.invalid`, the RFC 2606 reserved TLD that **cannot** resolve, so no
 * test can reach a real destination even by accident. The slug is in every
 * address because `users_login_email_unique` is GLOBAL (login identity,
 * PO-DEC-06) and two owned fixtures would otherwise collide at 23505.
 *
 * ## Everything is seeded THROUGH the unit of work
 *
 * Not with a superuser, not with RLS disabled. If the wrapper did not work, the
 * fixture would not exist and every test would fail loudly on its first
 * assertion — a far better failure than a green suite built on a fixture that
 * bypassed the thing under test.
 * ──────────────────────────────────────────────────────────────────────────── */

export type MultiProfile = 'core' | 'full';

export interface MultiUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly membershipId: string;
}

export interface MultiGroup {
  readonly id: string;
  readonly name: string;
}

export interface AlphaUsers {
  /**
   * Role `scheduler` in **BOTH** Alpha groups — authorized for the probe
   * capability in each.
   *
   * One principal holding two group memberships is what makes T-01 a real test.
   * With one principal per group, a server that kept a session-global "active
   * group" would still route each request to the only group that principal had,
   * and the test would pass while the CAR-001 defect was present. With ONE
   * principal and TWO declared contexts, a session-global implementation must
   * retarget one of them — and T-01 checks both directions of that.
   */
  readonly scheduler: MultiUser & { readonly groupTwoMembershipId: string };
  /** Group One, role `member` — NOT authorized. T-05b's actor. */
  readonly member: MultiUser;
  /** Group TWO, role `scheduler` — owns the cross-group target for T-05. */
  readonly groupTwoScheduler: MultiUser;
  /** ORGANIZATION membership, role `org_admin`. T-06b's actor. */
  readonly organizationAdmin: MultiUser;
  /** Group One only, no organization membership. T-06c's actor. */
  readonly groupOnly: MultiUser;
  /** Group One, membership `ended`. T-02's actor: a departed member. */
  readonly departed: MultiUser;
}

/** Present only on `profile: 'full'`. The dimensions doc 16 §3 requires. */
export interface FullUsers {
  /** Group One, role `viewer`. */
  readonly viewer: MultiUser;
  /** Group One, role `telecom`. */
  readonly telecom: MultiUser;
  /** Group One, role `group_admin`. */
  readonly groupAdmin: MultiUser;
  /** ORGANIZATION membership, role `org_observer` — a role with no capabilities. */
  readonly organizationObserver: MultiUser;
  /** Group Two, role `scheduler`, membership status `suspended`. */
  readonly suspended: MultiUser;
  /** Group Two, role `scheduler`, membership status `invited`. */
  readonly invited: MultiUser;
  /**
   * The SAME principal as `scheduler`, holding a DIFFERENT role in Group Two.
   * Doc 16 §3's "one user holding different roles per membership", which the
   * `core` shape only satisfies with the same role in both groups.
   */
  readonly dualRole: MultiUser & { readonly groupTwoMembershipId: string };
}

export interface BetaUsers {
  readonly scheduler: MultiUser & { readonly groupTwoMembershipId: string };
  readonly organizationAdmin: MultiUser;
}

export interface GammaUsers {
  readonly organizationAdmin: MultiUser;
  readonly scheduler: MultiUser;
}

export interface MultiOrganization<TUsers> {
  readonly organizationId: string;
  readonly name: string;
  readonly groupOne: MultiGroup;
  readonly groupTwo: MultiGroup;
  readonly users: TUsers;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The OPTIONAL feature rows a fixture can be provisioned with (D-1)
 * ──────────────────────────────────────────────────────────────────────────── */

/** What `seed.catalogue` wrote, per organization. Ids, so a caller asserts by id. */
export interface SeededCatalogue {
  readonly shiftTypeIds: readonly string[];
  readonly shiftGroupId: string;
  readonly staffGroupId: string;
  readonly validGroupId: string;
  readonly holidaySeeded: boolean;
  /** The qualification the requirement edge points at, in THIS group. */
  readonly qualificationId: string;
  /** `shift_type_qualifications` rows written here — the join's non-vacuity. */
  readonly requirementCount: number;
  /**
   * The SIBLING group in the same organization, and what was seeded into it.
   *
   * This exists because of a blocking review finding. The catalogue used to be
   * seeded into ONE group, so the cross-tenant sweep's cross-GROUP arm — "Alpha
   * Group One sees zero rows from Alpha Group Two" — was measuring an empty
   * table. The reviewer proved it: dropping the `group_id` clause from every
   * catalogue policy while keeping the `organization_id` clause (the CAR-001
   * defect class exactly) left all six sweep tests **green**.
   *
   * Both groups now hold catalogue rows, so `wrongGroup` is measurable and the
   * arm can fail. The sweep asserts that measurability directly rather than
   * trusting this comment.
   */
  readonly sibling: {
    readonly groupId: string;
    readonly shiftTypeIds: readonly string[];
    readonly holidaySeeded: boolean;
    readonly qualificationId: string;
    readonly requirementCount: number;
  };
}

/** What `seed.staffing` wrote. Ids, so a caller asserts by id. */
export interface SeededStaffingRows {
  readonly workProfileId: string;
  readonly qualificationId: string;
  readonly holdingId: string;
  readonly grantIds: readonly string[];
}

/**
 * Which optional feature rows `provisionMulti` should write.
 *
 * ## Why this is a request rather than something every fixture gets
 *
 * The D-1 ruling put the catalogue and staffing seeding back inside
 * `provisionMulti`, so `multi.ts` is the single fixture owner again. It did not
 * ask for every fixture in the suite to grow nine catalogue tables and four
 * staffing tables — three files need the catalogue rows and three need the
 * staffing rows, and silently changing what the other twenty-odd owned fixtures
 * contain would change what their assertions are asserting about. The
 * consolidation is about **where the seeding lives**, and it lives here.
 */
export interface MultiSeedOptions {
  /** Organizations to seed a full catalogue into. `[]` or absent seeds none. */
  readonly catalogue?: readonly ('alpha' | 'beta')[];
  /** Seed one work profile, its weekday targets, one qualification and one holding. */
  readonly staffing?: boolean;
}

export interface MultiFixture {
  readonly slug: string;
  readonly profile: MultiProfile;
  readonly alpha: MultiOrganization<AlphaUsers> & { readonly full?: FullUsers };
  readonly beta: MultiOrganization<BetaUsers>;
  /**
   * Present only on `profile: 'full'`. `core_scheduling` is deliberately NOT
   * entitled here, so a test has an entitlement-OFF organization to deny
   * against without having to revoke Alpha's and put it back.
   */
  readonly gamma?: MultiOrganization<GammaUsers>;
  /** Every organization id in this fixture, in a stable order. */
  readonly organizationIds: readonly string[];
  /** Every legitimate `organizationId|groupId` partition in this fixture. */
  readonly partitions: readonly string[];
  /** Present for each organization named in `seed.catalogue`. */
  readonly catalogue?: {
    readonly alpha?: SeededCatalogue;
    readonly beta?: SeededCatalogue;
  };
  /** Present when `seed.staffing` was requested. */
  readonly staffing?: SeededStaffingRows;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Identifier minting
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A UUID derived from the slug and a discriminator.
 *
 * Deterministic WITHIN a run: the same slug yields the same identifiers, so a
 * fixture is stable while the process lives. It is deliberately NOT reproducible
 * ACROSS runs — `RUN_NONCE` sees to that — which is the control described below.
 * The MULTI determinism proof therefore compares CONTENT with identifiers
 * canonicalised away, which is what it always did and is why the nonce does not
 * weaken it.
 *
 * SHA-256 over the whole slug — the same reasoning as `provisioning.ts`'s
 * `derivedUuid`, and the same lesson from S-11: a truncated hash makes two
 * fixtures collide on a primary key, and a primary-key collision is checked
 * ACROSS tenants, so it leaks.
 */
function mint(slug: string, discriminator: string): string {
  // `\u0000` is a DOMAIN SEPARATOR, and it is spelled as an escape on purpose.
  // It was a raw NUL byte, which is load-bearing and invisible: it stops
  // ('a', 'b:c') and ('a:b', 'c') hashing to the same value, and nothing in a
  // slug or discriminator can contain it. A reader could not see it and grep
  // could not find it — an independent review flagged exactly that. It must stay
  // a character no input can produce; do not "tidy" it to ':' or '-'.
  const digest = createHash('sha256').update(`multi:${slug}\u0000${discriminator}`).digest('hex');
  const variant = '89ab'[Number.parseInt(digest[16] ?? '0', 16) % 4] ?? '8';
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

/**
 * A per-RUN secret mixed into every minted identifier (FAD-15 Layer 2 control,
 * added after an independent review).
 *
 * The review wrote into a sibling file's tenant by re-deriving its ids from its
 * slug alone — the slug is in the source, so `mint('audit-chain', ...)` reproduced
 * another file's organization id exactly. RLS did not stop it, and RLS was never
 * going to: RLS scopes a connection to a DECLARED context, it does not decide who
 * may declare which context.
 *
 * So `ownedMulti` mints an UNGUESSABLE effective slug — the declared slug plus
 * this per-run nonce — and provisions under that. A file can still reach another
 * file's tenant if it is HANDED the fixture object, which is ordinary sharing and
 * visible in the imports; it cannot conjure one from the source.
 *
 * **The nonce deliberately does NOT reach `mint` directly.** The BASELINE is
 * built by `buildMultiFixture('baseline', ...)` in TWO processes — `globalSetup`
 * seeds it in Vitest's main process and every test file reads it in a worker —
 * so a per-process nonce inside `mint` gave the two processes different baseline
 * ids and the Layer 1 digest matched nothing. Found by running: 27 files failed
 * with the baseline's rows reported as vanished. Keep `mint` pure; put the
 * unguessability in the slug, which only owned fixtures use.
 *
 * **Exported deliberately, and only for that one consumer.** `owned-multi.ts`
 * needs it to build the effective slug; nothing else may import it, and nothing
 * else does. It is exported rather than passed as a parameter so the value is
 * unmistakably per-RUN rather than per-call — a nonce a caller could supply is a
 * nonce a caller could fix.
 */
export const RUN_NONCE = randomUUID();

/**
 * Every slug provisioned in this run, so a duplicate is a loud error rather than
 * two files silently sharing one tenant. The second registration throws.
 */
const REGISTERED_SLUGS = new Map<string, string>();

export function registerSlug(slug: string, owner: string): void {
  const existing = REGISTERED_SLUGS.get(slug);
  if (existing !== undefined) {
    throw new Error(
      `MULTI slug "${slug}" is already owned by ${existing}; ${owner} asked for it too. ` +
        'Two files sharing a slug share a tenant, which is the coupling FAD-15 Layer 2 exists ' +
        'to remove. Choose a distinct slug.',
    );
  }
  REGISTERED_SLUGS.set(slug, owner);
}

/** A slug no other fixture in this process will use. */
export function randomSlug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function user(slug: string, organization: string, key: string, label: string): MultiUser {
  return {
    id: mint(slug, `${organization}:user:${key}`),
    email: `${slug}-${organization}-${key}@example.invalid`.toLowerCase(),
    displayName: `${label} (synthetic)`,
    membershipId: mint(slug, `${organization}:membership:${key}`),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The shape
 * ──────────────────────────────────────────────────────────────────────────── */

export function buildMultiFixture(slug: string, profile: MultiProfile = 'core'): MultiFixture {
  const alphaOrganizationId = mint(slug, 'alpha:organization');
  const betaOrganizationId = mint(slug, 'beta:organization');
  const gammaOrganizationId = mint(slug, 'gamma:organization');

  const alphaGroupOne = { id: mint(slug, 'alpha:group:one'), name: 'Alpha Group One' };
  const alphaGroupTwo = { id: mint(slug, 'alpha:group:two'), name: 'Alpha Group Two' };
  const betaGroupOne = { id: mint(slug, 'beta:group:one'), name: 'Beta Group One' };
  const betaGroupTwo = { id: mint(slug, 'beta:group:two'), name: 'Beta Group Two' };
  const gammaGroupOne = { id: mint(slug, 'gamma:group:one'), name: 'Gamma Group One' };
  const gammaGroupTwo = { id: mint(slug, 'gamma:group:two'), name: 'Gamma Group Two' };

  const alphaUsers: AlphaUsers = {
    scheduler: {
      ...user(slug, 'alpha', 'scheduler', 'Alpha Scheduler'),
      groupTwoMembershipId: mint(slug, 'alpha:membership:scheduler-group-two'),
    },
    member: user(slug, 'alpha', 'member', 'Alpha Member'),
    groupTwoScheduler: user(slug, 'alpha', 'group-two-scheduler', 'Alpha Group Two Scheduler'),
    organizationAdmin: user(slug, 'alpha', 'org-admin', 'Alpha Organization Admin'),
    groupOnly: user(slug, 'alpha', 'group-only', 'Alpha Group Only'),
    departed: user(slug, 'alpha', 'departed', 'Alpha Departed'),
  };

  const fullUsers: FullUsers | undefined =
    profile === 'full'
      ? {
          viewer: user(slug, 'alpha', 'viewer', 'Alpha Viewer'),
          telecom: user(slug, 'alpha', 'telecom', 'Alpha Telecom'),
          groupAdmin: user(slug, 'alpha', 'group-admin', 'Alpha Group Admin'),
          organizationObserver: user(slug, 'alpha', 'org-observer', 'Alpha Organization Observer'),
          suspended: user(slug, 'alpha', 'suspended', 'Alpha Suspended'),
          invited: user(slug, 'alpha', 'invited', 'Alpha Invited'),
          dualRole: {
            ...user(slug, 'alpha', 'dual-role', 'Alpha Dual Role'),
            groupTwoMembershipId: mint(slug, 'alpha:membership:dual-role-group-two'),
          },
        }
      : undefined;

  const betaUsers: BetaUsers = {
    scheduler: {
      ...user(slug, 'beta', 'scheduler', 'Beta Scheduler'),
      groupTwoMembershipId: mint(slug, 'beta:membership:scheduler-group-two'),
    },
    organizationAdmin: user(slug, 'beta', 'org-admin', 'Beta Organization Admin'),
  };

  const gammaUsers: GammaUsers = {
    organizationAdmin: user(slug, 'gamma', 'org-admin', 'Gamma Organization Admin'),
    scheduler: user(slug, 'gamma', 'scheduler', 'Gamma Scheduler'),
  };

  const organizationIds =
    profile === 'full'
      ? [alphaOrganizationId, betaOrganizationId, gammaOrganizationId]
      : [alphaOrganizationId, betaOrganizationId];

  const partitions = [
    `${alphaOrganizationId}|${alphaGroupOne.id}`,
    `${alphaOrganizationId}|${alphaGroupTwo.id}`,
    `${betaOrganizationId}|${betaGroupOne.id}`,
    `${betaOrganizationId}|${betaGroupTwo.id}`,
    ...(profile === 'full'
      ? [
          `${gammaOrganizationId}|${gammaGroupOne.id}`,
          `${gammaOrganizationId}|${gammaGroupTwo.id}`,
        ]
      : []),
  ];

  return {
    slug,
    profile,
    alpha: {
      organizationId: alphaOrganizationId,
      name: 'Organization Alpha (synthetic)',
      groupOne: alphaGroupOne,
      groupTwo: alphaGroupTwo,
      users: alphaUsers,
      ...(fullUsers === undefined ? {} : { full: fullUsers }),
    },
    beta: {
      organizationId: betaOrganizationId,
      name: 'Organization Beta (synthetic)',
      groupOne: betaGroupOne,
      groupTwo: betaGroupTwo,
      users: betaUsers,
    },
    ...(profile === 'full'
      ? {
          gamma: {
            organizationId: gammaOrganizationId,
            name: 'Organization Gamma (synthetic)',
            groupOne: gammaGroupOne,
            groupTwo: gammaGroupTwo,
            users: gammaUsers,
          },
        }
      : {}),
    organizationIds,
    partitions,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Seeding
 * ──────────────────────────────────────────────────────────────────────────── */

interface SeedGroupMembership {
  readonly membershipId: string;
  readonly userId: string;
  readonly groupId: string;
  readonly role: string;
  readonly status?: 'invited' | 'active' | 'suspended' | 'ended';
}

/**
 * A seeded `capability_grants` row.
 *
 * Every group in the fixture gets exactly one, and that is not decoration: the
 * T-15 storm and the red-case probe both assert that **every** tenant table is
 * observed with at least one visible row, because a probe over an empty table
 * reports "0 wrong" for the most boring possible reason. A `capability_grants`
 * table with no rows would make the isolation claim for it vacuous.
 *
 * The grants are also the ones doc 08 §6 says should exist: `schedule.publish`
 * is a `G` cell — grant-only, never role-implied — so an explicit allow is how a
 * scheduler gets it, and an explicit deny is how a particular person is kept
 * away from it whatever their role (SPEC-06 P-1).
 */
interface SeedGrant {
  readonly grantId: string;
  readonly membershipId: string;
  readonly groupId: string | null;
  readonly capabilityKey: string;
  readonly granted: boolean;
}

interface SeedOrganizationSpec {
  readonly id: string;
  readonly name: string;
  readonly groups: readonly MultiGroup[];
  readonly users: readonly { id: string; email: string; displayName: string }[];
  /** The FIRST of these is the bootstrap administrator. Order matters — see below. */
  readonly organizationMemberships: readonly {
    membershipId: string;
    userId: string;
    role: string;
  }[];
  readonly groupMemberships: readonly SeedGroupMembership[];
  readonly grants: readonly SeedGrant[];
  readonly entitledModules?: readonly {
    readonly moduleKey: 'core_scheduling' | 'organization_administration' | 'entitlements';
    readonly state?: 'trial' | 'active' | 'suspended' | 'revoked';
  }[];
}

async function seedOrganization(
  runner: PgUnitOfWorkRunner,
  organization: SeedOrganizationSpec,
): Promise<void> {
  const bootstrapAdmin = organization.organizationMemberships[0];
  if (bootstrapAdmin === undefined) {
    throw new Error(
      `fixture organization ${organization.id} has no organization membership — since ` +
        'OPUS-M1-002 there is no other way to authorize the rest of the seed',
    );
  }

  /* ────────────────────────────────────────────────────────────────────────
   * PASS 1 — through the provisioning door.
   *
   * `0002_authorization.sql`'s `app_require_capability` waives the capability
   * check for an ORGANIZATION-scoped context in an organization that has **no
   * memberships at all**. That door is the only way a tenant can come into
   * existence, and it shuts the instant the first membership row lands.
   *
   * So everything that needs it goes first, in one transaction, and the first
   * organization membership goes LAST inside that transaction — its BEFORE
   * INSERT trigger runs while `memberships` is still empty, which is the last
   * moment the door is open.
   * ──────────────────────────────────────────────────────────────────────── */
  await runner.run(
    {
      organizationId: organization.id,
      groupId: null,
      membershipId: null,
      correlationId: 'fixture-organization-seed',
    },
    async ({ query }) => {
      await query
        .insertInto('organizations')
        .values({ id: organization.id, name: organization.name })
        .execute();

      await query
        .insertInto('groups')
        .values(
          organization.groups.map((group) => ({
            id: group.id,
            organization_id: organization.id,
            name: group.name,
          })),
        )
        .execute();

      await query
        .insertInto('users')
        .values(
          organization.users.map((u) => ({
            id: u.id,
            login_email: u.email,
            display_name: u.displayName,
          })),
        )
        .execute();

      // Roles, role capabilities, the entitlements and per-group availability.
      // Without these the evaluator denies every request at L1.1 or L4.2 —
      // which is the correct behaviour for an unprovisioned organization and is
      // asserted separately.
      await provisionAuthorization(query, {
        organizationId: organization.id,
        groupIds: organization.groups.map((group) => group.id),
        ...(organization.entitledModules === undefined
          ? {}
          : { entitledModules: organization.entitledModules }),
      });

      await query
        .insertInto('memberships')
        .values({
          id: bootstrapAdmin.membershipId,
          organization_id: organization.id,
          group_id: null,
          user_id: bootstrapAdmin.userId,
          kind: 'organization' as const,
          organization_role: bootstrapAdmin.role,
          group_role: null,
        })
        .execute();
    },
  );

  /* ────────────────────────────────────────────────────────────────────────
   * PASS 2 — the door is shut; everything else is authorized.
   *
   * The acting membership is the bootstrap administrator, whose `org_admin`
   * role carries `organization.membership.administer` through
   * `role_capabilities`. Every membership below is created the way production
   * creates one: an organization-scoped unit of work, an acting membership, and
   * a capability the database checks in a BEFORE INSERT trigger.
   * ──────────────────────────────────────────────────────────────────────── */
  const rest = organization.organizationMemberships.slice(1);

  await runner.run(
    {
      organizationId: organization.id,
      groupId: null,
      membershipId: bootstrapAdmin.membershipId,
      correlationId: 'fixture-organization-seed',
    },
    async ({ query }) => {
      if (rest.length > 0) {
        await query
          .insertInto('memberships')
          .values(
            rest.map((membership) => ({
              id: membership.membershipId,
              organization_id: organization.id,
              group_id: null,
              user_id: membership.userId,
              kind: 'organization' as const,
              organization_role: membership.role,
              group_role: null,
            })),
          )
          .execute();
      }

      if (organization.groupMemberships.length > 0) {
        await query
          .insertInto('memberships')
          .values(
            organization.groupMemberships.map((membership) => ({
              id: membership.membershipId,
              organization_id: organization.id,
              group_id: membership.groupId,
              user_id: membership.userId,
              kind: 'group' as const,
              group_role: membership.role,
              organization_role: null,
              status: membership.status ?? ('active' as const),
            })),
          )
          .execute();
      }

      // Grants come last, because `capability_grants` has a composite FK to
      // `memberships` and the membership must exist first.
      if (organization.grants.length > 0) {
        await query
          .insertInto('capability_grants')
          .values(
            organization.grants.map((grant) => ({
              id: grant.grantId,
              organization_id: organization.id,
              group_id: grant.groupId,
              membership_id: grant.membershipId,
              capability_key: grant.capabilityKey,
              granted: grant.granted,
              granted_by_membership_id: bootstrapAdmin.membershipId,
            })),
          )
          .execute();
      }
    },
  );
}

/** Seeds every organization, group, user, membership and grant of `fixture`. */
export async function seedMultiTenants(
  runner: PgUnitOfWorkRunner,
  fixture: MultiFixture,
): Promise<void> {
  const { slug, alpha, beta, gamma } = fixture;
  const full = alpha.full;

  const alphaCoreUsers = Object.values(alpha.users);
  const alphaFullUsers = full === undefined ? [] : Object.values(full);

  await seedOrganization(runner, {
    id: alpha.organizationId,
    name: alpha.name,
    groups: [alpha.groupOne, alpha.groupTwo],
    users: [...alphaCoreUsers, ...alphaFullUsers].map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
    })),
    organizationMemberships: [
      {
        membershipId: alpha.users.organizationAdmin.membershipId,
        userId: alpha.users.organizationAdmin.id,
        role: 'org_admin',
      },
      ...(full === undefined
        ? []
        : [
            {
              membershipId: full.organizationObserver.membershipId,
              userId: full.organizationObserver.id,
              role: 'org_observer',
            },
          ]),
    ],
    groupMemberships: [
      {
        membershipId: alpha.users.scheduler.membershipId,
        userId: alpha.users.scheduler.id,
        groupId: alpha.groupOne.id,
        role: 'scheduler',
      },
      {
        membershipId: alpha.users.member.membershipId,
        userId: alpha.users.member.id,
        groupId: alpha.groupOne.id,
        role: 'member',
      },
      {
        membershipId: alpha.users.groupOnly.membershipId,
        userId: alpha.users.groupOnly.id,
        groupId: alpha.groupOne.id,
        role: 'scheduler',
      },
      {
        membershipId: alpha.users.departed.membershipId,
        userId: alpha.users.departed.id,
        groupId: alpha.groupOne.id,
        role: 'scheduler',
        status: 'ended',
      },
      {
        membershipId: alpha.users.groupTwoScheduler.membershipId,
        userId: alpha.users.groupTwoScheduler.id,
        groupId: alpha.groupTwo.id,
        role: 'scheduler',
      },
      // The SAME principal as the Group One scheduler above. T-01 depends on it.
      {
        membershipId: alpha.users.scheduler.groupTwoMembershipId,
        userId: alpha.users.scheduler.id,
        groupId: alpha.groupTwo.id,
        role: 'scheduler',
      },
      ...(full === undefined
        ? []
        : [
            {
              membershipId: full.viewer.membershipId,
              userId: full.viewer.id,
              groupId: alpha.groupOne.id,
              role: 'viewer',
            },
            {
              membershipId: full.telecom.membershipId,
              userId: full.telecom.id,
              groupId: alpha.groupOne.id,
              role: 'telecom',
            },
            {
              membershipId: full.groupAdmin.membershipId,
              userId: full.groupAdmin.id,
              groupId: alpha.groupOne.id,
              role: 'group_admin',
            },
            {
              membershipId: full.suspended.membershipId,
              userId: full.suspended.id,
              groupId: alpha.groupTwo.id,
              role: 'scheduler',
              status: 'suspended' as const,
            },
            {
              membershipId: full.invited.membershipId,
              userId: full.invited.id,
              groupId: alpha.groupTwo.id,
              role: 'scheduler',
              status: 'invited' as const,
            },
            // ONE principal, DIFFERENT roles per membership — doc 16 §3.
            {
              membershipId: full.dualRole.membershipId,
              userId: full.dualRole.id,
              groupId: alpha.groupOne.id,
              role: 'group_admin',
            },
            {
              membershipId: full.dualRole.groupTwoMembershipId,
              userId: full.dualRole.id,
              groupId: alpha.groupTwo.id,
              role: 'viewer',
            },
          ]),
    ],
    grants: [
      // One per group, so `capability_grants` is non-vacuous under every group
      // context the storm and the red-case probe use.
      {
        grantId: mint(slug, 'alpha:grant:scheduler-publish'),
        membershipId: alpha.users.scheduler.membershipId,
        groupId: alpha.groupOne.id,
        capabilityKey: 'schedule.publish',
        granted: true,
      },
      {
        grantId: mint(slug, 'alpha:grant:group-two-scheduler-publish'),
        membershipId: alpha.users.groupTwoScheduler.membershipId,
        groupId: alpha.groupTwo.id,
        capabilityKey: 'schedule.publish',
        granted: true,
      },
      // An EXPLICIT DENY on a capability the role already carries. P-1's
      // precedence has a live row to be tested against rather than only a
      // constructed one, and this membership is the one T-05b uses.
      {
        grantId: mint(slug, 'alpha:grant:member-documents-deny'),
        membershipId: alpha.users.member.membershipId,
        groupId: alpha.groupOne.id,
        capabilityKey: 'documents.manage',
        granted: false,
      },
    ],
  });

  await seedOrganization(runner, {
    id: beta.organizationId,
    name: beta.name,
    groups: [beta.groupOne, beta.groupTwo],
    users: Object.values(beta.users).map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
    })),
    organizationMemberships: [
      {
        membershipId: beta.users.organizationAdmin.membershipId,
        userId: beta.users.organizationAdmin.id,
        role: 'org_admin',
      },
    ],
    groupMemberships: [
      {
        membershipId: beta.users.scheduler.membershipId,
        userId: beta.users.scheduler.id,
        groupId: beta.groupOne.id,
        role: 'scheduler',
      },
      // Beta Group Two exists but holds only this one membership, so the
      // group-scoped probe over it is non-vacuous.
      {
        membershipId: beta.users.scheduler.groupTwoMembershipId,
        userId: beta.users.scheduler.id,
        groupId: beta.groupTwo.id,
        role: 'member',
      },
    ],
    grants: [
      {
        grantId: mint(slug, 'beta:grant:scheduler-publish'),
        membershipId: beta.users.scheduler.membershipId,
        groupId: beta.groupOne.id,
        capabilityKey: 'schedule.publish',
        granted: true,
      },
      {
        grantId: mint(slug, 'beta:grant:group-two-deny'),
        membershipId: beta.users.scheduler.groupTwoMembershipId,
        groupId: beta.groupTwo.id,
        capabilityKey: 'schedule.publish',
        granted: false,
      },
    ],
  });

  if (gamma !== undefined) {
    await seedOrganization(runner, {
      id: gamma.organizationId,
      name: gamma.name,
      groups: [gamma.groupOne, gamma.groupTwo],
      users: Object.values(gamma.users).map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
      })),
      organizationMemberships: [
        {
          membershipId: gamma.users.organizationAdmin.membershipId,
          userId: gamma.users.organizationAdmin.id,
          role: 'org_admin',
        },
      ],
      groupMemberships: [
        {
          membershipId: gamma.users.scheduler.membershipId,
          userId: gamma.users.scheduler.id,
          groupId: gamma.groupOne.id,
          role: 'scheduler',
        },
      ],
      grants: [
        {
          grantId: mint(slug, 'gamma:grant:scheduler-publish'),
          membershipId: gamma.users.scheduler.membershipId,
          groupId: gamma.groupOne.id,
          capabilityKey: 'schedule.publish',
          granted: true,
        },
      ],
      // The ENTITLEMENT-OFF organization: administrable, but `core_scheduling`
      // is absent, so every core-scheduling action denies at L1.1 NOT_ENTITLED
      // without any test having to revoke Alpha's entitlement and put it back —
      // which was itself a coupling (`entitlement-in-force` modified Alpha's
      // `entitlements` row in place, measured in EV-M2-NR13).
      entitledModules: [
        { moduleKey: 'organization_administration', state: 'active' },
        { moduleKey: 'entitlements', state: 'active' },
      ],
    });
  }
}

/**
 * Seeds `audit_events`, `outbox_events`, `outbox_effects` and
 * `audit_checkpoints` in **every** organization and **every** group.
 *
 * ## Why the fixture has to do this at all
 *
 * FAD-13 item 3 put migration 0003's four tenant tables into `TENANT_TABLES`,
 * which is what the wrong-tenant probe, the T-15 storm, the pool-cleanliness
 * check and the (role, table) matrix all iterate. **A probe over an empty table
 * reports "0 wrong rows" for the boring reason** — the vacuous pass the whole
 * probe design exists to avoid, and `probe-is-not-vacuous.test.ts` asserts
 * against exactly that.
 *
 * ## Every row here is written by the production path
 *
 * The audit rows come from `recordAuditEvent` after a real `last_active_at`
 * touch, the outbox rows from `publishOutboxEvent`, the checkpoints from
 * `writeCheckpoint`. A fixture that hand-wrote these would seed rows the
 * application could not have produced, and the isolation claim would then be
 * about rows nothing writes.
 *
 * ## Two roles, because the grants say so
 *
 * `app_runtime` may append audit events and publish outbox events.
 * `outbox_effects` and `audit_checkpoints` are `app_worker`'s alone (0003's
 * grants, and SPEC-11 §2's rule that a request path must not be able to sign a
 * checkpoint over a chain it just wrote).
 */
export async function seedMultiAuditAndOutbox(
  runtime: PgUnitOfWorkRunner,
  worker: PgUnitOfWorkRunner,
  fixture: MultiFixture,
): Promise<void> {
  const signer = new LocalCheckpointSigner({ keyId: `fixture-seed-key-${fixture.slug}` });

  const organizations: {
    id: string;
    adminMembershipId: string;
    groups: { id: string; membershipId: string }[];
  }[] = [
    {
      id: fixture.alpha.organizationId,
      adminMembershipId: fixture.alpha.users.organizationAdmin.membershipId,
      groups: [
        { id: fixture.alpha.groupOne.id, membershipId: fixture.alpha.users.scheduler.membershipId },
        {
          id: fixture.alpha.groupTwo.id,
          membershipId: fixture.alpha.users.groupTwoScheduler.membershipId,
        },
      ],
    },
    {
      id: fixture.beta.organizationId,
      adminMembershipId: fixture.beta.users.organizationAdmin.membershipId,
      groups: [
        { id: fixture.beta.groupOne.id, membershipId: fixture.beta.users.scheduler.membershipId },
        {
          id: fixture.beta.groupTwo.id,
          membershipId: fixture.beta.users.scheduler.groupTwoMembershipId,
        },
      ],
    },
  ];

  if (fixture.gamma !== undefined) {
    organizations.push({
      id: fixture.gamma.organizationId,
      adminMembershipId: fixture.gamma.users.organizationAdmin.membershipId,
      groups: [
        { id: fixture.gamma.groupOne.id, membershipId: fixture.gamma.users.scheduler.membershipId },
      ],
    });
  }

  for (const organization of organizations) {
    for (const group of organization.groups) {
      const correlationId = `fixture-audit-${group.id.slice(0, 8)}`;

      const outboxEventId = await runtime.run(
        {
          organizationId: organization.id,
          groupId: group.id,
          membershipId: group.membershipId,
          correlationId,
        },
        async (uow) => {
          await uow.query
            .updateTable('memberships')
            .set({ last_active_at: new Date() })
            .where('id', '=', group.membershipId)
            .execute();

          const recorded = await recordAuditEvent(uow, {
            eventName: 'membership.activity_touched',
            subjectType: 'membership',
            subjectId: group.membershipId,
          });

          const published = await publishOutboxEvent(uow, recorded, {
            kind: 'membership.activity_touched',
            idempotencyKey: `fixture-touch:${fixture.slug}:${String(recorded.sequence)}`,
          });
          return published.id;
        },
      );

      // `outbox_effects` is app_worker's. The effect row IS the effect and its
      // primary key IS the deduplication, so this is the same shape
      // `DatabaseOutboxSink` writes — with the worker's own credential, in the
      // group whose outbox row it belongs to.
      await worker.run(
        { organizationId: organization.id, groupId: group.id, membershipId: null, correlationId },
        async ({ query }) => {
          await sql`
            insert into outbox_effects (
              organization_id, idempotency_key, group_id, outbox_event_id, kind,
              correlation_id, attempt
            ) values (
              ${organization.id}::uuid,
              ${`fixture-effect:${randomUUID()}`},
              ${group.id}::uuid,
              ${outboxEventId}::uuid,
              ${'membership.activity_touched'},
              ${correlationId},
              1
            )
          `.execute(query);
        },
      );
    }

    // An ORGANIZATION-scoped audit row as well as the group ones: `audit_events`
    // has separate group and organization INSERT policies, and the organization
    // one requires `group_id IS NULL`. Seeding only group rows would leave that
    // policy unexercised by every generic probe.
    await runtime.run(
      {
        organizationId: organization.id,
        groupId: null,
        membershipId: organization.adminMembershipId,
        correlationId: 'fixture-audit-org',
      },
      async (uow) => {
        await uow.query
          .updateTable('memberships')
          .set({ last_active_at: new Date() })
          .where('id', '=', organization.adminMembershipId)
          .execute();
        await recordAuditEvent(uow, {
          eventName: 'membership.activity_touched',
          subjectType: 'membership',
          subjectId: organization.adminMembershipId,
        });
      },
    );

    // The checkpoint, last, so it signs a head that already has every row above
    // under it. Organization-scoped by construction — `writeCheckpoint` throws
    // on a group-scoped context, because a group-scoped read sees a subset of
    // the chain and would checkpoint a head that is not the head.
    const written = await worker.run(
      {
        organizationId: organization.id,
        groupId: null,
        membershipId: null,
        correlationId: 'fixture-checkpoint',
      },
      (uow) => writeCheckpoint(uow, signer),
    );
    if (written === null) {
      throw new Error(
        `fixture: no checkpoint was written for ${organization.id} — audit_checkpoints would be ` +
          'empty and every probe over it vacuous',
      );
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The catalogue rows (OPUS-M2-002, consolidated here by the D-1 ruling)
 *
 * ## Why this is here and not in a per-file module
 *
 * It was in `apps/api/test/support/catalogue-fixture.ts`, and that module said
 * so in its own docblock: "**This is a disclosed deviation, not a preference.**
 * The structurally correct home for this is `provisionMulti`." OPUS-M2-002 could
 * not put it here because packet 30 §5 made the MULTI provisioning script
 * read-only shared substrate while OPUS-M2-003 ran in parallel with four tenant
 * tables and the identical problem. Both constraints were real; the tension was
 * escalated as **D-1** and ruled on for this packet. `multi.ts` is the single
 * fixture owner again.
 *
 * ## Why rows have to exist at all
 *
 * Migration 0005 registered nine tenant tables in `TENANT_TABLES`, and three
 * assertions then apply to them immediately, all three demanding **visible
 * rows**: the T-15 storm (`test/tenancy/unit-of-work.test.ts`), the vacuity red
 * case (`test/red-cases/probe-is-not-vacuous.test.ts`), and SBX-004. A probe
 * over an empty table reports "0 wrong" for the most boring possible reason.
 *
 * ## Every row is written by the production path
 *
 * `apps/api/src/catalogue/service.ts`, through a real unit of work, under a
 * group-scoped context whose acting membership holds
 * `schedule.catalogue.administer` by role. A fixture that hand-wrote these would
 * seed rows the application could not have produced, and every isolation claim
 * about them would be a claim about rows nothing writes.
 *
 * ## TWO groups, and why that is the whole point
 *
 * A catalogue seeded into one group makes the cross-GROUP isolation arm vacuous.
 * An independent review proved the consequence by mutating every catalogue
 * policy to drop its `group_id` clause — the CAR-001 defect class — and watching
 * the sweep stay green. Both groups are seeded, and the sweep asserts that the
 * cross-group measurement is capable of being non-zero before it asserts that it
 * is zero.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Synthetic, and deliberately generic: no organization, site or person name. */
const SHIFT_TYPES = [
  {
    code: 'DAY',
    name: 'Day shift',
    startTime: '07:00',
    endTime: '19:00',
    palette: 'indigo' as const,
    onCall: false,
    dailyPick: true,
  },
  {
    code: 'NIGHT',
    name: 'Night shift',
    startTime: '19:00',
    endTime: '07:00',
    palette: 'violet' as const,
    onCall: true,
    dailyPick: true,
  },
];

async function seedCatalogue(
  runtime: PgUnitOfWorkRunner,
  fixture: MultiFixture,
  which: 'alpha' | 'beta',
): Promise<SeededCatalogue> {
  // Beta has the same shape for everything this seeder needs — an organization
  // administrator and a Group One scheduler — which is what lets the isolation
  // sweep populate BOTH tenants and mean something. A sweep over a tenant whose
  // neighbour has no catalogue rows proves nothing about catalogue isolation.
  const target =
    which === 'alpha'
      ? fixture.alpha
      : {
          organizationId: fixture.beta.organizationId,
          groupOne: fixture.beta.groupOne,
          users: {
            scheduler: fixture.beta.users.scheduler,
            organizationAdmin: fixture.beta.users.organizationAdmin,
          },
        };

  /* The SIBLING group in the same organization, and a membership inside it.
   *
   * Alpha's is `groupTwoScheduler`, whose group role already carries the
   * catalogue key. Beta's Group Two membership holds the `member` role, which
   * carries nothing — so it is granted the key below, by the organization
   * administrator, exactly as production would. The administrator and the target
   * are different USERS, so `app_guard_capability_grant_administration`'s
   * two-person rule is satisfied rather than worked around. */
  const sibling =
    which === 'alpha'
      ? {
          groupId: fixture.alpha.groupTwo.id,
          membershipId: fixture.alpha.users.groupTwoScheduler.membershipId,
        }
      : {
          groupId: fixture.beta.groupTwo.id,
          membershipId: fixture.beta.users.scheduler.groupTwoMembershipId,
        };

  // `scheduler` in Group One holds `schedule.catalogue.administer` by role
  // (doc 08 §6 "Author catalogue & rules"). Every MULTI profile has one.
  const authorContext = {
    organizationId: target.organizationId,
    groupId: target.groupOne.id,
    membershipId: target.users.scheduler.membershipId,
    correlationId: `catalogue-fixture-${fixture.slug}`,
  };

  const shiftTypeIds: string[] = [];
  let shiftGroupId = '';
  let staffGroupId = '';
  let validGroupId = '';

  await runtime.run(authorContext, async (uow) => {
    for (const definition of SHIFT_TYPES) {
      const created = await catalogue.createShiftType(uow, {
        code: definition.code,
        name: definition.name,
        description: null,
        displayPaletteKey: definition.palette,
        displayTextStyle: 'regular',
        startTime: definition.startTime,
        endTime: definition.endTime,
        isOnCall: definition.onCall,
        attractsStipend: definition.onCall,
        isManualOnly: false,
        isDailyPick: definition.dailyPick,
        includeInStatistics: true,
        isLeaveOfAbsence: false,
        allowOnRequest: true,
        allowOffRequest: true,
        reportOrder: shiftTypeIds.length,
        creditWeight: 1,
      });
      if (created.kind !== 'ok') {
        throw new Error(
          `catalogue fixture: creating shift type ${definition.code} reported ${created.kind}`,
        );
      }
      shiftTypeIds.push(created.value.shiftTypeId);

      // `shift_type_weekday_demand` needs rows of its own, or the probe over it
      // is the vacuous one this seeding exists to prevent.
      const demand = await catalogue.setWeekdayDemand(uow, created.value.shiftTypeId, {
        demand: [
          { day: 'mon', demandCount: 2 },
          { day: 'sat', demandCount: 1 },
          { day: 'holiday', demandCount: 1 },
        ],
      });
      if (demand.kind !== 'ok') {
        throw new Error(`catalogue fixture: setting demand reported ${demand.kind}`);
      }
    }

    const shiftGroup = await catalogue.createShiftGroup(uow, {
      name: 'On-call bundle',
      description: null,
      scoring: { scoringMode: 'weighted', weight: 1000 },
      request: { allowRequest: true, requestOffLabel: 'Request off all on-call shifts' },
      shiftTypeIds,
    });
    if (shiftGroup.kind !== 'ok') {
      throw new Error(`catalogue fixture: creating a shift group reported ${shiftGroup.kind}`);
    }
    shiftGroupId = shiftGroup.value.shiftGroupId;

    const staffGroup = await catalogue.createStaffGroup(uow, {
      name: 'Theatre-eligible pool',
      description: null,
      // The acting scheduler's own membership: visible in this group by
      // construction, so the visibility check has something real to pass.
      membershipIds: [target.users.scheduler.membershipId],
    });
    if (staffGroup.kind !== 'ok') {
      throw new Error(`catalogue fixture: creating a staff group reported ${staffGroup.kind}`);
    }
    staffGroupId = staffGroup.value.staffGroupId;
  });

  /* ── the two group-SETTINGS keys, reached the way production reaches them ───
   *
   * `group.holiday_calendar.administer` and `group.pick_positions.administer`
   * are group-administrator keys (doc 08 §6 "Group settings"), and the `core`
   * MULTI profile provisions no group administrator. Rather than seed only on
   * the `full` profile — which would leave `group_holidays` with no rows and the
   * non-vacuity assertions failing on every other file — the fixture GRANTS the
   * two keys to the scheduler's membership through `capability_grants`, which is
   * the production mechanism for exactly this (SPEC-06 L4.2).
   *
   * It is written under an ORGANIZATION-scoped context by the organization
   * administrator, because `capability_grants_organization_administration`
   * requires both. The administrator and the scheduler are different USERS, so
   * `app_guard_capability_grant_administration`'s two-person rule is satisfied
   * rather than worked around. */
  /* `staffing.qualification.administer` is grant-only and is needed for one
   * statement per group: the qualification the requirement edge points at.
   * Collected separately from the two catalogue-settings keys above because it
   * is CLOSED again below — for the reason `seedStaffing` closes its own:
   * SBX-001 sends `{}` to every registered route as every role-bearing
   * principal, and a principal left holding a staffing key would answer the
   * profiles routes with a body error rather than the clean deny that matrix's
   * oracle models. Weakening the oracle to fit the fixture would be weakening a
   * control to fit new code. */
  const qualificationGrantIds = [randomUUID(), randomUUID()];

  await runtime.run(
    {
      organizationId: target.organizationId,
      groupId: null,
      membershipId: target.users.organizationAdmin.membershipId,
      correlationId: `catalogue-fixture-grant-${fixture.slug}`,
    },
    async ({ query }) => {
      await query
        .insertInto('capability_grants')
        .values([
          {
            id: qualificationGrantIds[0] as string,
            organization_id: target.organizationId,
            group_id: target.groupOne.id,
            membership_id: target.users.scheduler.membershipId,
            capability_key: 'staffing.qualification.administer',
            granted: true,
            granted_by_membership_id: target.users.organizationAdmin.membershipId,
          },
          {
            id: qualificationGrantIds[1] as string,
            organization_id: target.organizationId,
            group_id: sibling.groupId,
            membership_id: sibling.membershipId,
            capability_key: 'staffing.qualification.administer',
            granted: true,
            granted_by_membership_id: target.users.organizationAdmin.membershipId,
          },
          ...['group.holiday_calendar.administer', 'group.pick_positions.administer'].map(
            (key) => ({
              id: randomUUID(),
              organization_id: target.organizationId,
              group_id: target.groupOne.id,
              membership_id: target.users.scheduler.membershipId,
              capability_key: key,
              granted: true,
              granted_by_membership_id: target.users.organizationAdmin.membershipId,
            }),
          ),
          // The SIBLING group's author. Granted rather than assumed: Beta's
          // Group Two membership holds `member`, which carries nothing, and a
          // fixture that only worked on Alpha would leave Beta's cross-group arm
          // as vacuous as Alpha's used to be.
          ...['schedule.catalogue.administer', 'group.holiday_calendar.administer'].map((key) => ({
            id: randomUUID(),
            organization_id: target.organizationId,
            group_id: sibling.groupId,
            membership_id: sibling.membershipId,
            capability_key: key,
            granted: true,
            granted_by_membership_id: target.users.organizationAdmin.membershipId,
          })),
        ])
        .execute();
    },
  );

  let holidaySeeded = false;

  await runtime.run(authorContext, async (uow) => {
    const raised = await catalogue.setPickPositionCount(uow, 4);
    if (raised.kind !== 'ok') {
      throw new Error(`catalogue fixture: raising pick positions reported ${raised.kind}`);
    }

    const holiday = await catalogue.createGroupHoliday(uow, {
      // A fixed, obviously synthetic date. No real calendar is implied.
      holidayDate: '2027-01-01',
      name: 'Synthetic public holiday',
      observed: true,
    });
    if (holiday.kind !== 'ok') {
      throw new Error(`catalogue fixture: creating a holiday reported ${holiday.kind}`);
    }
    holidaySeeded = true;
  });

  // `valid_groups` and `valid_group_shift_types` come last: the trigger checks
  // each position against the group's ceiling, so the ceiling has to be raised
  // before positions above zero are legal.
  await runtime.run(authorContext, async (uow) => {
    const validGroup = await catalogue.createValidGroup(uow, {
      name: 'Call with picks',
      shiftTypeIds,
      allowedPickPositions: [1, 2, 3],
    });
    if (validGroup.kind !== 'ok') {
      throw new Error(`catalogue fixture: creating a valid group reported ${validGroup.kind}`);
    }
    validGroupId = validGroup.value.validGroupId;
  });

  /* ── the requirement edge (`shift_type_qualifications`, migration 0006) ────
   *
   * Registered in `TENANT_TABLES`, so every generic probe iterates it and every
   * one of them requires the table to be observed with a VISIBLE row. Written in
   * BOTH groups below, so the cross-GROUP arm of the isolation sweep has
   * something it could see if the group predicate were broken — not only the
   * cross-organization arm.
   *
   * The qualification is inserted directly, the requirement through the
   * production service: `qualifications` belongs to OPUS-M2-003's slice and its
   * authoring service takes a different shape, while the requirement edge is
   * this task's and must be written the way the route writes it. */
  const qualificationId = randomUUID();
  let requirementCount = 0;

  await runtime.run(authorContext, async (uow) => {
    await uow.query
      .insertInto('qualifications')
      .values({
        id: qualificationId,
        organization_id: target.organizationId,
        group_id: target.groupOne.id,
        key: 'catalogue-required-credential',
        name: 'Catalogue-required credential',
        requires_expiry: false,
      })
      .execute();

    const requirements = await catalogue.setShiftTypeQualifications(uow, shiftTypeIds[0] as string, {
      qualificationIds: [qualificationId],
    });
    if (requirements.kind !== 'ok') {
      throw new Error(`catalogue fixture: setting requirements reported ${requirements.kind}`);
    }
    requirementCount = requirements.value.requirements.length;
  });

  /* ── the SIBLING group ───────────────────────────────────────────────────
   *
   * Enough of a catalogue for the cross-GROUP arm of the isolation sweep to have
   * something it could see if the group predicate were broken. Every one of the
   * nine tables gets a row here too, so the arm is non-vacuous per table rather
   * than only in aggregate. */
  const siblingContext = {
    organizationId: target.organizationId,
    groupId: sibling.groupId,
    membershipId: sibling.membershipId,
    correlationId: `catalogue-fixture-sibling-${fixture.slug}`,
  };

  const siblingShiftTypeIds: string[] = [];
  let siblingHolidaySeeded = false;
  const siblingQualificationId = randomUUID();
  let siblingRequirementCount = 0;

  await runtime.run(siblingContext, async (uow) => {
    for (const definition of SHIFT_TYPES) {
      const created = await catalogue.createShiftType(uow, {
        code: definition.code,
        name: `${definition.name} (sibling group)`,
        description: null,
        displayPaletteKey: definition.palette,
        displayTextStyle: 'regular',
        startTime: definition.startTime,
        endTime: definition.endTime,
        isOnCall: definition.onCall,
        attractsStipend: false,
        isManualOnly: false,
        isDailyPick: definition.dailyPick,
        includeInStatistics: true,
        isLeaveOfAbsence: false,
        allowOnRequest: false,
        allowOffRequest: false,
        reportOrder: siblingShiftTypeIds.length,
        creditWeight: 1,
      });
      if (created.kind !== 'ok') {
        throw new Error(`catalogue fixture (sibling): shift type reported ${created.kind}`);
      }
      siblingShiftTypeIds.push(created.value.shiftTypeId);

      const demand = await catalogue.setWeekdayDemand(uow, created.value.shiftTypeId, {
        demand: [
          { day: 'tue', demandCount: 1 },
          { day: 'holiday', demandCount: 2 },
        ],
      });
      if (demand.kind !== 'ok') {
        throw new Error(`catalogue fixture (sibling): demand reported ${demand.kind}`);
      }
    }

    const siblingShiftGroup = await catalogue.createShiftGroup(uow, {
      name: 'Sibling-group bundle',
      description: null,
      scoring: { scoringMode: 'hard' },
      request: { allowRequest: false },
      shiftTypeIds: siblingShiftTypeIds,
    });
    if (siblingShiftGroup.kind !== 'ok') {
      throw new Error(`catalogue fixture (sibling): shift group reported ${siblingShiftGroup.kind}`);
    }

    const siblingStaffGroup = await catalogue.createStaffGroup(uow, {
      name: 'Sibling-group pool',
      description: null,
      membershipIds: [sibling.membershipId],
    });
    if (siblingStaffGroup.kind !== 'ok') {
      throw new Error(`catalogue fixture (sibling): staff group reported ${siblingStaffGroup.kind}`);
    }

    // The sibling group's own ceiling is 0, so an empty position set is the only
    // legal one — which is still a row, which is all the sweep needs.
    const siblingValidGroup = await catalogue.createValidGroup(uow, {
      name: 'Sibling-group combination',
      shiftTypeIds: siblingShiftTypeIds,
      allowedPickPositions: [],
    });
    if (siblingValidGroup.kind !== 'ok') {
      throw new Error(`catalogue fixture (sibling): valid group reported ${siblingValidGroup.kind}`);
    }

    const siblingHoliday = await catalogue.createGroupHoliday(uow, {
      holidayDate: '2027-02-02',
      name: 'Synthetic sibling-group holiday',
      observed: false,
    });
    if (siblingHoliday.kind !== 'ok') {
      throw new Error(`catalogue fixture (sibling): holiday reported ${siblingHoliday.kind}`);
    }
    siblingHolidaySeeded = true;

    await uow.query
      .insertInto('qualifications')
      .values({
        id: siblingQualificationId,
        organization_id: target.organizationId,
        group_id: sibling.groupId,
        key: 'catalogue-required-credential',
        name: 'Catalogue-required credential (sibling group)',
        requires_expiry: false,
      })
      .execute();

    const siblingRequirements = await catalogue.setShiftTypeQualifications(
      uow,
      siblingShiftTypeIds[0] as string,
      { qualificationIds: [siblingQualificationId] },
    );
    if (siblingRequirements.kind !== 'ok') {
      throw new Error(
        `catalogue fixture (sibling): requirements reported ${siblingRequirements.kind}`,
      );
    }
    siblingRequirementCount = siblingRequirements.value.requirements.length;
  });

  /* The two qualification-vocabulary grants are CLOSED again — see where they
   * were written for why. No runtime role holds DELETE on `capability_grants`
   * (a capability is taken away by an auditable `granted = false`), so the
   * window closes rather than the row disappearing, and it closes BY ROW ID
   * (FAD-15 as corrected, E-01). */
  await runtime.run(
    {
      organizationId: target.organizationId,
      groupId: null,
      membershipId: target.users.organizationAdmin.membershipId,
      correlationId: `catalogue-fixture-grant-close-${fixture.slug}`,
    },
    async ({ query }) => {
      await query
        .updateTable('capability_grants')
        .set({ granted: false })
        .where('organization_id', '=', target.organizationId)
        .where('id', 'in', qualificationGrantIds)
        .execute();
    },
  );

  if (shiftGroupId === '' || staffGroupId === '' || validGroupId === '') {
    throw new Error('catalogue fixture: a seeded id was never assigned');
  }
  if (siblingShiftTypeIds.length === 0) {
    throw new Error(
      'catalogue fixture: the sibling group received no rows — the cross-group isolation arm ' +
        'would be vacuous, which is the finding this seeding exists to close',
    );
  }
  if (requirementCount === 0 || siblingRequirementCount === 0) {
    throw new Error(
      'catalogue fixture: `shift_type_qualifications` received no rows in one of the two ' +
        'groups — every probe over it would then report "0 wrong" for the boring reason',
    );
  }

  return {
    shiftTypeIds,
    shiftGroupId,
    staffGroupId,
    validGroupId,
    holidaySeeded,
    qualificationId,
    requirementCount,
    sibling: {
      groupId: sibling.groupId,
      shiftTypeIds: siblingShiftTypeIds,
      holidaySeeded: siblingHolidaySeeded,
      qualificationId: siblingQualificationId,
      requirementCount: siblingRequirementCount,
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The staffing rows (OPUS-M2-003, consolidated here by the D-1 ruling)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Grants capabilities to a GROUP membership, through the production path.
 *
 * The acting context is the organization administrator, because
 * `app_guard_capability_grant_administration` requires
 * `organization.role.administer` under an organization-scoped context and refuses
 * a grant written for any membership belonging to the acting PRINCIPAL. Both
 * rules are load-bearing and neither is worked around here.
 *
 * Kept in `staffing.ts` as the exported helper tests call directly; this is the
 * copy `provisionMulti` uses, so the seeding has no dependency on a module that
 * exists for the tests' convenience.
 */
async function grantThroughAdministrator(
  runtime: PgUnitOfWorkRunner,
  organizationAdminMembershipId: string,
  options: {
    readonly organizationId: string;
    readonly groupId: string;
    readonly membershipId: string;
    readonly capabilities: readonly string[];
    readonly granted?: boolean;
  },
): Promise<readonly string[]> {
  const grantIds: string[] = [];
  await runtime.run(
    {
      organizationId: options.organizationId,
      groupId: null,
      membershipId: organizationAdminMembershipId,
      correlationId: 'staffing-grant',
    },
    async ({ query }) => {
      for (const capabilityKey of options.capabilities) {
        const id = randomUUID();
        grantIds.push(id);
        await query
          .insertInto('capability_grants')
          .values({
            id,
            organization_id: options.organizationId,
            group_id: options.groupId,
            membership_id: options.membershipId,
            capability_key: capabilityKey,
            granted: options.granted ?? true,
          })
          .execute();
      }
    },
  );
  return grantIds;
}

/**
 * Seeds one work profile, its weekday targets, one qualification and one holding
 * into Alpha's group one — enough that every staffing tenant table is **observed
 * with visible rows** by the SBX-004 sweep (packet 30 §7.2).
 *
 * The holding is issued to Alpha's `scheduler` membership on purpose: the sweep's
 * `runtime/group-one` probe acts as that membership, and `qualification_holdings`
 * has no organization-wide read policy — it is `SENSITIVE-PII` — so a holding
 * belonging to anybody else would be invisible to every probe context and the
 * table would report a vacuous zero.
 */
async function seedStaffing(
  runtime: PgUnitOfWorkRunner,
  fixture: MultiFixture,
): Promise<SeededStaffingRows> {
  const alpha = fixture.alpha;
  const groupId = alpha.groupOne.id;
  const actor = alpha.users.groupOnly.membershipId;
  const subject = alpha.users.scheduler.membershipId;

  // The actor is `groupOnly`, whose principal holds no other membership — so the
  // two-person rule the grant guard enforces is satisfied without contrivance.
  const grantIds = await grantThroughAdministrator(
    runtime,
    alpha.users.organizationAdmin.membershipId,
    {
      organizationId: alpha.organizationId,
      groupId,
      membershipId: actor,
      capabilities: [
        'staffing.work_profile.administer',
        'staffing.qualification.administer',
        'staffing.qualification_holding.administer',
      ],
    },
  );

  const workProfileId = randomUUID();
  const qualificationId = randomUUID();
  const holdingId = randomUUID();

  await runtime.run(
    {
      organizationId: alpha.organizationId,
      groupId,
      membershipId: actor,
      correlationId: 'staffing-seed',
    },
    async ({ query }) => {
      await query
        .insertInto('membership_work_profiles')
        .values({
          id: workProfileId,
          organization_id: alpha.organizationId,
          group_id: groupId,
          membership_id: subject,
          work_percentage: '80.00',
          max_assignments_per_week: 4,
        })
        .execute();

      await query
        .insertInto('membership_weekday_fte')
        .values(
          (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'holiday'] as const).map((day) => ({
            id: randomUUID(),
            organization_id: alpha.organizationId,
            group_id: groupId,
            work_profile_id: workProfileId,
            day,
            fte_fraction: day === 'sat' || day === 'sun' || day === 'holiday' ? '0.000' : '0.800',
          })),
        )
        .execute();

      await query
        .insertInto('qualifications')
        .values({
          id: qualificationId,
          organization_id: alpha.organizationId,
          group_id: groupId,
          key: 'advanced-life-support',
          name: 'Advanced Life Support',
          requires_expiry: true,
          issuing_body: 'Synthetic Certifying Body',
        })
        .execute();

      await query
        .insertInto('qualification_holdings')
        .values({
          id: holdingId,
          organization_id: alpha.organizationId,
          group_id: groupId,
          membership_id: subject,
          qualification_id: qualificationId,
          valid_until: new Date('2030-01-01T00:00:00.000Z'),
          evidence_ref: 'SYNTH-REF-0001',
          status: 'valid',
        })
        .execute();
    },
  );

  /* ── the seeding grants are CLOSED again, deliberately ────────────────────
   *
   * SBX-001 attempts every registered route as every role-bearing principal in
   * MULTI with an empty body, and requires each cell to be an explicit allow, a
   * clean deny, or a declared context refusal. `groupOnly` is one of those
   * principals, so leaving it holding `staffing.work_profile.administer` would
   * make its cell a `400 …_BODY_MALFORMED` — correct behaviour for an authorized
   * caller who sent nothing, and a state the matrix's oracle does not model.
   *
   * Weakening the oracle to accept a fourth class would be weakening a control to
   * fit new code (non-bypass rule 10). Closing the grants instead leaves the rows
   * in place for SBX-004's non-vacuity check while every SBX-001 cell on these
   * routes is a clean deny, which is exactly what the matrix is for. The allow
   * side is proven in `apps/api/test/profiles/authorization.test.ts`, per
   * capability, against a body that is not empty.
   *
   * No runtime role holds DELETE on `capability_grants` (0002, deliberately: a
   * capability is taken away by an auditable `granted = false`), so the window is
   * closed rather than the row removed — and by ROW ID, never by predicate
   * (FAD-15 as corrected, E-01). */
  await runtime.run(
    {
      organizationId: alpha.organizationId,
      groupId: null,
      membershipId: alpha.users.organizationAdmin.membershipId,
      correlationId: 'staffing-grant-revoke',
    },
    async ({ query }) => {
      await query
        .updateTable('capability_grants')
        .set({ granted: false })
        .where('organization_id', '=', alpha.organizationId)
        .where('id', 'in', [...grantIds])
        .execute();
    },
  );

  return { workProfileId, qualificationId, holdingId, grantIds };
}

/**
 * Build, seed and return one complete MULTI fixture.
 *
 * `seed` selects the optional feature rows — see `MultiSeedOptions` for why they
 * are optional rather than universal. The order is deliberate and matches what
 * the three files that need both did by hand before the D-1 consolidation:
 * staffing first, then the catalogue.
 */
export async function provisionMulti(
  runtime: PgUnitOfWorkRunner,
  worker: PgUnitOfWorkRunner,
  slug: string,
  profile: MultiProfile = 'core',
  seed: MultiSeedOptions = {},
): Promise<MultiFixture> {
  const fixture = buildMultiFixture(slug, profile);
  await seedMultiTenants(runtime, fixture);
  await seedMultiAuditAndOutbox(runtime, worker, fixture);

  const staffing = seed.staffing === true ? await seedStaffing(runtime, fixture) : undefined;

  const catalogueSeeds: { alpha?: SeededCatalogue; beta?: SeededCatalogue } = {};
  for (const which of seed.catalogue ?? []) {
    catalogueSeeds[which] = await seedCatalogue(runtime, fixture, which);
  }

  return {
    ...fixture,
    ...(staffing === undefined ? {} : { staffing }),
    ...(Object.keys(catalogueSeeds).length === 0 ? {} : { catalogue: catalogueSeeds }),
  };
}
