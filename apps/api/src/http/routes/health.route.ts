import { healthStatusSchema, type HealthStatus } from '@schedulepoint/contracts';
import type { FastifyInstance } from 'fastify';

import type { RouteConfigWithPolicy } from '../policy.js';

/**
 * `GET /health` — the only route in the scaffold.
 *
 * Its policy is **explicitly public** rather than public-by-omission, which is
 * the whole point: the route-policy gate can only be meaningful if the one
 * route that legitimately needs no principal still has to say so out loud.
 *
 * The response is built through the shared zod contract, so the typed path
 * contracts -> api and contracts -> web is exercised by a real response rather
 * than asserted in a comment.
 */
export default function healthRoute(app: FastifyInstance): void {
  app.get(
    '/health',
    {
      config: {
        policy: {
          kind: 'public',
          reason:
            'Liveness probe for the load balancer and container orchestrator; returns no tenant data and reads no tenant table.',
        },
      } satisfies RouteConfigWithPolicy,
    },
    async (request): Promise<HealthStatus> =>
      healthStatusSchema.parse({
        status: 'ok',
        checkedAt: new Date().toISOString(),
        correlationId: request.correlationId,
      }),
  );
}
