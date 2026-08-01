import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { FastifyInstance } from 'fastify';

/**
 * Route auto-discovery.
 *
 * Every `*.route.ts` (or built `*.route.js`) file in this directory is loaded
 * and registered. Discovery rather than a hand-written import list is a
 * deliberate choice for the route-policy gate: a developer who adds a route file
 * cannot forget to wire it up, which means the gate sees every route that exists
 * rather than every route someone remembered to list.
 */
export type RouteModule = (app: FastifyInstance) => void;

const ROUTE_FILE = /\.route\.(ts|js)$/;

export function discoverRouteFiles(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return readdirSync(here)
    .filter((name) => ROUTE_FILE.test(name) && !name.endsWith('.d.ts'))
    .sort()
    .map((name) => join(here, name));
}

export async function registerRoutes(app: FastifyInstance): Promise<string[]> {
  const files = discoverRouteFiles();

  for (const file of files) {
    const loaded: unknown = await import(pathToFileURL(file).href);
    const register = (loaded as { default?: unknown }).default;
    if (typeof register !== 'function') {
      throw new Error(`Route file has no default export function: ${file}`);
    }
    (register as RouteModule)(app);
  }

  return files;
}
