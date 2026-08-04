import { randomUUID } from 'node:crypto';

import type {
  CreateLocationRequest,
  GroupSettings,
  Location,
  PicklistAccessMode,
  RequestUntilPolicy,
  UpdateLocationRequest,
} from '@schedulepoint/contracts';
import type { FieldProblem, TenantContext, UnitOfWork } from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import type { Database, LocationsTable } from '../db/schema.js';

/**
 * The settings slice's domain services (OPUS-M3-007).
 *
 * ## Every function takes a unit of work, and none of them opens one
 *
 * I-15 and non-bypass rule 1: the transaction boundary belongs to
 * `PgUnitOfWorkRunner`. The route opens exactly one unit of work per request,
 * evaluates authorization inside it, and hands the same handle to whichever
 * function below it needs — so FAD-12's ordering (evaluate → deny → mutate →
 * audit, in ONE transaction) is a property of the route's shape rather than
 * something each service function has to remember.
 *
 * ## Nothing here reads a tenant identifier from its arguments
 *
 * `organization_id` and `group_id` always come from `uow.context`, never from a
 * request body or a path parameter. A service that could be told which tenant to
 * write into is a service that can be told the wrong one.
 *
 * ## Validation happens twice, and the second time is the one that counts
 *
 * These functions produce field-addressed `422`s so an authoring form has
 * something to render. **The database enforces every one of the same rules
 * independently** — `groups_request_until_shape`,
 * `groups_picklist_access_mode_known`, the `locations_*_shape` CHECKs, the
 * capability-gate triggers and the composite foreign keys — so a bug here
 * produces a refused statement rather than a bad row.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not read the request-until policy or the picklist mode to decide
 * anything. Their enforcement is M5 (SPEC-08) and M9 (SPEC-02) respectively
 * (packet 32 §2 rows 5-6). It also contains no site concept of any kind: no
 * `sites` read, no `site_id`, no grouping of locations by label into anything
 * that behaves like an entity. `site_label` is carried through as a string
 * (PO-DEC-01 default, doc 06 §3.2a, non-bypass rule 12).
 */

export type SettingsOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'invalid'; readonly problems: readonly FieldProblem[] }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict' };

type Uow = UnitOfWork<Kysely<Database>>;

