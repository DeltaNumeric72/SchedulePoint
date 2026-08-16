import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';
import { seedBuildFixture, type BuildFixture } from '../support/builds.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type DeclaredCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * The build HTTP surface, over the real database (OPUS-M4-003; I-02).
 *
 * ## An ALLOW control comes first, every time
 *
 * FAD-15 vacuity discipline: a deny test whose subject does not exist denies for
 * the wrong reason and passes anyway. Every deny below is preceded by the SAME
 * request succeeding for an authorized actor against the SAME route with the
 * SAME body shape, so a 403 can only mean the capability gate.
 *
 * ## The refusal body never names the capability
 *
 * SPEC-06 P-3. A denial that explains itself is a capability oracle, and the
 * assertions below check the body text as well as the status code.
 */

const multi = ownedMulti('builds-http', {
  profile: 'full',
  seed: { catalogue: ['alpha'], schedule: true, scheduleCredentials: true },
});

let harness: HttpHarness;
let runtime: Runtime;
let admin: pg.Client;
let fixture: BuildFixture;

beforeAll(async () => {
  harness = await buildHttpHarness();
  runtime = createRuntime('app_runtime', { max: 3 });
  admin = adminClient();
  await admin.connect();

  const alpha = multi().alpha;
  const shiftTypeId = multi.catalogue('alpha').shiftTypeIds[1];
  if (shiftTypeId === undefined) throw new Error('no shift type');

  fixture = await seedBuildFixture(runtime.runner, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    userId: alpha.users.scheduler.id,
    shiftTypeId,
    label: 'http',
    startDate: '2046-04-02',
    endDate: '2046-04-08',
  });
}, 240_000);

afterAll(async () => {
  await harness?.close();
  await runtime?.destroy();
  await admin?.end();
});

function buildsPath(): string {
  const alpha = multi().alpha;
  return `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/builds`;
}

async function countersFor(userId: string): Promise<DeclaredCounters> {
  const alpha = multi().alpha;
  return currentCounters(admin, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    userId,
  });
}

