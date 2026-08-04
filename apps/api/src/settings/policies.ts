import type { AuditEventName } from '@schedulepoint/domain';

import type { RouteConfigWithPolicy } from '../http/policy.js';

/**
 * The settings slice's route declarations and audit vocabulary, in one place.
 *
 * ## Why the declarations live here and not in the route file
 *
 * The same two reasons the catalogue's do, and the second is the load-bearing
 * one: the route file is a thin registration surface that auto-discovery
 * requires to sit in `http/routes/`, and **the tests compare against these
 * objects rather than against copies of their contents**
 * (`apps/api/test/settings/authorization.test.ts` walks `SETTINGS_CAPABILITY_
 * KEYS` and asserts a deny case for every key). A capability added to a route
 * without being added here has no deny test.
 *
 * ## Three capabilities, and the line between them
 *
 * doc 08 §6's "Group settings / vocabulary / connectors" row reads
 * `— — — — ✓ ✓` with "(connectors: G)". A `✓` is role-implied and a `G` is
 * grant-only; the row marks exactly one of its subjects as a grant and it is not
 * these. Scheduler is `—`. So all three keys below are **role-implied for
 * `group_admin` and held by nobody else** — the same line
 * `group.holiday_calendar.administer` and `group.pick_positions.administer`
 * already sit on.
 *
 * doc 08 §6 draws no line *inside* that row, so the split into three is
 * justified by blast radius, exactly as the catalogue's three keys are:
 *
 * | key | covers | why its own key |
 * |---|---|---|
 * | `group.settings.administer` | request-until, picklist access | stored only — enforcement is M5 / M9 |
 * | `group.timezone.administer` | the group timezone | the one settings change that reaches already-published history |
 * | `group.location.administer` | `locations` | maintaining the places a group works is not a power over its request window |
 *
 * ## Reads are gated by the same key as writes, deliberately
 *
 * There is no `group.settings.read`. The consumers of these settings in this
 * milestone are their own authoring surfaces; the M5 and M9 enforcement paths
 * will read them from inside the request and picklist modules under those
 * modules' own actions, not through this route. Inventing a read capability now
 * would mean inventing which roles hold it, and doc 08 §6 has no row to read
 * that off. Deny-by-default is the correct direction to be wrong in (I-02).
 *
 * The one refinement the catalogue's equivalent decision later needed (the D-10
 * holiday-read ruling, where a scheduler authored holiday demand without being
 * able to see the dates) does not apply here: no non-administrator surface in
 * this milestone displays a group's request window or picklist mode.
 */

/** CAP-021 · the request-submission window (SPEC-08; enforcement M5). */
const CAP_REQUEST_WINDOW = 'CAP-021';
/** CAP-030 · picklist participation (SPEC-02; enforcement M9). */
const CAP_PICKLIST = 'CAP-030';
/** CAP-004 · location and calendar modelling — the location slice (CAR-021). */
const CAP_LOCATIONS = 'CAP-004';

const SETTINGS_ACTION = {
  key: 'group.settings.administer',
  moduleKey: 'core_scheduling',
  requiresObjectPolicy: false,
} as const;

const TIMEZONE_ACTION = {
  key: 'group.timezone.administer',
  moduleKey: 'core_scheduling',
  requiresObjectPolicy: false,
} as const;

const LOCATION_ACTION = {
  key: 'group.location.administer',
  moduleKey: 'core_scheduling',
  requiresObjectPolicy: false,
} as const;

/**
 * The settings READ, gated by `group.settings.administer`.
 *
 * The read returns all three settings in one body — including the timezone and
 * the published-version count the timezone panel needs to state its consequence
 * before the administrator acts. It carries the *settings* key rather than the
 * timezone key because every principal doc 08 §6 gives the row to holds both by
 * role; requiring the narrower key to READ would make a grant-only holder of
 * `group.settings.administer` unable to see the page they can edit.
 */
export const SETTINGS_READ_CONFIG = {
  policy: { kind: 'capability', capability: CAP_REQUEST_WINDOW },
  actionScope: 'group',
  action: SETTINGS_ACTION,
} as const satisfies RouteConfigWithPolicy;

export const REQUEST_UNTIL_CONFIG = {
  policy: { kind: 'capability', capability: CAP_REQUEST_WINDOW },
  actionScope: 'group',
  action: SETTINGS_ACTION,
} as const satisfies RouteConfigWithPolicy;

export const PICKLIST_ACCESS_CONFIG = {
  policy: { kind: 'capability', capability: CAP_PICKLIST },
  actionScope: 'group',
  action: SETTINGS_ACTION,
} as const satisfies RouteConfigWithPolicy;

export const TIMEZONE_CONFIG = {
  policy: { kind: 'capability', capability: CAP_REQUEST_WINDOW },
  actionScope: 'group',
  action: TIMEZONE_ACTION,
} as const satisfies RouteConfigWithPolicy;

export const LOCATION_CONFIG = {
  policy: { kind: 'capability', capability: CAP_LOCATIONS },
  actionScope: 'group',
  action: LOCATION_ACTION,
} as const satisfies RouteConfigWithPolicy;

/**
 * The event name each settings mutation is audited under.
 *
 * Exported and asserted against `AUDIT_EVENT_NAMES` (`apps/api/test/settings/
 * audit.test.ts`), so the names are a contract rather than six strings in six
 * handlers that quietly diverge — the discipline `authorization.route.ts`'s
 * `AUDIT_EVENTS` established and the catalogue's `CATALOGUE_AUDIT_EVENTS`
 * continued.
 */
export const SETTINGS_AUDIT_EVENTS = {
  requestUntilChanged: 'settings.request_until.changed',
  picklistAccessChanged: 'settings.picklist_access.changed',
  timezoneChanged: 'settings.timezone.changed',
  locationCreated: 'settings.location.created',
  locationUpdated: 'settings.location.updated',
  locationArchived: 'settings.location.archived',
} as const satisfies Record<string, AuditEventName>;

/**
 * Every capability key this slice introduces, for the per-capability deny tests.
 *
 * A list rather than a derivation from the route configs, for the reason the
 * catalogue's equivalent gives: the test walks THIS list and asserts each key is
 * reachable through at least one registered route AND has a deny case. A
 * derivation from the configs could not notice a key that no route uses.
 */
export const SETTINGS_CAPABILITY_KEYS = [
  'group.settings.administer',
  'group.timezone.administer',
  'group.location.administer',
] as const;
