import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HOUR_MS, MINUTE_MS } from '../../src/authn/clock.js';
import { DEFAULT_AUTHN_POLICY } from '../../src/authn/config.js';
import * as store from '../../src/authn/store.js';
import { hashToken, mintToken } from '../../src/authn/tokens.js';
import { adminClient } from '../support/admin-client.js';
import {
  AUTHN_EPOCH,
  FIXTURE_PASSWORD,
  organizationCommand,
  testAuthnService,
} from '../support/authn.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **NAMED-CONDITION PROOF 1 — idle AND absolute session lifetime enforcement.**
 *
 * ## Nothing here sleeps, and that is the point
 *
 * Every deadline in this subsystem is compared against `clock.now()`, and the
 * clock is a constructor parameter (`apps/api/src/authn/clock.ts`). So an idle
 * timeout is proven by advancing a number, deterministically, in microseconds —
 * not by sleeping thirty minutes and hoping, which is unrepeatable and therefore
 * not evidence (SPEC-16 §4).
 *
 * ## The two deadlines are proven SEPARATELY, and that is the whole design
 *
 * A single-deadline implementation passes half of this file. The two halves are:
 *
 *  - **idle**: a session used regularly stays alive past its idle window, and one
 *    left alone dies at it. If `expires_at` did not slide, the first fails; if it
 *    slid without bound, the second would never fail.
 *  - **absolute**: a session used *continuously* still dies at its absolute
 *    deadline. This is the one an idle-only implementation cannot pass, and it is
 *    the one that bounds a stolen token's life (T-07).
 *
 * ## RED CASE 2 and RED CASE 3 live here
 *
 * (2) an idle-expired session is rejected; (3) an absolute-expired session is
 * rejected. Both are asserted as rejections of a token that WAS valid a moment
 * earlier on the same clock, so the rejection cannot be confused with a token
 * that never worked.
 */

const multi = ownedMulti('authn-lifetimes', { profile: 'full' });

let admin: pg.Client;
let runtime: Runtime;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime');
});

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

/** Activates a synthetic account and returns its login email. */
async function activate(
  authn: ReturnType<typeof testAuthnService>['authn'],
  userId: string,
  label: string,
): Promise<string> {
  const alpha = multi().alpha;
  const asAdmin = organizationCommand(
    alpha.organizationId,
    alpha.users.organizationAdmin.membershipId,
    `lifetimes-${label}`,
  );
  const anonymous = organizationCommand(alpha.organizationId, null, `lifetimes-${label}-anon`);

  const invitation = await runtime.runner.run(asAdmin, (uow) =>
    authn.issueInvitation(uow, {
      userId,
      email: `lifetimes-${label}@example.test`,
      notificationRef: 'sink:lifetimes',
    }),
  );
  await runtime.runner.run(anonymous, (uow) =>
    authn.activateAccount(uow, { token: invitation.token, password: FIXTURE_PASSWORD }),
  );
  return runtime.runner.run(anonymous, async (uow) => {
    const row = await store.findCredentialById(uow, userId);
    if (row === undefined) throw new Error('activated user vanished');
    return row.loginEmail;
  });
}

