import type { AuditEventName } from '@schedulepoint/domain';

import type { RouteConfigWithPolicy } from '../http/policy.js';

/**
 * The catalogue's route declarations and audit vocabulary, in one place.
 *
 * ## Why the declarations live here and not in the route file
 *
 * Two reasons, and the second is the load-bearing one:
 *
 *  1. the route file is a thin registration surface — auto-discovery requires it
 *     to sit in `http/routes/`, and everything else in this slice lives under
 *     `catalogue/`;
 *  2. **the tests compare against these objects, not against copies of their
 *     contents.** `apps/api/test/catalogue/authorization.test.ts` asserts the
 *     deny path for every capability named below by walking this record. A
 *     capability added to a route without being added here has no deny test, and
 *     the packet requires one per capability.
 *
 * ## Three capabilities, and the line between them
 *
 * doc 08 §6 draws it twice, in two different places:
 *
 * | Area (doc 08 §6) | member | viewer | telecom | scheduler | group admin |
 * |---|---|---|---|---|---|
 * | Author catalogue & rules | — | — | — | ✓ | ✓ |
 * | Group settings | — | — | — | — | ✓ |
 *
 * so `schedule.catalogue.administer` covers the catalogue proper, and the two
 * group-settings keys (`group.holiday_calendar.administer`,
 * `group.pick_positions.administer`) are group-administrator only. All three are
 * group-scoped and in `core_scheduling` — see the catalogue constant's docblock
 * for why neither is a judgement call.
 *
 * ## Reads are gated by the SAME capability as writes, deliberately
 *
 * There is no `schedule.catalogue.read`. The only consumers of the catalogue in
 * this milestone are its authoring surfaces, and inventing a read capability
 * would mean inventing which roles hold it — doc 08 §6 has no "view catalogue"
 * row to read that off. Deny-by-default is the correct direction to be wrong in
 * (I-02), and the later surfaces that need to READ shift types (the schedule
 * grid, the request forms) declare their own actions when they ship. Recorded in
 * `docs/evidence/EV-M2-CATALOGUE/INDEX.md` §Limitations rather than left to be
 * discovered.
 */

/** CAP-011 · shift type catalogue. */
const CAP_SHIFT_TYPES = 'CAP-011';
/** CAP-012 · shift groups and staff groups. */
const CAP_GROUPINGS = 'CAP-012';
/** CAP-004 · the holiday slice of location/calendar modelling (CAR-011). */
const CAP_HOLIDAYS = 'CAP-004';

const CATALOGUE_ACTION = {
  key: 'schedule.catalogue.administer',
  moduleKey: 'core_scheduling',
  requiresObjectPolicy: false,
} as const;

const HOLIDAY_ACTION = {
  key: 'group.holiday_calendar.administer',
  moduleKey: 'core_scheduling',
  requiresObjectPolicy: false,
} as const;

/** The READ half, split from the write key by FAD-25 (OPUS-M3-008). */
const HOLIDAY_READ_ACTION = {
  key: 'group.holiday_calendar.read',
  moduleKey: 'core_scheduling',
  requiresObjectPolicy: false,
} as const;

const PICK_POSITION_ACTION = {
  key: 'group.pick_positions.administer',
  moduleKey: 'core_scheduling',
  requiresObjectPolicy: false,
} as const;

export const SHIFT_TYPE_CONFIG = {
  policy: { kind: 'capability', capability: CAP_SHIFT_TYPES },
  actionScope: 'group',
  action: CATALOGUE_ACTION,
} as const satisfies RouteConfigWithPolicy;

export const SHIFT_GROUP_CONFIG = {
  policy: { kind: 'capability', capability: CAP_GROUPINGS },
  actionScope: 'group',
  action: CATALOGUE_ACTION,
} as const satisfies RouteConfigWithPolicy;

export const STAFF_GROUP_CONFIG = {
  policy: { kind: 'capability', capability: CAP_GROUPINGS },
  actionScope: 'group',
  action: CATALOGUE_ACTION,
} as const satisfies RouteConfigWithPolicy;

export const VALID_GROUP_CONFIG = {
  policy: { kind: 'capability', capability: CAP_SHIFT_TYPES },
  actionScope: 'group',
  action: CATALOGUE_ACTION,
} as const satisfies RouteConfigWithPolicy;

export const PICK_POSITION_CONFIG = {
  policy: { kind: 'capability', capability: CAP_SHIFT_TYPES },
  actionScope: 'group',
  action: PICK_POSITION_ACTION,
} as const satisfies RouteConfigWithPolicy;

export const HOLIDAY_CONFIG = {
  policy: { kind: 'capability', capability: CAP_HOLIDAYS },
  actionScope: 'group',
  action: HOLIDAY_ACTION,
} as const satisfies RouteConfigWithPolicy;

