/**
 * OPUS-M3-003 — the publication spine's wire shapes (SPEC-05).
 *
 * The module ships no HTTP surface this packet (the scheduler-facing routes are
 * OPUS-M3-004/005/006), so what lives here is the part that must be true
 * regardless of transport: the idempotency-key domain and the publication
 * request's required compare-and-set, both ratified by FAD-22.
 */
/**
 * OPUS-M3-004 — the scheduler-facing authoring surface (SPEC-05, doc 07).
 * Re-exported wholesale: the module is one cohesive contract surface, and an
 * omission from a hand-written list is a compile error at the call site.
 */
export * from './authoring.js';

/**
 * OPUS-M3-006 — the staff-facing READ surface (CAP-020, doc 07 §1). Re-exported
 * wholesale for the same reason `authoring.js` is. The module ships no mutation:
 * a published version is immutable (I-18) and staff read it.
 */
export * from './views.js';

export {
  PUBLICATION_IDEMPOTENCY_KEY_PATTERN,
  publicationIdempotencyKeySchema,
  publishVersionRequestSchema,
  type PublicationIdempotencyKey,
  type PublishVersionRequest,
} from './publication.js';

/**
 * OPUS-M3-005 — publication review, confirmation, version history, comparison
 * and the affected-staff read (SPEC-05 §6/§6.1, doc 07). Re-exported wholesale
 * for the same reason `authoring.js` is: the module is one cohesive contract
 * surface, and an omission from a hand-written list is a compile error at the
 * call site.
 */
export * from './versions.js';

/**
 * OPUS-M4-000B — the real calendar-date schema every date field above uses
 * (doc 34 §4-F). Exported so a caller that needs to validate a date outside a
 * request body uses the SAME rule rather than writing a fourth regex.
 */
export {
  calendarDateSchema,
  isCalendarDate,
  type CalendarDate,
} from './calendar-date.js';
