import { CONTEXT_HEADER } from '@schedulepoint/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRequest } from '../src/api/client.js';
import { resetContextCache, scopeOf } from '../src/api/context.js';

/**
 * **NAMED PROOF — the browser DECLARES its context (SPEC-01 §2.2, FAD-48).**
 *
 * The client half of the declare/verify contract, tested at the one place it can
 * be tested without a server: what goes on the wire. Five properties, each of
 * which a plausible implementation gets wrong:
 *
 *  1. a capability request carries `X-SchedulePoint-Context`, with the counters
 *     the context endpoint returned and no others;
 *  2. a GROUP-scoped path declares that group's counter; an ORGANIZATION-scoped
 *     path declares `groupVersion: null` — the same selection
 *     `packages/domain/src/context/verification.ts` makes on the other side;
 *  3. **I-10** — the context is read ONCE per organization however many requests
 *     follow, including when two are issued concurrently;
 *  4. `409 CONTEXT_STALE` re-reads and retries EXACTLY once;
 *  5. the pre-auth surface and `/health` declare nothing, and never trigger a
 *     context read — a sign-in that depended on being signed in would be a
 *     bootstrap deadlock.
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';

const CONTEXT_BODY = {
  organizationId: ORGANIZATION,
  userId: '33333333-3333-4333-8333-333333333333',
  organizationVersion: 7,
  membershipSetVersion: 3,
  sessionEpoch: 2,
  memberships: [
    {
      membershipId: '44444444-4444-4444-8444-444444444444',
      kind: 'group',
      groupId: GROUP,
      groupVersion: 11,
      status: 'active',
      organizationRole: null,
      groupRole: 'scheduler',
    },
  ],
};

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** The recorded calls, oldest first. */
let calls: Call[] = [];

/**
 * A fetch stub driven by a queue of answers keyed by URL substring.
 *
 * Deliberately NOT a single canned response: the retry proof needs the SAME url
 * to answer differently the first and second time, and a stub that cannot do
 * that would make the retry test pass for the wrong reason.
 */
function stubFetch(
  answer: (url: string, index: number) => { status: number; body: unknown },
): void {
  calls = [];
  let index = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const { status, body } = answer(url, index);
      index += 1;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async (): Promise<unknown> => body,
      } as Response;
    }),
  );
}

function declarationOf(call: Call): {
  contextVersion: {
    organizationVersion: number;
    groupVersion: number | null;
    membershipSetVersion: number;
  };
  sessionEpoch: number;
} {
  const raw = call.headers[CONTEXT_HEADER];
  expect(raw, `no ${CONTEXT_HEADER} on ${call.url}`).toBeDefined();
  return JSON.parse(raw!) as ReturnType<typeof declarationOf>;
}

beforeEach(() => {
  resetContextCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetContextCache();
});

describe('which paths declare a context at all', () => {
  it('recognises an organization path and a group path, and refuses the two exclusions', () => {
    expect(scopeOf(`/organizations/${ORGANIZATION}/shift-types`)).toEqual({
      organizationId: ORGANIZATION,
      groupId: null,
    });
    expect(scopeOf(`/organizations/${ORGANIZATION}/groups/${GROUP}/rules`)).toEqual({
      organizationId: ORGANIZATION,
      groupId: GROUP,
    });
    // The pre-auth surface: there is no session yet to read a context with.
    expect(scopeOf(`/organizations/${ORGANIZATION}/authn/sign-in`)).toBeUndefined();
    // The read itself: anything else is an infinite regress.
    expect(scopeOf(`/organizations/${ORGANIZATION}/me/context`)).toBeUndefined();
    // No tenant at all.
    expect(scopeOf('/health')).toBeUndefined();
    // A malformed organization id is not a tenant path — the same strict UUID
    // spelling `declared.ts` uses, so the two cannot disagree about a URL.
    expect(scopeOf('/organizations/not-a-uuid/shift-types')).toBeUndefined();
  });
});

