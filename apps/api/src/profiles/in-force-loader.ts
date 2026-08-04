import {
  nextWindowStart,
  requireInForce,
  selectInForce,
  type EffectiveDated,
  type InForceSelection,
} from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

/**
 * **The only module in this codebase that selects from an effective-dated
 * staffing table.**
 *
 * That is a rule, not a description, and it is checked:
 * `apps/api/test/profiles/loader-is-the-only-selector.test.ts` walks `src/` and
 * fails if any other module names `membership_work_profiles`,
 * `membership_weekday_fte` or `qualification_holdings` in a query. The test has
 * its own red case, because a scanner that has only ever been observed passing is
 * not evidence of anything (the `tenant-access-scan.ts` lesson).
 *
 * ## Why the rule is worth a test
 *
 * `docs/evidence/EV-M1-AUTHZ` finding S-01. The entitlement loader and the
 * entitlement *writer* each selected effective-dated rows their own way; the
 * reader took an arbitrary row and the writer updated all of them. Neither was
 * obviously wrong at its own call site, and the two only disagreed for tenants
 * that had ever re-windowed an entitlement — which is why it survived to an
 * independent review rather than to a unit test.
 *
 * One selector means the reader and the writer's precondition are **the same
 * function call on the same rows**, so "the row the writer superseded" and "the
 * row the reader returns" are not two questions that could get two answers.
 *
 * ## The handle, not the runner (FAD-12)
 *
 * Every function here takes a `Kysely` handle. A function that took the runner
 * could open its own unit of work, and then the precondition read and the write
 * it authorizes would sit in two transactions with a committable window between
 * them. Because the handle is the caller's, both take the same snapshot.
 *
 * ## What the SQL does and does not do
 *
 * It fetches **every** row for the membership and orders them. It does not filter
 * by window. That is deliberate twice over: the window rule lives in the domain
 * where it is exhaustively tested without a database, and filtering in SQL would
 * throw away the information needed to tell a gap from "no rows at all" — which is
 * the distinction that makes an effective-dating defect readable. `LIMIT 1` does
 * not appear here, with or without an `ORDER BY`.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Row shapes at the boundary
 * ──────────────────────────────────────────────────────────────────────────── */

export interface WeekdayTargetRow {
  readonly workProfileId: string;
  readonly day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun' | 'holiday';
  readonly fteFraction: number;
  readonly maxAssignments: number | null;
}

export interface WorkProfileRow extends EffectiveDated {
  readonly id: string;
  readonly membershipId: string;
  readonly groupId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly workPercentage: number;
  readonly maxAssignmentsPerWeek: number | null;
  readonly maxAssignmentsPerPeriod: number | null;
  readonly maxConsecutiveDays: number | null;
}

export interface HoldingRow extends EffectiveDated {
  readonly id: string;
  readonly membershipId: string;
  readonly qualificationId: string;
  /** `EffectiveDated.effectiveFrom` — the column is `valid_from`. */
  readonly effectiveFrom: string;
  /** `EffectiveDated.effectiveTo` — the column is `valid_until`. */
  readonly effectiveTo: string | null;
  readonly evidenceRef: string | null;
  readonly status: 'pending' | 'valid' | 'expiring' | 'expired' | 'revoked';
}

/**
 * The sentinel a stored instant becomes when it is not usable.
 *
 * `timestamptz` accepts `infinity`, and node-postgres hands those back as the
 * JavaScript numbers `Infinity` / `-Infinity` rather than `Date`s — so a bare
 * `.toISOString()` throws a `TypeError` and an ordinary read becomes a 500. The
 * migration refuses infinite bounds at the CHECK level; this is what survives a
 * row written before that constraint, and it is the same guard
 * `load-policy-input.ts` carries for the same reason.
 *
 * `parseInstant` in the domain returns `null` for this string, so a row carrying
 * it is never in force in either direction — which is the fail-CLOSED reading.
 */
const UNPARSABLE_INSTANT = 'unparsable-instant';

