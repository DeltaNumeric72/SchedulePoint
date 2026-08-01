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