describe('the declaration that goes on the wire', () => {
  it('a group-scoped request declares that group version; an organization-scoped one declares null', async () => {
    stubFetch((url) =>
      url.includes('/me/context')
        ? { status: 200, body: CONTEXT_BODY }
        : { status: 200, body: { ok: true } },
    );

    await apiRequest(`/organizations/${ORGANIZATION}/groups/${GROUP}/rules`);
    await apiRequest(`/organizations/${ORGANIZATION}/shift-types`);

    const groupCall = calls.find((call) => call.url.includes('/rules'))!;
    const organizationCall = calls.find((call) => call.url.includes('/shift-types'))!;

    expect(declarationOf(groupCall)).toEqual({
      contextVersion: { organizationVersion: 7, groupVersion: 11, membershipSetVersion: 3 },
      sessionEpoch: 2,
    });
    expect(declarationOf(organizationCall)).toEqual({
      contextVersion: { organizationVersion: 7, groupVersion: null, membershipSetVersion: 3 },
      sessionEpoch: 2,
    });
  });

  it('a caller CANNOT override the declaration with its own header (FAD-50 N-8)', async () => {
    /* The declaration is the client's half of SPEC-01 §2.2's declare/verify
     * contract. It used to be spread BEFORE `init.headers`, so a caller passing
     * a header bag could replace it and the server would then verify whatever
     * had been substituted — silently, since both are well-formed requests.
     * Nothing in the tree did this; the point is that nothing can. */
    stubFetch((url) =>
      url.includes('/me/context')
        ? { status: 200, body: CONTEXT_BODY }
        : { status: 200, body: { ok: true } },
    );

    await apiRequest(`/organizations/${ORGANIZATION}/groups/${GROUP}/rules`, {
      headers: {
        [CONTEXT_HEADER]: JSON.stringify({
          contextVersion: { organizationVersion: 1, groupVersion: 1, membershipSetVersion: 1 },
          sessionEpoch: 1,
        }),
      },
    });

    const call = calls.find((entry) => entry.url.includes('/rules'))!;
    /* The REAL counters, not the forged ones. */
    expect(declarationOf(call)).toEqual({
      contextVersion: { organizationVersion: 7, groupVersion: 11, membershipSetVersion: 3 },
      sessionEpoch: 2,
    });
  });

  it('I-10: the context is read ONCE, even for concurrent requests', async () => {
    stubFetch((url) =>
      url.includes('/me/context')
        ? { status: 200, body: CONTEXT_BODY }
        : { status: 200, body: { ok: true } },
    );

    await Promise.all([
      apiRequest(`/organizations/${ORGANIZATION}/shift-types`),
      apiRequest(`/organizations/${ORGANIZATION}/groups/${GROUP}/rules`),
      apiRequest(`/organizations/${ORGANIZATION}/periods`),
    ]);

    const contextReads = calls.filter((call) => call.url.includes('/me/context'));
    expect(contextReads, 'the context was read more than once').toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it('the pre-auth surface and /health declare nothing and read no context', async () => {
    stubFetch(() => ({ status: 200, body: { state: 'authenticated' } }));

    await apiRequest(`/organizations/${ORGANIZATION}/authn/sign-in`, { method: 'POST' });
    await apiRequest('/health');

    expect(calls.some((call) => call.url.includes('/me/context'))).toBe(false);
    for (const call of calls) {
      expect(call.headers[CONTEXT_HEADER]).toBeUndefined();
    }
  });
});

describe('409 CONTEXT_STALE — one re-read, one retry, and no more', () => {
  it('re-reads the context and replays the request exactly once', async () => {
    let contextReads = 0;
    stubFetch((url) => {
      if (url.includes('/me/context')) {
        contextReads += 1;
        return {
          status: 200,
          body: contextReads === 1 ? CONTEXT_BODY : { ...CONTEXT_BODY, organizationVersion: 8 },
        };
      }
      // The first attempt is stale; the replay succeeds.
      return contextReads === 1
        ? {
            status: 409,
            body: {
              error: {
                code: 'CONTEXT_STALE',
                message: 'The context is stale.',
                correlationId: 'c-1',
                recover: 'refetch-context',
              },
            },
          }
        : { status: 200, body: { ok: true } };
    });

    await expect(apiRequest(`/organizations/${ORGANIZATION}/shift-types`)).resolves.toEqual({
      ok: true,
    });

    expect(contextReads, 'the context was not re-read exactly once').toBe(2);
    const attempts = calls.filter((call) => call.url.includes('/shift-types'));
    expect(attempts, 'the request was replayed more than once').toHaveLength(2);
    expect(declarationOf(attempts[0]!).contextVersion.organizationVersion).toBe(7);
    expect(declarationOf(attempts[1]!).contextVersion.organizationVersion).toBe(8);
  });

  it('a SECOND stale answer is surfaced, not retried again', async () => {
    let requestAttempts = 0;
    stubFetch((url) => {
      if (url.includes('/me/context')) return { status: 200, body: CONTEXT_BODY };
      requestAttempts += 1;
      return {
        status: 409,
        body: {
          error: {
            code: 'CONTEXT_STALE',
            message: 'The context is stale.',
            correlationId: 'c-2',
            recover: 'refetch-context',
          },
        },
      };
    });

    await expect(apiRequest(`/organizations/${ORGANIZATION}/shift-types`)).rejects.toMatchObject({
      code: 'CONTEXT_STALE',
    });
    expect(requestAttempts, 'the client retried more than once').toBe(2);
  });

  it('SESSION_STALE is NOT retried — its directive is to re-authenticate', async () => {
    let requestAttempts = 0;
    stubFetch((url) => {
      if (url.includes('/me/context')) return { status: 200, body: CONTEXT_BODY };
      requestAttempts += 1;
      return {
        status: 409,
        body: {
          error: {
            code: 'SESSION_STALE',
            message: 'The session is stale.',
            correlationId: 'c-3',
            recover: 'reauthenticate',
          },
        },
      };
    });

    await expect(apiRequest(`/organizations/${ORGANIZATION}/shift-types`)).rejects.toMatchObject({
      code: 'SESSION_STALE',
    });
    expect(requestAttempts, 'a SESSION_STALE answer must not be replayed').toBe(1);
  });
});

describe('a context that cannot be read is a failure, not a silent omission', () => {
  it('a failed context read rejects the request rather than sending no declaration', async () => {
    stubFetch((url) =>
      url.includes('/me/context')
        ? {
            status: 401,
            body: { error: { code: 'UNAUTHENTICATED', message: 'no', correlationId: 'c' } },
          }
        : { status: 200, body: { ok: true } },
    );

    await expect(apiRequest(`/organizations/${ORGANIZATION}/shift-types`)).rejects.toThrow();
    // And the capability request was never sent undeclarated — a request without
    // the header would be refused by the server anyway, but sending it would
    // make a failed bootstrap look like an authorization problem.
    expect(calls.filter((call) => call.url.includes('/shift-types'))).toHaveLength(0);
  });

  it('a failed context read is NOT cached — the next attempt tries again', async () => {
    let attempt = 0;
    stubFetch((url) => {
      if (url.includes('/me/context')) {
        attempt += 1;
        return attempt === 1
          ? { status: 503, body: undefined }
          : { status: 200, body: CONTEXT_BODY };
      }
      return { status: 200, body: { ok: true } };
    });

    await expect(apiRequest(`/organizations/${ORGANIZATION}/shift-types`)).rejects.toThrow();
    await expect(apiRequest(`/organizations/${ORGANIZATION}/shift-types`)).resolves.toEqual({
      ok: true,
    });
    expect(attempt).toBe(2);
  });
});
