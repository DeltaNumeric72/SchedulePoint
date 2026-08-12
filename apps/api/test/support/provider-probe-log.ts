/**
 * The probe provider's observation log.
 *
 * Deliberately a SEPARATE module from `provider-probe.ts`, and the separation is
 * the point rather than tidiness: `provider-probe.ts` declares
 * `@provider-port probe`, and the static gate requires **every** exported
 * function of a provider module to open with the boundary guard. A bookkeeping
 * helper that opened with the guard would be a guard call that means nothing,
 * and one that did not would be a gate exemption — and an exemption is how a
 * "every entry point is guarded" rule becomes "every entry point somebody
 * remembered to guard".
 *
 * So the provider module contains provider entry points and nothing else.
 */

/** Every call the probe provider was permitted to perform. Reset per test. */
export const probeProviderCalls: string[] = [];

export function resetProbeProvider(): void {
  probeProviderCalls.length = 0;
}
