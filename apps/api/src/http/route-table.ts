import type { FastifyInstance } from 'fastify';

import { isRoutePolicy, type RoutePolicy } from './policy.js';

/** One row of the enumerated route table. */
export interface RouteTableEntry {
  readonly method: string;
  readonly url: string;
  /** `undefined` when the route was registered without a policy — a build failure. */
  readonly policy: RoutePolicy | undefined;
  /**
   * The route's whole `config` object, exactly as registered.
   *
   * `policy` above is the field the route-policy gate reads. This carries
   * everything else a route declares — `actionScope` and `provisional` for a
   * capability route — so a test can assert against **what was registered**
   * rather than against a re-derived copy. Stripping it was how the scope
   * declaration went unchecked in the first place.
   */
  readonly config: unknown;
}

/**
 * Collects every route Fastify registers, whatever path it was registered
 * through.
 *
 * This deliberately hooks `onRoute` rather than reading a hand-maintained list.
 * A hand-maintained list can be complete while the server is not; `onRoute`
 * fires for every `app.get`/`app.route`/plugin-registered route, so a route that
 * skips the project's own helpers is still caught.
 */
export function createRouteTable(): {
  entries: RouteTableEntry[];
  plugin: (app: FastifyInstance) => void;
} {
  const entries: RouteTableEntry[] = [];

  const plugin = (app: FastifyInstance): void => {
    app.addHook('onRoute', (routeOptions) => {
      // HEAD is synthesised by Fastify for every GET; it inherits the GET config
      // and is not a separately declarable surface.
      const methods = Array.isArray(routeOptions.method)
        ? routeOptions.method
        : [routeOptions.method];

      const config = routeOptions.config;
      const candidate = (config as { policy?: unknown } | undefined)?.policy;
      const policy = isRoutePolicy(candidate) ? candidate : undefined;

      for (const method of methods) {
        entries.push({ method, url: routeOptions.url, policy, config });
      }
    });
  };

  return { entries, plugin };
}

/** Routes with no valid policy declaration. Non-empty means the build fails. */
export function undeclaredRoutes(entries: readonly RouteTableEntry[]): RouteTableEntry[] {
  return entries.filter((entry) => entry.policy === undefined && entry.method !== 'HEAD');
}
