/**
 * The provider/unit-of-work boundary — **SPEC-12 U-07**, doc 34 §4-H.
 *
 * ## The rule
 *
 * > A provider or RPC call may not occur inside a database unit of work.
 *
 * Database snapshot creation and external execution are two phases, not one.
 * A provider call inside an open transaction holds a pooled connection and an
 * advisory/row lock for the duration of somebody else's network, which is how a
 * solve that takes ninety seconds turns into a period-wide lock held for ninety
 * seconds — and then into a connection-pool exhaustion that looks like a
 * database fault rather than like the call that caused it. Worse for
 * correctness: a provider that succeeds inside a transaction that then rolls
 * back has produced an external effect the database has no record of, which is
 * the one failure mode a single-commit-point architecture (I-22) exists to
 * prevent.
 *
 * This is implemented **before any provider exists** on purpose. The M4-001
 * solver RPC is the first one, and the packet's ordering is deliberate: the
 * structural separation is proven first, so the solver is written against a
 * boundary that already refuses, rather than having a boundary retrofitted
 * around a solver that already works.
 *
 * ## Two layers, and why the runtime one is not redundant
 *
 * - **Static** — `scripts/gates/provider-boundary-check.mjs` fails the build on a
 *   provider entry point that does not open with the guard, and on a
 *   unit-of-work callback that names a provider module. It is a source scan, so
 *   it catches the ordinary case at review time.
 * - **Runtime** — this module. A dynamic import, a callback captured outside the
 *   transaction and invoked inside it, an indirection through a map of
 *   functions: every one of those is invisible to a source scan and all of them
 *   are reachable. The runtime guard is what makes the rule true rather than
 *   merely tidy, and the red case deliberately attacks the lint through an
 *   indirection to prove the runtime arm still fires.
 *
 * ## Pure, and why the probe is injected rather than imported
 *
 * `@schedulepoint/domain` imports nothing — not a framework, not a driver, not a
 * node builtin (`.dependency-cruiser.cjs`, `domain-imports-nothing`). The thing
 * that actually knows whether a transaction is open is an `AsyncLocalStorage` in
 * `apps/api/src/db/provider-boundary.ts`, which is infrastructure. So the
 * *decision* lives here as a total function over a probe result, exactly as
 * {@link readBackMismatches} does for the read-back, and the *observation* is
 * injected. That split is what lets the decision be tested without a database
 * and keeps the layering intact.
 *
 * ## Fail-closed when nothing is installed
 *
 * An absent probe is treated as a REFUSAL, not as permission. "I could not tell
 * whether a transaction was open" and "no transaction was open" are different
 * answers, and only one of them is safe to act on. A process that forgets to
 * install the boundary therefore cannot call a provider at all — loudly, at the
 * first call, rather than quietly forever.
 */

/** What the runtime knows about the unit of work in the calling async context. */
export interface ActiveUnitOfWorkMark {
  /** 0 for the outermost unit of work; >0 inside a savepoint. */
  readonly depth: number;
  /** The correlation id the transaction was opened with. Never user text. */
  readonly correlationId: string;
}

/**
 * The observation the infrastructure supplies.
 *
 * Returns the mark of the unit of work enclosing the CALLING async context, or
 * `undefined` when there is none. It must be async-context aware: a provider
 * called from a `.then()` three levels below the transaction callback is still
 * inside the transaction, and a probe that only looked at a module-level flag
 * would say otherwise under any concurrency at all.
 */
export interface ProviderBoundaryProbe {
  activeUnitOfWork(): ActiveUnitOfWorkMark | undefined;
}

/**
 * The verdict, as data.
 *
 * A discriminated result rather than a boolean, because the two refusals are
 * different operational events: one is a code defect in the caller, the other is
 * a misconfigured process.
 */
export type ProviderBoundaryVerdict =
  | { readonly outcome: 'permitted' }
  | { readonly outcome: 'refused'; readonly reason: 'boundary-not-installed' }
  | {
      readonly outcome: 'refused';
      readonly reason: 'inside-unit-of-work';
      readonly active: ActiveUnitOfWorkMark;
    };

/**
 * The whole decision, pure and total.
 *
 * @param probe the runtime observation, or `undefined` when none is installed.
 */
export function providerBoundaryVerdict(
  probe: ProviderBoundaryProbe | undefined,
): ProviderBoundaryVerdict {
  if (probe === undefined) return { outcome: 'refused', reason: 'boundary-not-installed' };
  const active = probe.activeUnitOfWork();
  if (active === undefined) return { outcome: 'permitted' };
  return { outcome: 'refused', reason: 'inside-unit-of-work', active };
}

/**
 * Raised when a provider port entry point is reached inside a unit of work.
 *
 * The message names the provider and the transaction depth and **nothing else**
 * — no payload, no query, no user text (I-07, I-17, non-bypass rule 9).
 */
export class ProviderInsideUnitOfWorkError extends Error {
  readonly code = 'PROVIDER_INSIDE_UNIT_OF_WORK';

  constructor(
    readonly providerName: string,
    readonly active: ActiveUnitOfWorkMark,
  ) {
    super(
      `PROVIDER_INSIDE_UNIT_OF_WORK: provider '${providerName}' was called inside an open ` +
        `unit of work (depth ${String(active.depth)}). SPEC-12 U-07: database snapshot ` +
        'creation and external execution are separate phases — assemble inside the ' +
        'transaction, call the provider after it commits.',
    );
    this.name = 'ProviderInsideUnitOfWorkError';
  }
}

/**
 * Raised when no boundary probe has been installed in this process.
 *
 * Fail-closed: the call is refused rather than permitted, because the guard
 * cannot answer the question it exists to answer.
 */
export class ProviderBoundaryNotInstalledError extends Error {
  readonly code = 'PROVIDER_BOUNDARY_NOT_INSTALLED';

  constructor(readonly providerName: string) {
    super(
      `PROVIDER_BOUNDARY_NOT_INSTALLED: provider '${providerName}' was called before a ` +
        'unit-of-work boundary probe was installed. The guard cannot tell whether a ' +
        'transaction is open, so the call is refused (SPEC-12 U-07, fail-closed).',
    );
    this.name = 'ProviderBoundaryNotInstalledError';
  }
}

/**
 * The assertion every provider port entry point makes, expressed over an
 * injected probe.
 *
 * `apps/api/src/db/provider-boundary.ts` wraps this with the installed probe and
 * exports the zero-configuration `assertOutsideUnitOfWork(providerName)` that
 * call sites actually use; the static gate checks for that call.
 */
export function assertProviderOutsideUnitOfWork(
  providerName: string,
  probe: ProviderBoundaryProbe | undefined,
): void {
  const verdict = providerBoundaryVerdict(probe);
  if (verdict.outcome === 'permitted') return;
  if (verdict.reason === 'boundary-not-installed') {
    throw new ProviderBoundaryNotInstalledError(providerName);
  }
  throw new ProviderInsideUnitOfWorkError(providerName, verdict.active);
}