describe('idle lifetime', () => {
  it('a session used within its idle window stays alive indefinitely — up to the absolute bound', async () => {
    const alpha = multi().alpha;
    const { authn, clock } = testAuthnService();
    const email = await activate(authn, alpha.full!.viewer.id, 'idle-alive');
    const anonymous = organizationCommand(alpha.organizationId, null, 'lifetimes-idle-alive');

    const signedIn = await runtime.runner.run(anonymous, (uow) =>
      authn.signIn(uow, { loginEmail: email, password: FIXTURE_PASSWORD }),
    );

    // Twenty-nine minutes at a time, eleven times: comfortably past the
    // thirty-minute idle window, comfortably inside the twelve-hour absolute one.
    for (let step = 0; step < 11; step += 1) {
      clock.advance(29 * MINUTE_MS);
      const resolved = await runtime.runner.run(anonymous, (uow) =>
        authn.resolveSession(uow, signedIn.token),
      );
      expect(
        resolved,
        `the session died after ${String((step + 1) * 29)} minutes of REGULAR use — the idle ` +
          'deadline is not sliding',
      ).toBeDefined();
    }
    log('a session used every 29 minutes survived 5h19m of use');
  });

  it('RED CASE 2 — a session left idle past its window is rejected, having worked a moment earlier', async () => {
    const alpha = multi().alpha;
    const { authn, clock } = testAuthnService();
    const email = await activate(authn, alpha.full!.telecom.id, 'idle-dead');
    const anonymous = organizationCommand(alpha.organizationId, null, 'lifetimes-idle-dead');

    const signedIn = await runtime.runner.run(anonymous, (uow) =>
      authn.signIn(uow, { loginEmail: email, password: FIXTURE_PASSWORD }),
    );

    // One minute short of the window: still alive. This is the half that makes
    // the rejection below mean something — without it, "rejected" is consistent
    // with a token that never worked.
    clock.advance(DEFAULT_AUTHN_POLICY.idleLifetimeMs - MINUTE_MS);
    const beforeDeadline = await runtime.runner.run(anonymous, (uow) =>
      authn.resolveSession(uow, signedIn.token),
    );
    expect(beforeDeadline, 'the session died BEFORE its idle deadline').toBeDefined();

    // The resolve above slid the deadline, so the idle window restarts here.
    clock.advance(DEFAULT_AUTHN_POLICY.idleLifetimeMs + MINUTE_MS);
    const afterDeadline = await runtime.runner.run(anonymous, (uow) =>
      authn.resolveSession(uow, signedIn.token),
    );
    expect(afterDeadline, 'an idle-expired session resolved').toBeUndefined();

    // And the row says WHY, for an operator, without the client being told.
    const reason = await runtime.runner.run(anonymous, (uow) =>
      store.describeSessionFailure(uow, hashToken('session', signedIn.token), clock.now()),
    );
    expect(reason).toBe('idle_expired');
    log('idle-expired session rejected; the row records `idle_expired` and the client is told nothing');
  });
});

