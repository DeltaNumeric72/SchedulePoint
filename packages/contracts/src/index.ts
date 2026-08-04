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
