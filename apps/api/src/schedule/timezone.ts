import type { UnitOfWork } from '@schedulepoint/domain';
import { isKnownTimeZone } from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import { SchedulePreconditionError } from './errors.js';

/**
 * The schedule module's timezone semantics (OPUS-M4-000B; doc 34 §4-F).
 *
 * ## The ruling this module implements
 *
 * **A location's `timezone` is DISPLAY METADATA. The GROUP's timezone governs
 * every schedule semantic.**
 *
 * Migration 0010 gave `locations` an optional `timezone` and said the group's
 * and the location's "are different facts" — without saying which one a
 * schedule resolves against. An unstated precedence is how a multi-site group
 * acquires two truths. Doc 06 §Time settles it: "Shift-local semantics resolve
 * against the group timezone." So:
 *
 *  - `starts_at` / `ends_at` derivation, day-window reads, DST gap and fold
 *    resolution, and calendar-date attribution all use `groups.timezone`;
 *  - `locations.timezone` is shown to a human who wants to know what the clock
 *    on that wall reads. **Nothing computes from it.**
 *
 * The alternative — letting a location's zone govern its own shifts — was
 * considered and rejected on a concrete ground rather than a stylistic one: the
 * D-1a and D-1b overlap constraints compare `tstzrange` values across a whole
 * group, and a group whose shifts resolve in several zones at once still has
 * comparable instants but no longer has a comparable *local day*, so "two shifts
 * on the same day" stops being a single question. Offered for FAD ratification
 * in the packet's return report.
 *
 * ## The snapshot, and what it does and does not promise
 *
 * `schedule_versions.timezone_basis` records the zone a version's instants were
 * derived under; `schedule_versions.tzdb_version` records the tz DATABASE rule
 * set in force at that moment. Together they are what makes a published
 * version's rendering reproducible after the group changes its zone —
 * `group.timezone.administer` exists as its own capability precisely because
 * that change "reaches already-published history" (0010).
 *
 * The honest limit, stated because the alternative is a claim nobody can keep:
 * this repository has exactly one tz database, the runtime's. Recording the
 * rule set makes a divergence **detectable**; it does not make the old
 * interpretation reproducible. Nothing here pretends otherwise.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/**
 * The tz DATABASE rule-set identifier this process is using, e.g. `2026b`.
 *
 * Read here rather than in `packages/domain/src/time`, because
 * `process.versions.tz` is a **Node** global and the domain package may not read
 * one (`domain-imports-nothing`). Node exposes it from v22; the fallback is the
 * literal string `unknown`, which is a recorded absence and not a fabricated
 * version — a snapshot that invented `2026b` when it did not know would be worse
 * than one that says so.
 */
export function tzdbVersion(): string {
  const version = (process.versions as Record<string, string | undefined>)['tz'];
  return version !== undefined && version.length > 0 ? version : 'unknown';
}

/** The GROUP's timezone — the one that governs. Never a location's. */
export async function groupTimezone(uow: Uow): Promise<string> {
  const row = (await uow.query
    .selectFrom('groups')
    .select(['timezone'])
    .where('id', '=', uow.context.groupId as string)
    .executeTakeFirst()) as unknown as { timezone: string } | undefined;

  /* `groups.timezone` is NOT NULL with a backfilling default (0009), so a row
   * always has one. The fallback covers only the case where RLS hides the row,
   * and `UTC` is the same value the backfill used — a visible, boring default
   * rather than a throw that would take down a read. */
  return row?.timezone ?? 'UTC';
}

/** What a version records about the interpretation its instants were built under. */
export interface TimezoneBasis {
  /** The IANA zone. */
  readonly zone: string;
  /** The tz database rule set, or `'unknown'`. */
  readonly tzdb: string;
}

/** Capture the current basis — called when a draft version comes into existence. */
export async function captureTimezoneBasis(uow: Uow): Promise<TimezoneBasis> {
  return { zone: await groupTimezone(uow), tzdb: tzdbVersion() };
}

/** A version's recorded basis, or `null` when it predates migration 0014. */
export async function readTimezoneBasis(
  uow: Uow,
  versionId: string,
): Promise<TimezoneBasis | null> {
  const row = (await uow.query
    .selectFrom('schedule_versions')
    .select(['timezone_basis', 'tzdb_version'])
    .where('id', '=', versionId)
    .executeTakeFirst()) as unknown as
    | { timezone_basis: string | null; tzdb_version: string | null }
    | undefined;

  if (row === undefined || row.timezone_basis === null) return null;
  return { zone: row.timezone_basis, tzdb: row.tzdb_version ?? 'unknown' };
}

/** The result of asking whether a draft's basis still matches the group. */
export type TimezoneBasisState =
  | { readonly kind: 'fresh'; readonly basis: TimezoneBasis }
  /** Pre-0014 rows: no basis was ever recorded. Never silently treated as fresh. */
  | { readonly kind: 'unrecorded'; readonly currentZone: string }
  | {
      readonly kind: 'stale';
      readonly basis: TimezoneBasis;
      readonly currentZone: string;
      readonly currentTzdb: string;
    };

