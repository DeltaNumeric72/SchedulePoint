/**
 * The unit-of-work port — **interface only**.
 *
 * ## Why this file exists in a scaffold
 *
 * OPUS-M0-002 ships no domain logic. This declaration is here so the
 * implementation landed by OPUS-M0-001 (`spikes/sp-a-isolation/`) has a defined
 * place to arrive: the *interface* lives in `packages/domain`, the *implementation*
 * lives in `apps/api` infrastructure, and the dependency-cruiser boundary rule
 * makes it impossible for that direction to reverse.
 *
 * ## Conditions carried over from the spike
 *
 * `spikes/sp-a-isolation/SPIKE-REPORT.md` §7 attaches three conditions to its
 * CONFIRM verdicts. They are recorded here because they constrain any
 * implementation of this interface, and none of them is visible from the type
 * signature alone:
 *
 *  1. **Predicate spelling is normative.** RLS predicates read
 *     `nullif(current_setting('app.<x>', true), '')::uuid` — the setting is
 *     `NULL` *or* `''` (SPIKE-REPORT §6.1 / §7.1). An implementation that
 *     assumes `SET LOCAL` undefines the GUC is wrong.
 *  2. **`set_config(name, value, true)` is the only permitted spelling.** Every
 *     `SET` / `SET SESSION` / `SET LOCAL` form of a tenant setting is banned by
 *     lint, because the only way to write them is to interpolate the tenant id
 *     into SQL — an injection surface at the most security-critical statement in
 *     the system (SPIKE-REPORT §7.2, and the non-bypass rule in CLAUDE.md).
 *  3. **The pooler's mode is asserted at process start**, not only per
 *     transaction; the read-back cannot be the sole control (SPIKE-REPORT §7.3).
 *
 * Recommended-but-not-blocking from the same report: read back **all four**
 * settings rather than one (§6.4).
 *
 * Nothing in this file is executable. When the real implementation lands it
 * replaces the `ports` marker in `./index.ts`, not this contract.
 */

/**
 * The tenant context a caller declares and the server verifies (I-14).
 *
 * A context is never inferred from a row already read, and never substituted
 * when it turns out to be stale — a mismatch is rejected (I-01).
 */
export interface TenantContext {
  readonly organizationId: string;
  readonly actorId: string;
  /** Monotonic version of the actor's membership snapshot; a stale value is rejected. */
  readonly contextVersion: number;
  /** Correlation id threaded through audit rows and logs. */
  readonly correlationId: string;
}

/**
 * The handle a domain operation receives *inside* an open unit of work.
 *
 * There is no `commit()` and no `rollback()` on purpose: the runner owns the
 * transaction boundary, so no domain code can end a transaction early or keep a
 * connection past the callback (I-15, I-22 — exactly one commit point).
 */
export interface UnitOfWork {
  readonly context: TenantContext;
  /**
   * Queries execute only through this handle. The implementation guarantees
   * every statement runs on the one client pinned to this transaction, after
   * transaction-local tenant context has been established and read back.
   */
  readonly query: unknown;
}

/**
 * The only way to touch a tenant table.
 *
 * @remarks
 * Implementations must: open a transaction, establish transaction-local tenant
 * context with `set_config(..., true)`, read the settings back and abort on
 * mismatch, run `fn`, then commit or roll back. The context ends with the
 * transaction. Nesting is not permitted.
 */
export interface UnitOfWorkRunner {
  run<T>(context: TenantContext, fn: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}
