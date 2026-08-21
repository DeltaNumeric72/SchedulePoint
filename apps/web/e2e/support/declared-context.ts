import type { Page } from '@playwright/test';

/**
 * The `GET /me/context` interception the mocked specs need (FAD-48).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Why every intercepting spec suddenly needs this
 *
 * Since FAD-48 the shipped client DECLARES its context on every capability
 * request (SPEC-01 §2.2), and it learns what to declare from
 * `GET /organizations/{org}/me/context`. The specs in this directory intercept
 * the API and fulfil fabricated JSON; an un-intercepted context read would fall
 * through to the `vite preview` static server, return an HTML 404, and every
 * subsequent request in the spec would fail before it was made.
 *
 * So this is interception plumbing, not a new claim. **The mocked specs prove
 * the interface; they do not prove the declaration** — that is
 * `apps/api/test/http/me-context.test.ts` (the server half, against real
 * PostgreSQL), `apps/web/test/context-declaration.test.ts` (the wire form) and
 * `critical-path.spec.ts` (the real join, no interception anywhere).
 *
 * ## I-10, and why the budgets did not move
 *
 * The context is read ONCE per organization for the lifetime of the page, so the
 * extra request lands on the first capability call of a page load and never on a
 * click that follows it. Every budgeted interaction in
 * `scripts/gates/request-budget/budgets.json` is a click on an already-loaded
 * page, so its recording is unchanged — measured, not assumed, by re-running the
 * gate.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The organization every mocked spec but `authn` uses. */
export const MOCK_ORGANIZATION = '11111111-1111-4111-8111-111111111111';
/** The group every mocked spec but `authn` uses. */
export const MOCK_GROUP = '22222222-2222-4222-8222-222222222222';

export interface MockContextOptions {
  readonly organizationId?: string;
  readonly groupIds?: readonly string[];
}

export async function mockDeclaredContext(
  page: Page,
  options: MockContextOptions = {},
): Promise<void> {
  const organizationId = options.organizationId ?? MOCK_ORGANIZATION;
  const groupIds = options.groupIds ?? [MOCK_GROUP];

  const body = {
    organizationId,
    userId: '33333333-3333-4333-8333-333333333333',
    organizationVersion: 1,
    membershipSetVersion: 1,
    sessionEpoch: 1,
    memberships: [
      {
        membershipId: '44444444-4444-4444-8444-444444444440',
        kind: 'organization',
        groupId: null,
        groupVersion: null,
        status: 'active',
        organizationRole: null,
        groupRole: null,
      },
      ...groupIds.map((groupId, index) => ({
        membershipId: `44444444-4444-4444-8444-44444444444${String(index + 1)}`,
        kind: 'group' as const,
        groupId,
        groupVersion: 1,
        status: 'active',
        organizationRole: null,
        groupRole: 'scheduler',
      })),
    ],
  };

  await page.route(`**/api/organizations/${organizationId}/me/context`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  );
}
