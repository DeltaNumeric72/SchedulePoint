import type { PrincipalResolver } from '@schedulepoint/domain';

/**
 * The production principal resolver: **it denies everything.**
 *
 * Authentication is not in OPUS-M1-001's scope. The choice that matters is what
 * a server does before the session store exists, and the answer is: serve no
 * authenticated traffic. `/health` is `public` and still answers; every route
 * that needs a principal returns 401.
 *
 * There is deliberately **no** development resolver that trusts a header, an
 * environment variable, or a query parameter. A "just for local development"
 * principal header is one misconfiguration away from being an authentication
 * bypass in production, and the mistake is invisible in review because the code
 * that reads it looks like configuration. The test harness supplies its own
 * resolver through `buildServer`, which means the bypass exists only in the test
 * process and cannot be switched on anywhere else.
 */
export const denyAllPrincipalResolver: PrincipalResolver = {
  resolve: () =>
    Promise.resolve({
      authenticated: false,
      reason:
        'no session backend is configured; authentication lands in a later packet and this ' +
        'server fails closed until it does',
    }),
};
