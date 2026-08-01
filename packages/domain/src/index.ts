/**
 * `@schedulepoint/domain` — the layering root.
 *
 * Scaffold scope (OPUS-M0-002): **no domain logic exists yet.** This package
 * exists so that the boundary is enforced from the first commit rather than
 * retrofitted, and so that OPUS-M0-001's unit-of-work has a defined landing
 * spot.
 *
 * The boundary, enforced by `.dependency-cruiser.cjs` rule
 * `domain-imports-nothing-outward` and proved by
 * `scripts/red-cases/import-boundary/`:
 *
 *   packages/domain  ->  (nothing)
 *   packages/contracts -> zod only
 *   apps/api         ->  domain, contracts, infrastructure
 *   apps/web         ->  contracts
 *
 * Domain has **zero** runtime dependencies: no Fastify, no Kysely, no `pg`, no
 * React, nothing from `apps/**`. Everything the domain needs from the outside
 * world arrives as a port (an interface declared here, implemented in `apps/api`).
 */
export type { TenantContext, UnitOfWork, UnitOfWorkRunner } from './ports/unit-of-work.js';
export { ports } from './ports/index.js';
