import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, fetchHealth } from '../src/api/client.js';

function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (): Promise<Response> =>
        ({
          ok: status >= 200 && status < 300,
          status,
          json: async (): Promise<unknown> => body,
        }) as Response,
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchHealth', () => {
  it('parses a valid response through the shared contract', async () => {
    stubFetch(200, {
      status: 'ok',
      checkedAt: '2026-08-01T00:00:00.000Z',
      correlationId: 'c-1',
    });

    await expect(fetchHealth()).resolves.toMatchObject({ status: 'ok', correlationId: 'c-1' });
  });

  it('rejects a response the contract does not accept', async () => {
    stubFetch(200, { status: 'ok' });
    await expect(fetchHealth()).rejects.toThrow();
  });

  it('maps a typed error envelope onto ApiError, preserving the correlation id', async () => {
    stubFetch(404, {
      error: { code: 'ROUTE_NOT_FOUND', message: 'No such route.', correlationId: 'c-9' },
    });

    await expect(fetchHealth()).rejects.toBeInstanceOf(ApiError);
    await expect(fetchHealth()).rejects.toMatchObject({
      code: 'ROUTE_NOT_FOUND',
      correlationId: 'c-9',
    });
  });

  it('does not invent a code when the body is not an envelope', async () => {
    stubFetch(500, '<html>gateway</html>');
    await expect(fetchHealth()).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('only ever calls a same-origin, relative URL', async () => {
    stubFetch(200, {
      status: 'ok',
      checkedAt: '2026-08-01T00:00:00.000Z',
      correlationId: 'c-1',
    });

    await fetchHealth();

    const mock = vi.mocked(globalThis.fetch);
    const url = String(mock.mock.calls[0]?.[0]);
    expect(url.startsWith('/')).toBe(true);
    expect(url).not.toMatch(/^https?:/);
  });
});
