import { createHash } from 'node:crypto';

import type { UnitOfWork } from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

/**
 * **D-4b — the per-organization concurrency cap** (SPEC-04 §1.1/§6; doc 35 §6g
 * ruling 2).
 *
 * ## Why this exists at all, and why it did not exist before
 *
 * M4-003 was offered the cap and refused it, correctly, as "a counter nothing
 * enforces": a limit with no queue behind it has exactly two possible behaviours
 * at saturation, and both are wrong. It can refuse the build — which turns a
 * resource limit into a lost request and teaches schedulers to resubmit until
 * something sticks — or it can run it anyway, which is not a limit.
 *
 * SPEC-04 §1.1 names the third behaviour and it is the only correct one: **"a
 * saturated pool queues rather than degrading the web tier"**. So the cap lands
 * here WITH the queue binding (`builds/queue.ts`), and saturation is a
 * *deferral* — the build stays `queued`, the job goes back to the queue, and
 * nothing about the request is lost.
 *
 * ## Where the number comes from, and why it is not in the database
 *
 * SPEC-04 §1.1 lists the cap under **Resource isolation**, in the same row as
 * "CPU and memory limits per solve". Those are deployment facts — they describe
 * what the machines running the solver can take, not anything a tenant owns —
 * and a tenant-editable solver concurrency limit would be a tenant-editable
 * claim on shared infrastructure.
 *
 * So the number is deployment configuration. What *did* need a schema surface is
 * the READ: `build_runs` is group-scoped under RLS (0018), so a unit of work
 * opened for one group cannot count an organization's other groups. Migration
 * 0019 adds the policy and the counter, and its header states the case.
 *
 * ## Why the default is 2 rather than 1
 *
 * D-4b's own sentence is "multiple configurations may run concurrently for one
 * period, bounded by a per-organization concurrency cap". A default of 1 would
 * make the thing D-4b permits unreachable out of the box, and D-4c's candidate
 * comparison — which needs two candidates — would then depend on an operator
 * having changed a setting nobody told them about. 2 is the smallest value that
 * admits what the decision permits while still bounding it.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/** The deployment knob. Unset means {@link DEFAULT_MAX_CONCURRENT_BUILDS}. */
export const MAX_CONCURRENT_BUILDS_ENV = 'SP_BUILD_MAX_CONCURRENT_PER_ORG';

export const DEFAULT_MAX_CONCURRENT_BUILDS = 2;

/**
 * The configured cap.
 *
 * A value that is not a positive integer is a **refusal**, not a fallback. A
 * deployment that meant to set `4` and typed `four` would otherwise silently get
 * the default, and the operator would have no way to discover it — the same
 * class of defect as a gate that has only ever been seen passing.
 */
export function maxConcurrentBuildsPerOrganization(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[MAX_CONCURRENT_BUILDS_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CONCURRENT_BUILDS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `${MAX_CONCURRENT_BUILDS_ENV} must be a positive integer; received ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/**
 * The signed 64-bit advisory-lock key for an anchor string.
 *
 * The same derivation as `catalogue/staffing-set-version.ts` and the two
 * authoring routes — sha-256, first eight bytes, SIGNED read, because
 * `pg_advisory_xact_lock(bigint)` overflows on an unsigned one.
 * `apps/api/test/builds/concurrency-recovery-matrix.test.ts` pins this against
 * the staffing derivation on a fixed vector so the two cannot drift.
 */
export function capacityAdvisoryLockKey(anchor: string): bigint {
  return createHash('sha256').update(anchor, 'utf8').digest().readBigInt64BE(0);
}

/**
 * Serialise this organization's capacity decision for the rest of the
 * transaction.
 *
 * Without it the cap is a check-then-act over a count, and two claimants reading
 * `1` against a cap of `2` both proceed to `2` — the classic lost-update shape,
 * and one that no sequential test can see. The lock is per ORGANIZATION, so two
 * tenants never contend, which is the same property S-16t asserts end to end.
 */
export async function lockOrganizationCapacity(uow: Uow): Promise<void> {
  const key = capacityAdvisoryLockKey(
    `sp.build.capacity|${uow.context.organizationId}`,
  ).toString();
  await sql`select pg_advisory_xact_lock(${key}::bigint)`.execute(uow.query);
}

/**
 * How many builds are `running` across every group of this organization.
 *
 * Through migration 0019's `SECURITY DEFINER` counter, which refuses any
 * organization but the one whose tenant context is in force. Counting here in
 * Kysely would return only the current group's rows and would look right.
 */
export async function runningBuildCount(uow: Uow): Promise<number> {
  const result = await sql<{ running: number }>`
    select app_build_running_count(${uow.context.organizationId}::uuid) as running
  `.execute(uow.query);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('BUILD_CAPACITY_COUNT_EMPTY: the capacity counter returned no row');
  }
  return Number(row.running);
}

export interface CapacityVerdict {
  readonly admitted: boolean;
  readonly runningCount: number;
  readonly cap: number;
}

/**
 * Take the capacity decision, inside the caller's transaction.
 *
 * The lock is taken FIRST and is transaction-scoped, so the count and whatever
 * the caller does with it are one atomic decision. A caller that reads the
 * verdict and then commits without claiming simply releases the lock — the cap
 * is not a reservation, it is a gate on the claim that follows it immediately.
 */
export async function admitBuildUnderCap(uow: Uow, cap: number): Promise<CapacityVerdict> {
  await lockOrganizationCapacity(uow);
  const runningCount = await runningBuildCount(uow);
  return { admitted: runningCount < cap, runningCount, cap };
}
