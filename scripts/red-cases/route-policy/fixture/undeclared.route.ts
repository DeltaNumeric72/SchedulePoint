/**
 * RED CASE — route-without-policy.
 *
 * A route registered with no `config.policy`. Auto-discovery picks it up, the
 * `onRoute` hook records it with an undefined policy, and the gate must fail
 * (I-02: an operation with no policy fails closed and fails its automated test).
 */
import type { FastifyInstance } from 'fastify';

export default function redCaseRoute(app: FastifyInstance): void {
  app.post('/red-case/undeclared', async () => ({ ok: true }));
}
