import { z } from 'zod';

/**
 * Group settings — the request-until policy, the picklist-access mode, and
 * timezone administration (OPUS-M3-007; carried M2 items 4, 5 and 6).
 *
 * The same rules as the catalogue contracts: `.strict()` throughout, no denial
 * reason in any body, and validation problems addressed to the field that caused
 * them so the authoring form's summary can link to it.
 *
 * ## Two of these three settings are STORED, not enforced
 *
 * Packet 32 §2 rows 5 and 6 assign enforcement of the request-until policy to
 * **M5** (SPEC-08, the request lifecycle) and of picklist access to **M9**
 * (SPEC-02, the turn transaction). Nothing in this milestone reads either value
 * to decide anything, and the interface says so on the page rather than
 * implying a gate that does not exist yet. Neither capability is dropped: each
 * has a named owning milestone, a production gate and an evidence bundle.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * The request-until policy
 * ──────────────────────────────────────────────────────────────────────────── */

/** `YYYY-MM-DD`. A calendar date, not an instant: a deadline has no time zone. */
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is YYYY-MM-DD');

export const REQUEST_UNTIL_MODES = ['closed', 'fixed_date', 'days_before_period_start'] as const;

export type RequestUntilMode = (typeof REQUEST_UNTIL_MODES)[number];

/**
 * A discriminated union, mirroring the database's `groups_request_until_shape`
 * CHECK character for character.
 *
 * ## Why three modes and not one nullable date
 *
 * The observed product carries a single absolute date (research 01 §ADM-01), and
 * research 02 §4 records the two states staff actually see: **"(CLOSED)"** and
 * **"(UNTIL `<date>`)"**. SPEC-08 §5 and doc 09 §3 both name the group's
 * `request_until_date` **policy** as the thing a request's `expires_at` is
 * computed from, server-side, at submission.
 *
 * One nullable date expresses two of those three things, and it collapses
 * "deliberately closed" and "never configured" into the same value. That is the
 * distinction the M5 enforcement most needs: the first is a decision and the
 * second is a gap, and a group whose window nobody has set must not silently
 * read as a group that closed it.
 *
 * `days_before_period_start` is a **SCHEDULEPOINT-REQUIREMENT, not an observed
 * fact**, and is labelled as one wherever it appears. It exists because a fixed
 * date is a deadline somebody has to remember to move every period — and this
 * schema already carries `group_holidays` for the sibling problem (CAR-011: "the
 * deadline is Friday" is ambiguous when Friday is a holiday). It reproduces
 * nothing.
 *
 * Modelled as a union rather than a mode plus two optional fields because the
 * meaningless combinations must be unrepresentable on the wire as well as in the
 * table — the same discipline `shiftGroupScoringSchema` applies to the
 * hard/weighted pair.
 */
export const requestUntilPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('closed') }).strict(),
  z.object({ mode: z.literal('fixed_date'), untilDate: calendarDate }).strict(),
  z
    .object({
      mode: z.literal('days_before_period_start'),
      /**
       * Bounded 0..365 by the same CHECK the column carries. Zero is meaningful
       * — "accepted up to the day the period starts" — and is not the same as
       * `closed`.
       */
      leadDays: z.number().int().min(0).max(365),
    })
    .strict(),
]);

export type RequestUntilPolicy = z.infer<typeof requestUntilPolicySchema>;

export const setRequestUntilRequestSchema = z
  .object({
    policy: requestUntilPolicySchema,
    /**
     * The `version` this transaction read, echoed back so a lost update becomes
     * a `409` rather than a silent overwrite. Read and write happen in the same
     * unit of work on the server, so the version the writer checks is the
     * version the reader saw.
     */
    expectedVersion: z.number().int().min(1),
  })
  .strict();

export type SetRequestUntilRequest = z.infer<typeof setRequestUntilRequestSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * The picklist-access mode
 * ──────────────────────────────────────────────────────────────────────────── */

export const PICKLIST_ACCESS_MODES = ['disabled', 'members', 'members_and_proxies'] as const;

export type PicklistAccessMode = (typeof PICKLIST_ACCESS_MODES)[number];