/**
 * Holiday **READ**, on its own action key (OPUS-M3-008; FAD-25's assigned split
 * of D-10).
 *
 * ## The history in three steps, because the last one only makes sense with them
 *
 * 1. OPUS-M2-002 gated reads by the same key as writes throughout, so
 *    `GET /holidays` required `group.holiday_calendar.administer` — a group
 *    ADMINISTRATOR key. A scheduler therefore authored per-shift-type `holiday`
 *    demand without being able to see which dates that demand applied to. The
 *    reviewer recorded it as S-10; the report queued it as **D-10**.
 * 2. OPUS-M2-004 ruled on D-10 by declaring `CATALOGUE_ACTION` on this route:
 *    holiday READ went to holders of `schedule.catalogue.administer`. That
 *    reached the population the ruling named, and it left a stated edge — a
 *    principal granted ONLY the administer key could WRITE holidays and not read
 *    them.
 * 3. OPUS-M3-006's FAD-25 adopted the rule that produced the coupling in the
 *    first place — **write never implies read, read never implies write** — and
 *    assigned the split to this packet.
 *
 * So the read is now `group.holiday_calendar.read`, role-implied for scheduler
 * and group administrator (doc 08 §6 "Author catalogue & rules", both `✓`). The
 * write stays `group.holiday_calendar.administer` on group administrator alone
 * ("Group settings", scheduler `—`). Neither key is inferred from the other in
 * either direction, which is the whole content of the standing rule.
 *
 * **The write-not-read edge closes.** A grant-holder of the administer key reads
 * through the read key, held by the same two roles.
 *
 * **What narrows, stated rather than hidden:** a principal holding
 * `schedule.catalogue.administer` by explicit GRANT and neither role no longer
 * reads holidays through that grant. Nobody is constructed that way today, and
 * leaving reads on the catalogue key is exactly what FAD-25 forbids. Recorded in
 * `docs/evidence/EV-M3-INTEGRATION/INDEX.md`.
 *
 * The baseline capability stays **CAP-004** — the route's traceability is to the
 * holiday slice regardless of which action key gates it, and no CAP-### is added.
 */
export const HOLIDAY_READ_CONFIG = {
  policy: { kind: 'capability', capability: CAP_HOLIDAYS },
  actionScope: 'group',
  action: HOLIDAY_READ_ACTION,
} as const satisfies RouteConfigWithPolicy;

/**
 * `shift_type_qualifications` — the requirement edge (OPUS-M2-004).
 *
 * Authoring a shift type's credential requirements IS catalogue authoring, so it
 * carries the catalogue key rather than a key of its own. The qualification
 * VOCABULARY is `staffing.qualification.administer`'s (OPUS-M2-003); saying
 * "this shift needs that credential" is a statement about the shift.
 */
export const SHIFT_TYPE_QUALIFICATION_CONFIG = {
  policy: { kind: 'capability', capability: CAP_SHIFT_TYPES },
  actionScope: 'group',
  action: CATALOGUE_ACTION,
} as const satisfies RouteConfigWithPolicy;

/**
 * The member-eligibility read, gated by the CREDENTIAL-read key (CAP-058).
 *
 * The answer names shift types, but its sensitive input is
 * `qualification_holdings`, which doc 06 §3.2 classifies `SENSITIVE-PII`. The
 * weaker of the two credential keys is declared for the reason OPUS-M2-003 gives
 * for its own read surface: `…holding.read_any` would stop a member reading
 * their OWN eligibility, and the narrowing belongs in the data rather than in
 * the choice of URL. The RLS SELECT policies decide what comes back — your own
 * holdings always, somebody else's only with `read_any` — so a caller without
 * `read_any` asking about a colleague sees the same thing they would see for a
 * colleague who holds no credentials.
 */
export const ELIGIBILITY_READ_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-058' },
  actionScope: 'group',
  action: {
    key: 'staffing.qualification_holding.read',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/**
 * The event name each catalogue mutation is audited under.
 *
 * Exported and asserted against `AUDIT_EVENT_NAMES` (`apps/api/test/catalogue/
 * audit.test.ts`), so the names are a contract rather than ten strings in ten
 * handlers that quietly diverge — the same discipline
 * `authorization.route.ts`'s `AUDIT_EVENTS` established.
 */
export const CATALOGUE_AUDIT_EVENTS = {
  shiftTypeCreated: 'catalogue.shift_type.created',
  shiftTypeUpdated: 'catalogue.shift_type.updated',
  shiftTypeArchived: 'catalogue.shift_type.archived',
  shiftTypeDemandSet: 'catalogue.shift_type_demand.set',
  shiftGroupCreated: 'catalogue.shift_group.created',
  shiftGroupUpdated: 'catalogue.shift_group.updated',
  staffGroupCreated: 'catalogue.staff_group.created',
  validGroupCreated: 'catalogue.valid_group.created',
  pickPositionsIncreased: 'catalogue.pick_positions.increased',
  groupHolidayCreated: 'catalogue.group_holiday.created',
  shiftTypeQualificationsSet: 'catalogue.shift_type_qualifications.set',
} as const satisfies Record<string, AuditEventName>;

/**
 * Every capability key this slice introduces, for the per-capability deny tests.
 *
 * A list rather than a derivation from the route configs, and that is on
 * purpose: the test walks THIS list and asserts each key is reachable through at
 * least one registered route AND has a deny case. A derivation from the configs
 * could not notice a key that no route uses.
 */
export const CATALOGUE_CAPABILITY_KEYS = [
  'schedule.catalogue.administer',
  'group.holiday_calendar.administer',
  'group.holiday_calendar.read',
  'group.pick_positions.administer',
] as const;
