import { createHash } from 'node:crypto';

import type { UnitOfWork } from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

/**
 * The aggregate compare-and-set behind every whole-set staffing editor
 * (OPUS-M4-000A; doc 34 §4-A/§4-B; `staffing_set_versions`, migration 0012).
 *
 * ## The shape, and where each half lives
 *
 *   database   `staffing_set_versions` — one DB-owned counter per aggregate,
 *              bumped by the content tables' triggers. The application holds
 *              no write grant on it: FAD-24's `settings_version` terms.
 *   here       serialize-then-compare. A tenant-qualified transaction-scoped
 *              advisory lock is taken FIRST, then the counter is read, then
 *              the caller's `expectedVersion` is compared. Stale → an explicit
 *              refusal carrying the current version; never a merge.
 *
 * ## Why the lock is not optional
 *
 * The M3-004 lesson, measured: every unit of work is READ COMMITTED, and an
 * unlocked compare-and-set read gives no protection at all — two writers read
 * the same pre-state, both find their token current, and both write, which for
 * a whole-set replacement produces exactly the UNION the packet forbids. The
 * lock serializes writers on ONE aggregate; the loser's post-lock read (a
 * fresh READ COMMITTED snapshot) sees the winner's committed bump and is
 * refused. One lock per transaction, taken after the authorization verdict,
 * released by COMMIT/ROLLBACK — no unlock path to forget.
 *
 * ## An absent counter row IS version 1
 *
 * The counter is created lazily by the first content write's trigger, so a
 * set that has never been written presents `ABSENT_SET_VERSION`. Two writers
 * racing on a never-written aggregate both pass the compare at 1 — and are
 * still serialized by the lock, so the second replays its diff against the
 * first's committed state: identical sets no-op cleanly, different sets are
 * caught because the first CHANGED content, which bumped the counter past 1.
 */

export type StaffingSetScope =
  | 'weekday_demand'
  | 'period_requirements'
  | 'qualification_requirements';

/** What a never-written aggregate presents. */
export const ABSENT_SET_VERSION = 1;

type Uow = UnitOfWork<Kysely<Database>>;

/**
 * The signed 64-bit advisory-lock key for an anchor string.
 *
 * The same derivation as the schedule authoring surface's `advisoryLockKey`
 * (sha-256, first eight bytes, SIGNED read — `pg_advisory_xact_lock(bigint)`
 * overflows on an unsigned reading). Restated here rather than imported
 * because the one existing implementation lives in a route module, and a
 * service that imports a route inverts the only layering `apps/api` has.
 * `apps/api/test/catalogue/demand-replacement.test.ts` asserts the two
 * derivations agree on a fixed vector, so they cannot drift silently.
 */
export function staffingAdvisoryLockKey(anchor: string): bigint {
  return createHash('sha256').update(anchor, 'utf8').digest().readBigInt64BE(0);
}

export type StaffingSetAcquisition =
  | { readonly kind: 'acquired'; readonly version: number }
  | { readonly kind: 'stale'; readonly currentVersion: number };

/** Read the aggregate's current version — an absent row reads as 1. */
export async function readStaffingSetVersion(
  uow: Uow,
  scope: StaffingSetScope,
  scopeId: string,
): Promise<number> {
  const rows = (await uow.query
    .selectFrom('staffing_set_versions')
    .select('version')
    .where('scope', '=', scope)
    .where('scope_id', '=', scopeId)
    .execute()) as unknown as { version: number }[];
  return rows[0]?.version ?? ABSENT_SET_VERSION;
}

/**
 * Serialize on the aggregate, then compare.
 *
 * Called as the FIRST statement of every whole-set replacement, before any
 * read the diff will be computed from — so the state the diff sees is state no
 * concurrent replacement can be mutating.
 */
export async function acquireStaffingSet(
  uow: Uow,
  scope: StaffingSetScope,
  scopeId: string,
  expectedVersion: number,
): Promise<StaffingSetAcquisition> {
  // TENANT-QUALIFIED: advisory locks are per-database, and two groups editing
  // "the same" shift type id (impossible today, cheap to be safe about) must
  // not contend by accident.
  const key = staffingAdvisoryLockKey(
    `${uow.context.organizationId}|${uow.context.groupId ?? ''}|staffing-set:${scope}:${scopeId}`,
  ).toString();
  await sql`select pg_advisory_xact_lock(${key}::bigint)`.execute(uow.query);

  const version = await readStaffingSetVersion(uow, scope, scopeId);
  if (version !== expectedVersion) return { kind: 'stale', currentVersion: version };
  return { kind: 'acquired', version };
}