/** The tenant coordinates every statement below is pinned to. Never from a body. */
function tenantOf(context: TenantContext): { organization_id: string; group_id: string } {
  const { organizationId, groupId } = context;
  if (groupId === null) {
    // Unreachable through the routes: every settings route declares
    // `actionScope: 'group'`, and SPEC-01 §2.1's group branch refuses a request
    // with no group. Thrown rather than defaulted, because a settings write with
    // no group would be a row the group predicate can never see again.
    throw new Error(
      'SETTINGS_REQUIRES_GROUP_CONTEXT: a settings statement was reached under an ' +
        'organization-scoped unit of work',
    );
  }
  return { organization_id: organizationId, group_id: groupId };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Group settings
 * ──────────────────────────────────────────────────────────────────────────── */

const SETTINGS_COLUMNS = [
  'id',
  'timezone',
  'request_until_mode',
  'request_until_date',
  'request_until_lead_days',
  'picklist_access_mode',
  'settings_version',
] as const;

interface GroupSettingsRow {
  id: string;
  timezone: string;
  request_until_mode: 'closed' | 'fixed_date' | 'days_before_period_start';
  request_until_date: string | Date | null;
  request_until_lead_days: number | null;
  picklist_access_mode: 'disabled' | 'members' | 'members_and_proxies';
  settings_version: number;
}

/**
 * `date` comes back from `pg` as a `Date` when the type parser is the default
 * one and as a string when it is not, and this codebase does not pin that
 * globally. Normalising here means the wire shape is `YYYY-MM-DD` whichever it
 * was, rather than an ISO instant that implies a time zone a calendar date does
 * not have.
 */
function toCalendarDate(value: string | Date | null): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function toRequestUntilPolicy(row: GroupSettingsRow): RequestUntilPolicy {
  switch (row.request_until_mode) {
    case 'fixed_date':
      // Non-null by `groups_request_until_shape`; the fallback exists so a
      // hypothetically-corrupt row degrades to `closed` rather than producing a
      // body the contract cannot parse.
      return row.request_until_date === null
        ? { mode: 'closed' }
        : { mode: 'fixed_date', untilDate: toCalendarDate(row.request_until_date) ?? '' };
    case 'days_before_period_start':
      return row.request_until_lead_days === null
        ? { mode: 'closed' }
        : { mode: 'days_before_period_start', leadDays: row.request_until_lead_days };
    default:
      return { mode: 'closed' };
  }
}

/**
 * Reads the group's settings and the count of its currently-published versions.
 *
 * The count is part of the READ rather than a separate endpoint because the
 * timezone panel has to state the consequence of a change **before** the
 * administrator acts. A warning that needs a second request is a warning that
 * can be missed by a client that forgets to make it — and I-10 would then be
 * paying two requests for one page.
 */
/**
 * The settings row alone, without the published-version count.
 *
 * The write paths need the BEFORE values to decide whether anything actually
 * moved (see `changed` below); they do not need a `COUNT(*)` over
 * `schedule_versions` to do it, and paying for one on every request-until save
 * would be a query nobody asked for.
 */
async function readSettingsRow(uow: Uow): Promise<GroupSettingsRow | undefined> {
  const tenant = tenantOf(uow.context);
  return (await uow.query
    .selectFrom('groups')
    .select(SETTINGS_COLUMNS)
    .where('id', '=', tenant.group_id)
    .where('organization_id', '=', tenant.organization_id)
    .executeTakeFirst()) as unknown as GroupSettingsRow | undefined;
}

export async function readGroupSettings(uow: Uow): Promise<GroupSettings | null> {
  const row = await readSettingsRow(uow);

  // RLS makes a group in another tenant invisible, and an absent group is
  // absent. The two are one answer (T-05b), and `null` is that one answer.
  if (row === undefined) return null;

  return {
    groupId: row.id,
    requestUntil: toRequestUntilPolicy(row),
    picklistAccessMode: row.picklist_access_mode,
    timezone: row.timezone,
    publishedVersionCount: await countPublishedVersions(uow),
    version: row.settings_version,
    correlationId: uow.context.correlationId,
  };
}

/**
 * How many schedule versions in this group are published right now.
 *
 * A READ of `schedule_versions` through the ordinary group-scoped unit of work —
 * this packet does not touch `apps/api/src/schedule/**`, which packet 32 §10a
 * freezes to every UX packet. It is a count, so nothing about the versions
 * themselves crosses into this module.
 */
async function countPublishedVersions(uow: Uow): Promise<number> {
  const tenant = tenantOf(uow.context);
  const row = (await uow.query
    .selectFrom('schedule_versions')
    .select((builder) => builder.fn.countAll().as('count'))
    .where('organization_id', '=', tenant.organization_id)
    .where('group_id', '=', tenant.group_id)
    .where('state', 'in', ['published', 'superseded'])
    .executeTakeFirst()) as unknown as { count: string | number } | undefined;

  if (row === undefined) return 0;
  return typeof row.count === 'number' ? row.count : Number.parseInt(row.count, 10);
}

/**
 * The optimistic-concurrency predicate every settings write carries.
 *
 * Read and write happen in the SAME unit of work, so the version the writer
 * checks is the version the reader saw (FAD-12, and the M1 S-01 lesson). A
 * zero-row result is a `409`, never a silent no-op.
 */
async function updateGroupWithVersion(
  uow: Uow,
  expectedVersion: number,
  values: Partial<{
    request_until_mode: 'closed' | 'fixed_date' | 'days_before_period_start';
    request_until_date: string | null;
    request_until_lead_days: number | null;
    picklist_access_mode: 'disabled' | 'members' | 'members_and_proxies';
    timezone: string;
  }>,
): Promise<boolean> {
  const tenant = tenantOf(uow.context);
  const result = await uow.query
    .updateTable('groups')
    .set({ ...values, updated_at: new Date() } as never)
    .where('id', '=', tenant.group_id)
    .where('organization_id', '=', tenant.organization_id)
    .where('settings_version', '=', expectedVersion)
    .executeTakeFirst();

  return (result.numUpdatedRows ?? 0n) > 0n;
}

/**
 * Whether a write actually moved anything.
 *
 * ## Why every mutator reports this, and what the route does with it
 *
 * An independent review probed `UTC → UTC` and got `settings.timezone.changed`
 * with identical `from` and `to`. The DATABASE was already correct — the
 * `IS DISTINCT FROM` guard in `app_maintain_group_settings_version` does not
 * bump the counter for a no-op — so the row did not move and the audit stream
 * recorded a change that never happened. False events are worse than missing
 * ones: an incident review counts them.
 *
 * **A no-op emits no audit event at all**, and that is a deliberate choice over
 * the alternative of a distinct "unchanged" name. `AUDIT_EVENT_NAMES` is a
 * CLOSED list that only ever grows (non-bypass rule 13), and one name means
 * exactly one thing; four permanent names recording that nothing happened would
 * be four names no query ever wants and no retention rule can ever drop. There
 * is also nothing to attribute — the state transition the event would describe
 * did not occur, which is the same reason a denied mutation writes no row.
 *
 * The write is still a SUCCESS on the wire: the caller asked for a state and
 * that state holds. The CAS is still enforced, so a stale `expectedVersion`
 * still loses with a 409 even when the value it carries happens to match.
 */
export interface SettingsWriteResult {
  /** False when the stored values already equalled the requested ones. */
  readonly changed: boolean;
}

export async function setRequestUntil(
  uow: Uow,
  policy: RequestUntilPolicy,
  expectedVersion: number,
): Promise<SettingsOutcome<{ policy: RequestUntilPolicy } & SettingsWriteResult>> {
  const before = await readSettingsRow(uow);
  if (before === undefined) return { kind: 'not-found' };

  // The three columns move together, and the two that are not this mode's are
  // explicitly nulled rather than left alone. Leaving a stale
  // `request_until_date` behind while switching to `closed` would be refused by
  // `groups_request_until_shape` anyway — this is the application saying the
  // same thing so the refusal never has to happen.
  const values =
    policy.mode === 'fixed_date'
      ? {
          request_until_mode: 'fixed_date' as const,
          request_until_date: policy.untilDate,
          request_until_lead_days: null,
        }
      : policy.mode === 'days_before_period_start'
        ? {
            request_until_mode: 'days_before_period_start' as const,
            request_until_date: null,
            request_until_lead_days: policy.leadDays,
          }
        : {
            request_until_mode: 'closed' as const,
            request_until_date: null,
            request_until_lead_days: null,
          };

  // Compared against the WIRE shape rather than the columns, so the comparison
  // is the same one the contract's discriminated union expresses and cannot
  // disagree with it about, say, a date rendered two ways.
  const changed = canonicalPolicy(toRequestUntilPolicy(before)) !== canonicalPolicy(policy);

  const updated = await updateGroupWithVersion(uow, expectedVersion, values);
  return updated ? { kind: 'ok', value: { policy, changed } } : { kind: 'conflict' };
}

/** A stable string for comparing two policies. Closed tokens and scalars only. */
function canonicalPolicy(policy: RequestUntilPolicy): string {
  switch (policy.mode) {
    case 'fixed_date':
      return `fixed_date:${policy.untilDate}`;
    case 'days_before_period_start':
      return `days_before_period_start:${String(policy.leadDays)}`;
    default:
      return 'closed';
  }
}

export async function setPicklistAccess(
  uow: Uow,
  mode: PicklistAccessMode,
  expectedVersion: number,
): Promise<SettingsOutcome<{ mode: PicklistAccessMode } & SettingsWriteResult>> {
  const before = await readSettingsRow(uow);
  if (before === undefined) return { kind: 'not-found' };

  const changed = before.picklist_access_mode !== mode;

  const updated = await updateGroupWithVersion(uow, expectedVersion, {
    picklist_access_mode: mode,
  });
  return updated ? { kind: 'ok', value: { mode, changed } } : { kind: 'conflict' };
}

export interface TimezoneChange extends SettingsWriteResult {
  readonly from: string;
  readonly to: string;
  /** Published (and superseded) versions that existed at the moment of the change. */
  readonly publishedVersionCount: number;
  /**
   * What the CLIENT actually sent in `acknowledgePublishedImpact`.
   *
   * Carried through from the request rather than derived, because the audit row
   * asserts a human act. An independent review found the route computing it as
   * `publishedVersionCount > 0` — which happens to agree with the truth on
   * every path the route allows, and is still an assertion about a field the
   * payload never read. A derived field that is right by coincidence is a field
   * that becomes wrong the first time the surrounding rule changes.
   */
  readonly acknowledged: boolean;
}

/**
 * Changes the group's timezone, and reports what the change was made over.
 *
 * ## The change is PERMITTED while published schedules exist
 *
 * Packet 32 §10c requires exactly that. Refusing it would be worse than
 * permitting it: a group that discovers its zone was wrong after publishing
 * would have no way to correct the record, and the schedules would go on being
 * rendered against a zone nobody believes.
 *
 * ## What makes it honest rather than merely permitted
 *
 * Two things, and both are checkable:
 *
 *  1. **the count is read INSIDE the same transaction as the write**, so the
 *     number in the audit payload is the number that was true at the instant the
 *     change committed — not a number a client sent, and not one read from a
 *     different snapshot;
 *  2. **the caller must acknowledge** when that count is non-zero. The route
 *     refuses an unacknowledged change with a field-addressed `422`, so the
 *     warning is a gate rather than a paragraph.
 *
 * ## The display-semantics question is NOT resolved here
 *
 * Whether an already-published assignment should render at its original wall
 * time or at the new zone's equivalent instant is a product question this packet
 * is explicitly told to record rather than settle. Nothing in this function
 * rewrites, reinterprets or migrates a single stored instant: `assignment_
 * snapshots` are `timestamptz` and are untouched. The question is recorded in
 * `docs/evidence/EV-M3-SETTINGS/INDEX.md` for the M3 exit report.
 */
export async function setTimezone(
  uow: Uow,
  timezone: string,
  expectedVersion: number,
  acknowledged: boolean,
): Promise<SettingsOutcome<TimezoneChange>> {
  const current = await readGroupSettings(uow);
  if (current === null) return { kind: 'not-found' };

  const updated = await updateGroupWithVersion(uow, expectedVersion, { timezone });
  if (!updated) return { kind: 'conflict' };

  return {
    kind: 'ok',
    value: {
      from: current.timezone,
      to: timezone,
      publishedVersionCount: current.publishedVersionCount,
      changed: current.timezone !== timezone,
      acknowledged,
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Locations
 * ──────────────────────────────────────────────────────────────────────────── */

const LOCATION_COLUMNS = [
  'id',
  'name',
  'site_label',
  'address',
  'timezone',
  'status',
  'version',
] as const;

type LocationRow = Pick<
  LocationsTable,
  'id' | 'name' | 'site_label' | 'address' | 'timezone'
> & { status: 'active' | 'archived'; version: number };

function toWire(row: LocationRow): Location {
  return {
    locationId: row.id,
    name: row.name,
    // Carried through as the string it is. There is no lookup, no resolution
    // against a site register, and nothing downstream treats it as an id.
    siteLabel: row.site_label,
    address: row.address,
    timezone: row.timezone,
    status: row.status,
    version: row.version,
  };
}

export async function listLocations(uow: Uow): Promise<readonly Location[]> {
  const rows = (await uow.query
    .selectFrom('locations')
    .select(LOCATION_COLUMNS)
    .orderBy('name')
    .execute()) as unknown as LocationRow[];
  return rows.map(toWire);
}

export async function createLocation(
  uow: Uow,
  request: CreateLocationRequest,
): Promise<SettingsOutcome<Location>> {
  const tenant = tenantOf(uow.context);
  const id = randomUUID();

  await uow.query
    .insertInto('locations')
    .values({
      id,
      ...tenant,
      name: request.name,
      site_label: request.siteLabel,
      address: request.address,
      timezone: request.timezone,
    } as never)
    .execute();

  const row = (await uow.query
    .selectFrom('locations')
    .select(LOCATION_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst()) as unknown as LocationRow | undefined;

  return row === undefined ? { kind: 'not-found' } : { kind: 'ok', value: toWire(row) };
}

export async function updateLocation(
  uow: Uow,
  locationId: string,
  request: UpdateLocationRequest,
): Promise<SettingsOutcome<{ location: Location; archived: boolean } & SettingsWriteResult>> {
  const tenant = tenantOf(uow.context);

  const before = (await uow.query
    .selectFrom('locations')
    .select(LOCATION_COLUMNS)
    .where('id', '=', locationId)
    .executeTakeFirst()) as unknown as LocationRow | undefined;

  if (before === undefined) return { kind: 'not-found' };

  const values: Record<string, unknown> = { updated_at: new Date() };
  if (request.name !== undefined) values['name'] = request.name;
  if (request.siteLabel !== undefined) values['site_label'] = request.siteLabel;
  if (request.address !== undefined) values['address'] = request.address;
  if (request.timezone !== undefined) values['timezone'] = request.timezone;
  if (request.status !== undefined) values['status'] = request.status;

  const result = await uow.query
    .updateTable('locations')
    .set(values as never)
    .where('id', '=', locationId)
    .where('organization_id', '=', tenant.organization_id)
    .where('group_id', '=', tenant.group_id)
    .where('version', '=', request.expectedVersion)
    .executeTakeFirst();

  if ((result.numUpdatedRows ?? 0n) === 0n) return { kind: 'conflict' };

  const after = (await uow.query
    .selectFrom('locations')
    .select(LOCATION_COLUMNS)
    .where('id', '=', locationId)
    .executeTakeFirst()) as unknown as LocationRow | undefined;

  if (after === undefined) return { kind: 'not-found' };

  return {
    kind: 'ok',
    value: {
      location: toWire(after),
      // Archiving is its own audited event, so the route needs to know which of
      // the two this update was. `before.status` is read in the same
      // transaction, so the comparison cannot straddle a concurrent change.
      archived: before.status !== 'archived' && after.status === 'archived',
      /* Whether any DOMAIN field moved.
       *
       * Deliberately NOT `after.version !== before.version`:
       * `app_maintain_catalogue_version` bumps unconditionally on every UPDATE,
       * because "a writer that read version N and wrote nothing still has to
       * lose to a writer that read N and wrote something" (migration 0005).
       * That is a concurrency property and it is correct; it is not a statement
       * that the location changed. A PATCH carrying only `expectedVersion`
       * moves the counter and moves nothing a person would recognise, and the
       * audit stream must say so. */
      changed:
        before.name !== after.name ||
        before.site_label !== after.site_label ||
        before.address !== after.address ||
        before.timezone !== after.timezone ||
        before.status !== after.status,
    },
  };
}
