/**
 * `@schedulepoint/contracts` — the single definition of every wire shape the API
 * and the web client exchange.
 *
 * Scaffold scope (OPUS-M0-002): exactly one example contract, proving the typed
 * path api -> contracts -> web. No product contracts live here yet.
 *
 * Rules that apply to everything added to this package later:
 *  - zod is the validation library (21-decision-resolution.md FAD-4).
 *  - Schemas are positive allowlists. `.strict()` on every object so unknown
 *    keys are rejected rather than carried (I-07 alignment).
 *  - This package imports nothing from `apps/**`; it is the shared leaf.
 */
export {
  errorEnvelopeSchema,
  type ErrorEnvelope,
  healthStatusSchema,
  type HealthStatus,
} from './health.js';

export {
  CONTEXT_ERROR_CODES,
  CONTEXT_HEADER,
  contextHeaderSchema,
  contextProbeResultSchema,
  contextStaleBodySchema,
  contextVersionSchema,
  jobEnqueueResultSchema,
  type ContextErrorCode,
  type ContextHeaderWire,
  type ContextProbeResult,
  type ContextStaleBody,
  type ContextVersionWire,
  type JobEnqueueResult,
} from './context.js';

export {
  conflictBodySchema,
  createMembershipRequestSchema,
  createMembershipResultSchema,
  setEntitlementStateRequestSchema,
  setEntitlementStateResultSchema,
  writeGrantRequestSchema,
  writeGrantResultSchema,
  type ConflictBody,
  type CreateMembershipRequest,
  type CreateMembershipResult,
  type SetEntitlementStateRequest,
  type SetEntitlementStateResult,
  type WriteGrantRequest,
  type WriteGrantResult,
} from './authz.js';

/**
 * OPUS-M2-003 — work profiles, weekday/holiday FTE targets, qualifications
 * (CAP-013, CAP-058). Re-exported wholesale rather than key by key: the module is
 * a single cohesive contract surface and an omission from a hand-written list is
 * a compile error at the call site, which is the failure mode this avoids.
 */
export * from './profiles/index.js';

/**
 * OPUS-M2-002 — the scheduling-structure catalogue's wire shapes (CAP-011,
 * CAP-012, CAR-011). The first contracts a product screen consumes.
 */
export * from './catalogue/index.js';

/**
 * OPUS-M2-004 — identifier shapes, so a path parameter can be rejected on its
 * SHAPE before any statement runs (review finding V-02). See the module's
 * docblock for why the api cannot spell this itself.
 */
export * from './identifiers.js';

/**
 * OPUS-M3-001 — authentication, sessions, invitation/activation, password reset
 * and TOTP multi-factor. Read that module's header before adding to it: the
 * single failure body is a control, not a simplification.
 */
export * from './authn/index.js';

/**
 * OPUS-M3-002 — the typed scheduling-rule model's wire shapes (CAP-015, CAP-045,
 * CAR-006; SPEC-04 §3). The predicate is a discriminated union over the closed
 * node set — an unknown `kind` cannot parse, which is the wire half of "no
 * escape hatch". Node kinds/enums are asserted equal to `@schedulepoint/domain`.
 */
export * from './rules/index.js';

/**
 * OPUS-M3-003 — schedule periods, versions and the publication transaction
 * (SPEC-05, FAD-22).
 */
export * from './schedule/index.js';

/**
 * OPUS-M3-007 — group settings (request-until, picklist access, timezone) and
 * `locations` with the free-form `siteLabel` attribute (PO-DEC-01 default,
 * CAR-021). Read that module's header before adding to it: two of the three
 * settings are STORED here and ENFORCED at later milestones, and `siteLabel` is
 * deliberately not an identifier.
 */
export * from './settings/index.js';

/**
 * OPUS-M3-008 — the audit READ surface FAD-26 recorded as missing. Read that
 * module's header before adding to it: the closed-payload CHECK is what makes an
 * audit payload publishable, and this surface reads the chain without ever
 * claiming to verify it.
 */
export * from './audit/index.js';