/**
 * A closed enum of SchedulePoint's own picklist access modes.
 *
 * ## What is OBSERVED here is that a control exists. Nothing else.
 *
 * Research 17 GAP-17 records a group-level "Pick List Access" control in the
 * source's group settings, found late and never exercised. Contradiction C-02 is
 * still open and still blocking, and doc 05 §5 states the consequence outright:
 * **"the source's `Picklist Admin` / `Pick List Access` semantics remain
 * UNRESOLVED and are not asserted anywhere in this design."** So this is not a
 * reconstruction of that control; the members below are drawn from
 * SchedulePoint's own model:
 *
 * | mode | meaning | source |
 * |---|---|---|
 * | `disabled` | this group runs no picklist turns | the safe default |
 * | `members` | members holding the turn capability take their own turns | doc 08 §6, "Picklist: take own turn / proxy" |
 * | `members_and_proxies` | additionally, a proxy grant-holder may act on behalf of a member | PO-DEC-19 default scope, CAP-034 |
 *
 * ## The property that keeps this from becoming a fifth authorization layer
 *
 * **The setting can only ever NARROW. It never grants.** PO-DEC-02's four layers
 * decide whether a principal may act; when M9 enforces this it applies as an
 * additional AND *after* them. `members_and_proxies` therefore confers proxy
 * rights on nobody — it declines to withhold them from a principal who already
 * holds the grant.
 *
 * That is why `disabled` is the default. A setting whose default widened
 * anything would be a capability expansion arriving through a migration
 * (non-bypass rule 11), and the safest default is the one that grants nothing to
 * a group nobody has configured.
 */
export const picklistAccessModeSchema = z.enum(PICKLIST_ACCESS_MODES);

export const setPicklistAccessRequestSchema = z
  .object({
    mode: picklistAccessModeSchema,
    expectedVersion: z.number().int().min(1),
  })
  .strict();

export type SetPicklistAccessRequest = z.infer<typeof setPicklistAccessRequestSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Timezone administration
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * An IANA time-zone identifier, validated by asking the platform's own zone
 * database whether it knows the name.
 *
 * `Intl.DateTimeFormat` throws `RangeError` on an unknown `timeZone`, which is a
 * real check against real data rather than a regex that admits
 * `Not/A_Real_Zone`. It is pure, needs no I/O, and is the same answer the server
 * and the browser both give — so a zone the client accepts is a zone the server
 * accepts.
 *
 * The 64-character ceiling mirrors the column's CHECK (`length(timezone) BETWEEN
 * 1 AND 64`, migration 0009).
 */
export function isKnownTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  try {
    // Constructed for its validation throw; the formatter itself is discarded.
    void new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isKnownTimeZone, 'that is not a time zone this system recognises');

export const setTimezoneRequestSchema = z
  .object({
    timezone: timeZoneSchema,
    expectedVersion: z.number().int().min(1),
    /**
     * The administrator's acknowledgement that they have read the consequence
     * of changing a group's zone while published schedules exist.
     *
     * **Required only when there are published versions**, and the server
     * decides that — not the client. A client that could decide when the
     * acknowledgement is needed is a client that can decide it is never needed.
     * Packet 32 §10c requires the change to be *permitted* while published
     * schedules exist, with an explicit warning surfaced and audited; this is
     * the field that makes "surfaced" checkable rather than decorative.
     */
    acknowledgePublishedImpact: z.boolean().default(false),
  })
  .strict();

export type SetTimezoneRequest = z.infer<typeof setTimezoneRequestSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * The read
 * ──────────────────────────────────────────────────────────────────────────── */

export const groupSettingsSchema = z
  .object({
    groupId: z.string().uuid(),
    requestUntil: requestUntilPolicySchema,
    picklistAccessMode: picklistAccessModeSchema,
    timezone: z.string().min(1),
    /**
     * How many schedule versions in this group are currently published.
     *
     * Carried on the settings read so the timezone panel can state the
     * consequence BEFORE the administrator acts, rather than after. A warning
     * that appears only in an error message is a warning that arrived too late
     * to be one — the same reasoning the pick-position control already applies
     * to its irreversibility notice.
     */
    publishedVersionCount: z.number().int().min(0),
    /** Optimistic-concurrency token. Database-owned; the client only echoes it. */
    version: z.number().int().min(1),
    correlationId: z.string().min(1),
  })
  .strict();

export type GroupSettings = z.infer<typeof groupSettingsSchema>;