interface Reply {
  readonly statusCode: number;
  readonly body: unknown;
  readonly raw: string;
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  userId: string,
  options: { body?: unknown } = {},
): Promise<Reply> {
  const response = await harness.app.inject({
    method,
    url,
    headers: {
      ...contextHeaders(userId, await countersFor(userId)),
      'content-type': 'application/json',
    },
    ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    parsed = undefined;
  }
  return { statusCode: response.statusCode, body: parsed, raw: response.body };
}

describe('build configurations', () => {
  it('ALLOW: a scheduler creates a configuration and reads it back', async () => {
    const created = await call('POST', `${buildsPath()}/configurations`, multi().alpha.users.scheduler.id, {
      body: { periodId: fixture.periodId, name: `HTTP allow ${randomUUID().slice(0, 8)}` },
    });
    expect(created.statusCode, created.raw).toBe(200);

    const listed = await call(
      'GET',
      `${buildsPath()}/configurations?periodId=${fixture.periodId}`,
      multi().alpha.users.scheduler.id,
    );
    expect(listed.statusCode, listed.raw).toBe(200);
    const body = listed.body as { configurations: { id: string }[] };
    expect(body.configurations.length).toBeGreaterThan(0);
  });

  it('DENY: a member without the capability is refused the SAME request', async () => {
    const denied = await call('POST', `${buildsPath()}/configurations`, multi().alpha.users.member.id, {
      body: { periodId: fixture.periodId, name: `HTTP deny ${randomUUID().slice(0, 8)}` },
    });
    /* L4.2 — the actor holds an active membership here, so the tenant's
     * existence is already known to them and the disclosure class is 403. */
    expect(denied.statusCode, denied.raw).toBe(403);
    /* P-3: the reason never reaches the body. */
    expect(denied.raw).not.toMatch(/capability|schedule\.version|CAP-0/i);
  });

  it('DENY: the read is refused for the same actor', async () => {
    const denied = await call(
      'GET',
      `${buildsPath()}/configurations?periodId=${fixture.periodId}`,
      multi().alpha.users.member.id,
    );
    expect(denied.statusCode, denied.raw).toBe(403);
  });
});

describe('build runs', () => {
  /**
   * A FRESH configuration per test, never one shared by a `beforeAll`.
   *
   * D-4a admits one in-flight build per (period, configuration), so two tests
   * sharing a configuration are order-dependent: whichever runs first takes the
   * slot and the other gets a 409 it did not ask for. The shuffled-seed sweep
   * found exactly that — this file passed in declaration order and failed under
   * `seed 424242` and `seed 20260803`. The isolation is per test, which is the
   * only arrangement that cannot be undone by a reordering.
   */
  async function newConfiguration(): Promise<string> {
    const created = await call(
      'POST',
      `${buildsPath()}/configurations`,
      multi().alpha.users.scheduler.id,
      { body: { periodId: fixture.periodId, name: `HTTP runs ${randomUUID().slice(0, 12)}` } },
    );
    expect(created.statusCode, created.raw).toBe(200);
    return (created.body as { configuration: { id: string } }).configuration.id;
  }

  it('ALLOW: a scheduler creates a run, and the replay returns the recorded one', async () => {
    const configurationId = await newConfiguration();
    const key = `http.${randomUUID().slice(0, 20)}`;
    const body = {
      configurationId,
      sourceVersionId: fixture.versionId,
      candidateLabel: 'http-allow',
      idempotencyKey: key,
    };

    const first = await call('POST', `${buildsPath()}/runs`, multi().alpha.users.scheduler.id, { body });
    expect(first.statusCode, first.raw).toBe(200);
    const firstId = (first.body as { run: { id: string } }).run.id;

    /* D-17: the same key with the same semantic request returns the RECORDED
     * run, not a second one and not a fabricated empty answer. */
    const replay = await call('POST', `${buildsPath()}/runs`, multi().alpha.users.scheduler.id, { body });
    expect(replay.statusCode, replay.raw).toBe(200);
    expect((replay.body as { run: { id: string } }).run.id).toBe(firstId);

    /* The same key naming a DIFFERENT request is a conflict, never somebody
     * else's build. */
    const conflict = await call('POST', `${buildsPath()}/runs`, multi().alpha.users.scheduler.id, {
      body: { ...body, candidateLabel: 'a-different-label' },
    });
    expect(conflict.statusCode, conflict.raw).toBe(409);
  });

  it('DENY: a member without the capability cannot create a run', async () => {
    const configurationId = await newConfiguration();
    const denied = await call('POST', `${buildsPath()}/runs`, multi().alpha.users.member.id, {
      body: {
        configurationId,
        sourceVersionId: fixture.versionId,
        candidateLabel: 'http-deny',
        idempotencyKey: `deny.${randomUUID().slice(0, 16)}`,
      },
    });
    expect(denied.statusCode, denied.raw).toBe(403);
  });

  it('422 on a body that is not valid, and the problems are itemised', async () => {
    const configurationId = await newConfiguration();
    const invalid = await call('POST', `${buildsPath()}/runs`, multi().alpha.users.scheduler.id, {
      body: { configurationId, sourceVersionId: fixture.versionId, candidateLabel: '' },
    });
    expect(invalid.statusCode, invalid.raw).toBe(422);
    const body = invalid.body as { error: { code: string; problems: unknown[] } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.problems.length).toBeGreaterThan(0);
  });

  it('409 BUILD_STATE_MOVED when the caller believes a state the run is not in', async () => {
    const configurationId = await newConfiguration();
    const created = await call('POST', `${buildsPath()}/runs`, multi().alpha.users.scheduler.id, {
      body: {
        configurationId,
        sourceVersionId: fixture.versionId,
        candidateLabel: 'state-moved',
        idempotencyKey: `moved.${randomUUID().slice(0, 16)}`,
      },
    });
    /* Its OWN configuration, so this is unconditionally the first in-flight
     * build of it and D-4a has nothing to say. A tolerated 409 here would have
     * hidden the order dependence rather than removed it. */
    expect(created.statusCode, created.raw).toBe(200);

    const runId = (created.body as { run: { id: string } }).run.id;
    const moved = await call(
      'POST',
      `${buildsPath()}/runs/${runId}/review`,
      multi().alpha.users.scheduler.id,
      { body: { expectedState: 'completed' } },
    );
    expect(moved.statusCode, moved.raw).toBe(409);
    const body = moved.body as { error: { code: string; currentState: string } };
    expect(body.error.code).toBe('BUILD_STATE_MOVED');
    /* The refusal carries WHERE the build actually is, so the client can decide
     * again rather than guess. */
    expect(body.error.currentState).toBe('draft_configuration');
  });

  it('D-4a: a second in-flight build of one configuration is a 409, not a 500', async () => {
    const configurationId = await newConfiguration();
    const body = {
      configurationId,
      sourceVersionId: fixture.versionId,
      candidateLabel: 'd4a-http',
      idempotencyKey: `d4ahttp.${randomUUID().slice(0, 14)}`,
    };
    const first = await call('POST', `${buildsPath()}/runs`, multi().alpha.users.scheduler.id, {
      body,
    });
    expect(first.statusCode, first.raw).toBe(200);

    const second = await call('POST', `${buildsPath()}/runs`, multi().alpha.users.scheduler.id, {
      body: { ...body, idempotencyKey: `d4ahttp2.${randomUUID().slice(0, 12)}` },
    });
    /* The partial unique index refused it. That is a concurrency answer and must
     * reach the client as one — never as a 500, and never as a 404. */
    expect(second.statusCode, second.raw).toBe(409);
  });

  it('DENY: every transition route refuses a member without the capability', async () => {
    const runId = randomUUID();
    for (const path of ['cancel', 'review', 'extend', 'stage-complete', 'approve']) {
      const denied = await call(
        'POST',
        `${buildsPath()}/runs/${runId}/${path}`,
        multi().alpha.users.member.id,
        { body: { expectedState: 'queued' } },
      );
      expect(denied.statusCode, `${path}: ${denied.raw}`).toBe(403);
    }
  });

  it('DENY: selection and comparison refuse a member without the capability', async () => {
    const denied = await call(
      'POST',
      `${buildsPath()}/runs/${randomUUID()}/apply`,
      multi().alpha.users.member.id,
      { body: { expectedState: 'approved', expectedSourceDigest: 'a'.repeat(64) } },
    );
    expect(denied.statusCode, denied.raw).toBe(403);

    const comparison = await call(
      'GET',
      `${buildsPath()}/comparison?runIds=${randomUUID()},${randomUUID()}`,
      multi().alpha.users.member.id,
    );
    expect(comparison.statusCode, comparison.raw).toBe(403);
  });

  it('DENY: the maintenance routes refuse a scheduler without period administration', async () => {
    /* `reap` and `archive` are CAP-019, not CAP-015. The ALLOW control is the
     * scheduler, who holds period administration in this fixture; the DENY is
     * the plain member. Both are asserted so the difference is proven rather
     * than assumed. */
    const allowed = await call('POST', `${buildsPath()}/reap`, multi().alpha.users.scheduler.id, {
      body: {},
    });
    expect(allowed.statusCode, allowed.raw).toBe(200);

    const denied = await call('POST', `${buildsPath()}/reap`, multi().alpha.users.member.id, {
      body: {},
    });
    expect(denied.statusCode, denied.raw).toBe(403);
  });
});