/**
 * Compare a version's recorded basis with the group's CURRENT timezone.
 *
 * This is the staleness doc 34 §4-F asks to be surfaced explicitly: "a
 * group-timezone change while a draft build input exists surfaces the staleness
 * explicitly (CAS class)". It is a compare-and-set in the same sense FAD-24's
 * `settings_version` is — the value the draft was built against is compared
 * with the value now, and a difference is REPORTED rather than reconciled.
 *
 * The tzdb version is deliberately NOT part of the staleness comparison. A
 * runtime upgrade changes it on every version at once, including versions
 * nobody touched, and refusing every publication after a Node upgrade would be
 * an outage dressed up as a correctness control. It is recorded so a divergence
 * can be investigated; the zone is what a human changed and what a human must
 * therefore be told about.
 */
export function classifyTimezoneBasis(
  basis: TimezoneBasis | null,
  currentZone: string,
): TimezoneBasisState {
  if (basis === null) return { kind: 'unrecorded', currentZone };
  if (basis.zone === currentZone) return { kind: 'fresh', basis };
  return { kind: 'stale', basis, currentZone, currentTzdb: tzdbVersion() };
}

/** `classifyTimezoneBasis` against the database. */
export async function timezoneBasisState(
  uow: Uow,
  versionId: string,
): Promise<TimezoneBasisState> {
  return classifyTimezoneBasis(await readTimezoneBasis(uow, versionId), await groupTimezone(uow));
}

/** Raised when a version is published against a basis the group has since left. */
export class TimezoneBasisStaleError extends SchedulePreconditionError {
  readonly recordedZone: string;
  readonly currentZone: string;

  constructor(versionId: string, recordedZone: string, currentZone: string) {
    super(
      'TIMEZONE_BASIS_STALE',
      `version ${versionId} was authored against timezone ${recordedZone}, and the group is now ` +
        `${currentZone}. Its instants were derived under the old zone, so publishing it would ` +
        'file a schedule nobody authored. Re-derive the draft against the current zone, or ' +
        'restore the zone, and publish again.',
    );
    this.name = 'TimezoneBasisStaleError';
    this.recordedZone = recordedZone;
    this.currentZone = currentZone;
  }
}

/**
 * Refuse a publication whose version was built under a different zone.
 *
 * **`unrecorded` is permitted, and that is deliberate.** Versions created before
 * migration 0014 carry no basis; refusing them would make an additive migration
 * retroactively unpublish existing drafts, which is a migration breaking data it
 * did not touch. They publish, and the `unrecorded` state is returned so the
 * caller can record it rather than pretend the check passed.
 */
export async function assertTimezoneBasisFresh(
  uow: Uow,
  versionId: string,
): Promise<TimezoneBasisState> {
  const state = await timezoneBasisState(uow, versionId);
  if (state.kind === 'stale') {
    throw new TimezoneBasisStaleError(versionId, state.basis.zone, state.currentZone);
  }
  return state;
}

/**
 * Which zone a version should be RENDERED in, and where that answer came from.
 *
 * A published version renders under the zone it was published with, so changing
 * the group's timezone cannot move a schedule that is already immutable (I-18).
 * A version with no recorded basis falls back to the group's current zone — the
 * behaviour every read surface had before 0014 — and says so in `source`, so a
 * fallback is visible in the response rather than disguised as a snapshot.
 */
export interface RenderTimezone {
  readonly zone: string;
  readonly tzdb: string;
  readonly source: 'version-snapshot' | 'group-current';
}

export async function resolveRenderTimezone(
  uow: Uow,
  versionId: string | null,
): Promise<RenderTimezone> {
  if (versionId !== null) {
    const basis = await readTimezoneBasis(uow, versionId);
    if (basis !== null) {
      return { zone: basis.zone, tzdb: basis.tzdb, source: 'version-snapshot' };
    }
  }
  return { zone: await groupTimezone(uow), tzdb: tzdbVersion(), source: 'group-current' };
}

/**
 * Guard a group-timezone change: which DRAFT versions were authored against the
 * outgoing zone, and would therefore go stale.
 *
 * Returned rather than refused. The change is permitted — packet 32 §10c
 * required it to be, and 0010 gives it its own capability precisely because it
 * is consequential — so the honest surface is one that states the consequence
 * before the administrator commits to it, exactly as the settings page already
 * states the published-version count.
 */
export async function draftsAffectedByTimezoneChange(
  uow: Uow,
  fromZone: string,
): Promise<readonly { readonly versionId: string; readonly periodId: string }[]> {
  const rows = (await uow.query
    .selectFrom('schedule_versions')
    .select(['id', 'period_id'])
    .where('state', 'in', ['draft', 'in_review', 'approved'])
    .where('timezone_basis', '=', fromZone)
    .orderBy('id')
    .execute()) as unknown as { id: string; period_id: string }[];

  return rows.map((row) => ({ versionId: row.id, periodId: row.period_id }));
}

/** A zone the tz database does not know cannot govern anything. */
export function assertKnownTimeZone(zone: string): void {
  if (!isKnownTimeZone(zone)) {
    throw new SchedulePreconditionError(
      'TIMEZONE_UNKNOWN',
      `${JSON.stringify(zone)} is not a time zone this runtime's tz database knows`,
    );
  }
}