describe('absolute lifetime', () => {
  it('RED CASE 3 — a CONTINUOUSLY used session still dies at its absolute deadline', async () => {
    const alpha = multi().alpha;
    const { authn, clock } = testAuthnService();
    const email = await activate(authn, alpha.full!.groupAdmin.id, 'absolute');
    const anonymous = organizationCommand(alpha.organizationId, null, 'lifetimes-absolute');

    const signedIn = await runtime.runner.run(anonymous, (uow) =>
      authn.signIn(uow, { loginEmail: email, password: FIXTURE_PASSWORD }),
    );
    const absolute = signedIn.absoluteExpiresAt.getTime();
    expect(absolute - AUTHN_EPOCH.getTime()).toBe(DEFAULT_AUTHN_POLICY.absoluteLifetimeMs);

    // Used every ten minutes, so the idle deadline never lapses. An idle-only
    // implementation keeps this session alive forever and fails here.
    let uses = 0;
    for (;;) {
      clock.advance(10 * MINUTE_MS);
      const resolved = await runtime.runner.run(anonymous, (uow) =>
        authn.resolveSession(uow, signedIn.token),
      );
      if (resolved === undefined) break;
      uses += 1;
      expect(
        clock.now().getTime(),
        'the session outlived its absolute deadline under continuous use — the absolute bound ' +
          'is not enforced',
      ).toBeLessThan(absolute);
    }

    expect(clock.now().getTime()).toBeGreaterThanOrEqual(absolute);
    const reason = await runtime.runner.run(anonymous, (uow) =>
      store.describeSessionFailure(uow, hashToken('session', signedIn.token), clock.now()),
    );
    expect(reason).toBe('absolute_expired');
    log(
      `a continuously-used session died after ${String(uses)} uses at its 12h absolute deadline; ` +
        'the row records `absolute_expired`',
    );
  });

  it('the absolute deadline cannot be moved — TWO layers refuse, and both are checked', async () => {
    const alpha = multi().alpha;
    const { authn, clock } = testAuthnService();
    const email = await activate(authn, alpha.full!.dualRole.id, 'immovable');
    const anonymous = organizationCommand(alpha.organizationId, null, 'lifetimes-immovable');

    const signedIn = await runtime.runner.run(anonymous, (uow) =>
      authn.signIn(uow, { loginEmail: email, password: FIXTURE_PASSWORD }),
    );
    const moved = new Date(clock.now().getTime() + 30 * HOUR_MS);

    /* Layer 1 — the GRANT. `app_runtime` holds column-level UPDATE on
     * `expires_at` and not on `absolute_expires_at`, so the statement is refused
     * with 42501 before any row is considered. This is the layer that matters in
     * production, and it is checked FIRST because a test that only checked the
     * trigger would pass with the grant accidentally widened. */
    await expect(
      runtime.runner.run(anonymous, async (uow) => {
        const { sql } = await import('kysely');
        await sql`
          update sessions set absolute_expires_at = ${moved}
           where id = ${signedIn.sessionId}::uuid
        `.execute(uow.query);
      }),
    ).rejects.toThrow(/permission denied for table sessions/);

    /* Layer 2 — the TRIGGER, which is what refuses the OWNER. "The runtime
     * cannot reach it" is a different claim from "it cannot happen": a migration
     * or a maintenance script runs as the owner, and a superuser bypasses RLS
     * but does NOT bypass triggers. The same argument 0004 makes for
     * `app_guard_qualification_delete`, applied here. */
    const owner = createRuntime('app_migrator');
    try {
      await expect(
        owner.runner.run(anonymous, async (uow) => {
          const { sql } = await import('kysely');
          await sql`
            update sessions set absolute_expires_at = ${moved}
             where id = ${signedIn.sessionId}::uuid
          `.execute(uow.query);
        }),
      ).rejects.toThrow(/SESSION_ABSOLUTE_DEADLINE_IMMUTABLE/);
    } finally {
      await owner.destroy();
    }

    // And nothing moved.
    const after = await admin.query<{ absolute_expires_at: Date }>(
      'select absolute_expires_at from sessions where id = $1::uuid',
      [signedIn.sessionId],
    );
    expect(after.rows[0]?.absolute_expires_at.getTime()).toBe(
      signedIn.absoluteExpiresAt.getTime(),
    );
    log('absolute_expires_at is refused by the GRANT for app_runtime and by the TRIGGER for the owner');
  });

  it('a persistent session gets a longer IDLE window and the SAME absolute bound', async () => {
    const alpha = multi().alpha;
    const { authn } = testAuthnService();
    const email = await activate(authn, alpha.full!.organizationObserver.id, 'persistent');
    const anonymous = organizationCommand(alpha.organizationId, null, 'lifetimes-persistent');

    const signedIn = await runtime.runner.run(anonymous, (uow) =>
      authn.signIn(uow, { loginEmail: email, password: FIXTURE_PASSWORD, persistent: true }),
    );

    // The persistent idle window is fourteen days and the absolute bound is
    // twelve hours, so the issued idle deadline is CLAMPED to the absolute one.
    // That clamp is what makes "persistent" a convenience rather than a second,
    // longer session class.
    expect(signedIn.expiresAt.getTime()).toBe(signedIn.absoluteExpiresAt.getTime());
    expect(signedIn.absoluteExpiresAt.getTime() - AUTHN_EPOCH.getTime()).toBe(
      DEFAULT_AUTHN_POLICY.absoluteLifetimeMs,
    );
    log('a persistent session\'s idle deadline is clamped to its absolute deadline');
  });
});

describe('a token that names nothing', () => {
  it('RED CASE 1 — a forged token resolves to nothing and leaks nothing', async () => {
    const alpha = multi().alpha;
    const { authn, clock } = testAuthnService();
    const anonymous = organizationCommand(alpha.organizationId, null, 'lifetimes-forged');

    for (const forged of [mintToken(), 'not-a-token', '', 'a'.repeat(43)]) {
      const resolved = await runtime.runner.run(anonymous, (uow) =>
        authn.resolveSession(uow, forged),
      );
      expect(resolved, `a forged token resolved: ${forged.slice(0, 8)}…`).toBeUndefined();
      const reason = await runtime.runner.run(anonymous, (uow) =>
        store.describeSessionFailure(uow, hashToken('session', forged), clock.now()),
      );
      // Indistinguishable from an expired one at the API. The DIFFERENCE is
      // recorded for an operator and nowhere else.
      expect(reason).toBe('unknown');
    }
    log('four forged tokens resolved to nothing; every one recorded as `unknown`');
  });
});
