/**
 * @provider-port redcase
 *
 * RED CASE — provider outside unit of work (SPEC-12 U-07), class 1.
 *
 * A declared provider port implementation whose exported entry point does NOT
 * open with `assertOutsideUnitOfWork(...)`. The guard is only a guard if it runs
 * before the work; this one runs after, which lets every caller past it and then
 * complains. The gate must fail on it.
 */

export async function redCaseProviderCall(request: string): Promise<string> {
  const answer = `redcase:${request}`;
  return Promise.resolve(answer);
}
