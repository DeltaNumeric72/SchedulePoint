/**
 * RED CASE — network-assertion guard (source scan).
 *
 * Client code calling a third-party host. CAP-068 / T-23 make this
 * unconditional: the browser talks to no third party, ever. The guard must fail
 * on first-party source without consulting any allowlist.
 */
export async function reportInteraction(name: string): Promise<void> {
  await fetch('https://analytics.example.com/collect', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}
