import { errorEnvelopeSchema, healthStatusSchema } from '@schedulepoint/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CORRELATION_ID_HEADER } from '../src/http/correlation-id.js';
import { undeclaredRoutes, type RouteTableEntry } from '../src/http/route-table.js';
import { buildServer } from '../src/http/server.js';

let app: FastifyInstance;
let routeTable: readonly RouteTableEntry[];

beforeAll(async () => {
  ({ app, routeTable } = await buildServer());
});

afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('returns a payload that satisfies the shared contract', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const parsed = healthStatusSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
  });

  it('declares an explicit public policy', () => {
    const entry = routeTable.find((r) => r.url === '/health' && r.method === 'GET');
    expect(entry?.policy?.kind).toBe('public');
    expect(entry?.policy?.kind === 'public' && entry.policy.reason.length).toBeGreaterThan(20);
  });
});

describe('correlation id', () => {
  it('echoes an acceptable client-supplied id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { [CORRELATION_ID_HEADER]: 'abc12345' },
    });

    expect(response.headers[CORRELATION_ID_HEADER]).toBe('abc12345');
    expect(response.json<{ correlationId: string }>().correlationId).toBe('abc12345');
  });

  it('replaces — never sanitises — an unacceptable id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { [CORRELATION_ID_HEADER]: 'no spaces or <angle> brackets allowed' },
    });

    const echoed = response.headers[CORRELATION_ID_HEADER];
    expect(echoed).not.toContain('<');
    expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates one when the client sends none', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers[CORRELATION_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('error envelope', () => {
  it('wraps a 404 in the typed envelope with the correlation id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/no-such-thing',
      headers: { [CORRELATION_ID_HEADER]: 'corr1234' },
    });

    expect(response.statusCode).toBe(404);
    const parsed = errorEnvelopeSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.error.code).toBe('ROUTE_NOT_FOUND');
    expect(parsed.success && parsed.data.error.correlationId).toBe('corr1234');
  });
});

describe('route table', () => {
  it('has no route without a policy declaration', () => {
    expect(undeclaredRoutes(routeTable)).toEqual([]);
  });

  it('flags a route registered without a policy', () => {
    // The gate's own red case, in unit-test form: prove `undeclaredRoutes`
    // actually reports rather than silently tolerating.
    const withOffender: RouteTableEntry[] = [
      ...routeTable,
      { method: 'POST', url: '/rogue', policy: undefined, config: {} },
    ];
    expect(undeclaredRoutes(withOffender).map((r) => r.url)).toEqual(['/rogue']);
  });
});