function instantOf(value: Date | null): string | null {
  if (value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}

function requiredInstant(value: Date): string {
  return instantOf(value) ?? UNPARSABLE_INSTANT;
}

function optionalInstant(value: Date | null): string | null {
  if (value === null) return null;
  return instantOf(value) ?? UNPARSABLE_INSTANT;
}

/**
 * `numeric` arrives as a string from node-postgres, which is the right default —
 * parsing it as a float64 by default would silently round values nobody asked it
 * to round. Converted here, at the one boundary, so no caller has to know.
 */
function numberOf(value: string | number): number {
  return typeof value === 'number' ? value : Number.parseFloat(value);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Work profiles
 * ──────────────────────────────────────────────────────────────────────────── */

export interface MembershipScope {
  readonly organizationId: string;
  readonly membershipId: string;
}

interface RawProfileRow {
  id: string;
  membership_id: string;
  group_id: string;
  effective_from: Date;
  effective_to: Date | null;
  work_percentage: string | number;
  max_assignments_per_week: number | null;
  max_assignments_per_period: number | null;
  max_consecutive_days: number | null;
}

/**
 * Every work-profile row for a membership, oldest first.
 *
 * The `ORDER BY` is **not** what makes the selection deterministic — the domain
 * rule is order-independent and a test asserts that directly. It is here so that
 * a failure is reproducible rather than dependent on the query plan, and so a
 * history response reads in the order a human expects. The explicit
 * `organization_id` predicate sits alongside the RLS policy for the same reason
 * the M1 modules do it: RLS is the control, the predicate is what makes the
 * query's intent legible.
 */
export async function loadWorkProfiles(
  query: Kysely<Database>,
  scope: MembershipScope,
): Promise<readonly WorkProfileRow[]> {
  const rows = (await query
    .selectFrom('membership_work_profiles')
    .select([
      'id',
      'membership_id',
      'group_id',
      'effective_from',
      'effective_to',
      'work_percentage',
      'max_assignments_per_week',
      'max_assignments_per_period',
      'max_consecutive_days',
    ])
    .where('organization_id', '=', scope.organizationId)
    .where('membership_id', '=', scope.membershipId)
    .orderBy('effective_from')
    .orderBy('id')
    .execute()) as unknown as RawProfileRow[];

  return rows.map((row) => ({
    id: row.id,
    membershipId: row.membership_id,
    groupId: row.group_id,
    effectiveFrom: requiredInstant(row.effective_from),
    effectiveTo: optionalInstant(row.effective_to),
    workPercentage: numberOf(row.work_percentage),
    maxAssignmentsPerWeek: row.max_assignments_per_week,
    maxAssignmentsPerPeriod: row.max_assignments_per_period,
    maxConsecutiveDays: row.max_consecutive_days,
  }));
}

/**
 * The selection, for a reader: the row in force at `at`, or a named reason.
 *
 * A thin composition on purpose. The interesting behaviour is entirely in
 * `selectInForce`, which is pure and exhaustively tested; anything clever added
 * here would be a second selection rule, which is the thing this module exists to
 * prevent.
 */
export async function workProfileInForce(
  query: Kysely<Database>,
  options: MembershipScope & { readonly at: Date },
): Promise<InForceSelection<WorkProfileRow>> {
  return selectInForce(await loadWorkProfiles(query, options), options.at);
}

/**
 * Everything a writer needs to decide, from ONE load of the history.
 *
 * Three answers, and they must come from the same rows or they can contradict
 * each other:
 *
 *  - `inForce` — the row this change supersedes, or `null`. `requireInForce`
 *    THROWS rather than choosing when two rows are somehow in force at once;
 *    inside a unit of work that rolls the transaction back, so a supersession
 *    attempted against corrupt effective dating writes nothing at all. A writer
 *    that "handled" ambiguity would commit something.
 *  - `nextStart` — where the new window must END, because a change already
 *    scheduled for a later instant must still take effect exactly when it was
 *    scheduled to. Without it, authoring an immediate change while a future one
 *    is pending is refused by the EXCLUDE constraint.
 *  - `rows` — the history itself, for callers that need it.
 *
 * `apps/api/test/profiles/loader-writer-agreement.test.ts` is the named proof
 * that this and `workProfileInForce` cannot disagree: both are called inside one
 * unit of work and the ids are compared.
 */
export interface WorkProfileWriteContext {
  readonly rows: readonly WorkProfileRow[];
  readonly inForce: WorkProfileRow | null;
  readonly nextStart: string | null;
}

export async function workProfileWriteContext(
  query: Kysely<Database>,
  options: MembershipScope & { readonly at: Date },
): Promise<WorkProfileWriteContext> {
  const rows = await loadWorkProfiles(query, options);
  return {
    rows,
    inForce: requireInForce(rows, options.at),
    nextStart: nextWindowStart(rows, options.at),
  };
}

/**
 * The selection alone, for a caller that only needs the precondition.
 *
 * Literally `workProfileWriteContext(...).inForce` — one composition, not a
 * second implementation, so the two cannot drift apart.
 */
export async function workProfileToSupersede(
  query: Kysely<Database>,
  options: MembershipScope & { readonly at: Date },
): Promise<WorkProfileRow | null> {
  return (await workProfileWriteContext(query, options)).inForce;
}

interface RawWeekdayRow {
  work_profile_id: string;
  day: WeekdayTargetRow['day'];
  fte_fraction: string | number;
  max_assignments: number | null;
}

/** The weekday and holiday targets belonging to the given profile versions. */
export async function loadWeekdayTargets(
  query: Kysely<Database>,
  options: { readonly organizationId: string; readonly workProfileIds: readonly string[] },
): Promise<readonly WeekdayTargetRow[]> {
  if (options.workProfileIds.length === 0) return [];

  const rows = (await query
    .selectFrom('membership_weekday_fte')
    .select(['work_profile_id', 'day', 'fte_fraction', 'max_assignments'])
    .where('organization_id', '=', options.organizationId)
    .where('work_profile_id', 'in', [...options.workProfileIds])
    .orderBy('work_profile_id')
    .orderBy('day')
    .execute()) as unknown as RawWeekdayRow[];

  return rows.map((row) => ({
    workProfileId: row.work_profile_id,
    day: row.day,
    fteFraction: numberOf(row.fte_fraction),
    maxAssignments: row.max_assignments,
  }));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Qualification holdings
 * ──────────────────────────────────────────────────────────────────────────── */

interface RawHoldingRow {
  id: string;
  membership_id: string;
  qualification_id: string;
  valid_from: Date;
  valid_until: Date | null;
  evidence_ref: string | null;
  status: HoldingRow['status'];
}

/**
 * Every holding for a membership **that the caller is permitted to see**, oldest
 * first.
 *
 * There is no capability check in this function and there must not be one. The
 * SENSITIVE-PII narrowing is in the RLS SELECT policies, which means it applies to
 * every statement on every path including ones written after this file — an
 * application-layer filter here would be a second, weaker copy that a future
 * query could simply not call. A caller with no read capability gets their own
 * holdings and nothing else, and gets them as an empty-shaped normal result
 * rather than an error, because "you may not see this" and "there is nothing"
 * must be indistinguishable (P-3).
 *
 * Expired and revoked holdings are returned. 06 §3.2: "Retained after expiry for
 * audit" — filtering them out here would make the retention invisible to every
 * reader and thereby pointless.
 */
export async function loadHoldings(
  query: Kysely<Database>,
  scope: MembershipScope,
): Promise<readonly HoldingRow[]> {
  const rows = (await query
    .selectFrom('qualification_holdings')
    .select([
      'id',
      'membership_id',
      'qualification_id',
      'valid_from',
      'valid_until',
      'evidence_ref',
      'status',
    ])
    .where('organization_id', '=', scope.organizationId)
    .where('membership_id', '=', scope.membershipId)
    .orderBy('valid_from')
    .orderBy('id')
    .execute()) as unknown as RawHoldingRow[];

  return rows.map((row) => ({
    id: row.id,
    membershipId: row.membership_id,
    qualificationId: row.qualification_id,
    effectiveFrom: requiredInstant(row.valid_from),
    effectiveTo: optionalInstant(row.valid_until),
    evidenceRef: row.evidence_ref,
    status: row.status,
  }));
}

/** One holding by id, or `null` when it is not visible in this context. */
export async function loadHolding(
  query: Kysely<Database>,
  options: { readonly organizationId: string; readonly holdingId: string },
): Promise<HoldingRow | null> {
  const rows = (await query
    .selectFrom('qualification_holdings')
    .select([
      'id',
      'membership_id',
      'qualification_id',
      'valid_from',
      'valid_until',
      'evidence_ref',
      'status',
    ])
    .where('organization_id', '=', options.organizationId)
    .where('id', '=', options.holdingId)
    .execute()) as unknown as RawHoldingRow[];

  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    membershipId: row.membership_id,
    qualificationId: row.qualification_id,
    effectiveFrom: requiredInstant(row.valid_from),
    effectiveTo: optionalInstant(row.valid_until),
    evidenceRef: row.evidence_ref,
    status: row.status,
  };
}
