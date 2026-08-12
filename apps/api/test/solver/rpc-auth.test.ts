import { randomUUID } from 'node:crypto';

import type { SolveRequestSpec } from '@schedulepoint/domain';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTH_SCHEME,
  PRINCIPAL_WORKER,
  frameRequest,
  freshNonce,
  splitFrame,
  verifyResponseFrame,
} from '../../src/solver/rpc-envelope.js';
import { canonicalInputHash } from '../../src/solver/snapshot-store.js';
import { solveOnWorker } from '../../src/solver/solver-client.js';
import { log } from '../support/harness.js';
import {
  DETERMINISTIC_PARAMETERS,
  FIXTURE_RPC_KEY_ID,
  FIXTURE_RPC_SECRET,
  applyHostileWorkerEnv,
  applySolverEnv,
} from '../support/solver.js';
import { NON_ASCII_CASES } from './non-ascii-corpus.js';
import { syntheticProblem } from './synthetic-problem.js';

/**
 * **NAMED PROOF — the RPC channel is mutually authenticated** (OPUS-M4-001;
 * SPEC-04 §1.1, doc 35 §6a "RPC auth refusal").
 *
 * SPEC-04 §1.1 requires "**mutual** authentication on the internal channel" and
 * that "the worker rejects unauthenticated requests". Doc 35 §6a narrows the
 * mechanism to a stated pair — shared secret or mTLS — and forbids inventing a
 * third. The implementation is the shared-secret member of that pair, made
 * genuinely mutual, and this file is what makes "mutual" a fact:
 *
 * | # | Property | Attack it closes |
 * |---|---|---|
 * | 1 | the worker REFUSES a request it cannot authenticate | anyone who can reach the channel can spend a solve, or feed one a problem |
 * | 2 | the platform REFUSES a response it cannot authenticate | a substituted worker answers, and its schedule is believed |
 * | 3 | request and response MACs are DOMAIN-SEPARATED | a captured request MAC is replayed as a response MAC |
 * | 4 | a response is bound to its request's NONCE | a valid old response is replayed against a later solve of the same problem |
 * | 5 | the MAC covers the WHOLE message | a field outside the covered region is changed freely |
 * | 6 | a worker with no configured secret refuses everything | a misconfigured deployment accepts everything instead |
 *
 * ## Mutation control (FAD-15)
 *
 * Case 2's control tampers with exactly one byte of an otherwise valid response
 * and asserts verification flips. Without it, `verifyResponse` returning `true`
 * would be consistent with a function that always returns `true`.
 */

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

const key = { keyId: FIXTURE_RPC_KEY_ID, secret: FIXTURE_RPC_SECRET };

function request(): SolveRequestSpec {
  const payload = syntheticProblem();
  return {
    protocolVersion: 1,
    organizationId: payload.organizationId,
    groupId: payload.groupId,
    buildRunId: randomUUID(),
    correlationId: `auth-${randomUUID().slice(0, 8)}`,
    snapshotId: randomUUID(),
    canonicalInputHash: canonicalInputHash(payload),
    snapshotPayload: payload,
    parameters: DETERMINISTIC_PARAMETERS,
  };
}

/** A minimal, valid, MACed response as the worker would produce one. */
function signedResponse(nonce: string, overrides: Record<string, unknown> = {}): unknown {
  const body: Record<string, unknown> = {
    protocolVersion: 1,
    messageType: 'SolveResponse',
    status: 'FEASIBLE',
    terminationReason: 'completed',
    canonicalInputHash: 'a'.repeat(64),
    assignments: [],
    ...overrides,
    auth: {
      scheme: AUTH_SCHEME,
      principal: PRINCIPAL_WORKER,
      keyId: key.keyId,
      nonce,
    },
  };
  /* Signed with the RESPONSE domain by reusing `signRequest`'s payload rule
   * would be wrong — that is precisely what case 3 proves. The response MAC is
   * produced here the way the worker produces it, via the round trip. */
  return body;
}

describe('the solver RPC channel authenticates in both directions', () => {
  it('the WORKER refuses a request signed with the wrong secret', async () => {
    /* Mounted by hand rather than through the client, and deliberately so: the
     * client builds the worker's environment from the same two variables it
     * signs with, so the two sides can never disagree through it. An attacker
     * has no such constraint — they reach the channel with a secret of their
     * own — and that is the situation this reproduces. */
    const { spawnSync } = await import('node:child_process');
    const { SOLVER_ROOT } = await import('../support/solver.js');

    const payload = syntheticProblem();
    const frame = frameRequest(
      {
        protocolVersion: 1,
        messageType: 'SolveRequest',
        context: {
          organizationId: payload.organizationId,
          groupId: payload.groupId,
          buildRunId: randomUUID(),
          correlationId: 'auth-probe',
        },
        snapshotId: randomUUID(),
        canonicalInputHash: canonicalInputHash(payload),
        parameters: DETERMINISTIC_PARAMETERS,
        control: {},
        snapshot: payload,
      },
      { keyId: key.keyId, secret: 'fixture-local-an-entirely-different-secret-00' },
      freshNonce(),
    );

    const run = spawnSync('python3', ['-m', 'schedulepoint_solver'], {
      cwd: SOLVER_ROOT,
      input: frame.wire,
      env: {
        PATH: process.env['PATH'] ?? '',
        SP_SOLVER_RPC_SECRET: FIXTURE_RPC_SECRET,
        SP_SOLVER_RPC_KEY_ID: FIXTURE_RPC_KEY_ID,
      },
    });

    expect(run.status).toBe(2);
    const refusal = splitFrame(run.stdout);
    expect(refusal).not.toBeNull();
    const authLine = JSON.parse(refusal?.authLine ?? '{}') as { signed?: boolean };
    const body = JSON.parse((refusal?.body ?? Buffer.alloc(0)).toString('utf8')) as {
      status: string;
    };
    expect(body.status).toBe('FAILED');
    /* The refusal declares itself UNSIGNED rather than omitting the block: the
     * worker cannot MAC a reply to a key it does not hold, and saying so is
     * better than leaving a reader to infer it. */
    expect(authLine.signed).toBe(false);
    log('      · the worker refused a request whose MAC did not verify, exit 2');
  });

  it('the worker refuses a request whose secret is not configured at all', async () => {
    const { spawnSync } = await import('node:child_process');
    const { SOLVER_ROOT } = await import('../support/solver.js');

    const run = spawnSync('python3', ['-m', 'schedulepoint_solver'], {
      cwd: SOLVER_ROOT,
      input: Buffer.from('{}\n{}', 'utf8'),
      // No SP_SOLVER_RPC_* at all. Fail-closed: refuse everything, not accept it.
      env: { PATH: process.env['PATH'] ?? '' },
    });

    expect(run.status).toBe(2);
    const refusal = splitFrame(run.stdout);
    const body = JSON.parse((refusal?.body ?? Buffer.alloc(0)).toString('utf8')) as {
      error: { code: string };
    };
    expect(body.error.code).toBe('auth_not_configured');
    log('      · with no secret configured the worker refuses every request');
  });

  it('the PLATFORM refuses a response whose MAC does not verify', async () => {
    restore = applyHostileWorkerEnv('forged-mac');
    await expect(solveOnWorker(request())).rejects.toMatchObject({
      code: 'SOLVER_RESPONSE_REJECTED',
      refusal: { reason: 'unauthenticated' },
    });
    log('      · a forged response MAC is refused on the `unauthenticated` arm');
  });

  it('the platform refuses an UNSIGNED response', async () => {
    restore = applyHostileWorkerEnv('unsigned');
    await expect(solveOnWorker(request())).rejects.toMatchObject({
      refusal: { reason: 'unauthenticated' },
    });
  });

  it('the platform refuses a correctly-MACed response bound to a DIFFERENT request', async () => {
    /* Replay. The response is genuinely signed with the right key and is
     * internally consistent; only its nonce belongs to another exchange. Without
     * the binding, a captured response could be replayed against any later solve
     * of the same problem — and because the canonical input hash would match,
     * nothing else would notice. */
    restore = applyHostileWorkerEnv('wrong-nonce');
    await expect(solveOnWorker(request())).rejects.toMatchObject({
      refusal: { reason: 'unauthenticated' },
    });
    log('      · a valid MAC bound to another request is still refused (replay)');
  });

  it('domain separation: a REQUEST MAC does not verify as a RESPONSE MAC', () => {
    const nonce = freshNonce();
    const message = { protocolVersion: 1, status: 'FEASIBLE', canonicalInputHash: 'a'.repeat(64) };
    const asRequest = frameRequest(message, key, nonce);

    /* The same message, the same key, the same nonce — signed for the other
     * direction. If the domains were shared, an attacker able to reflect a
     * request would have a valid response for free. */
    const reflected = splitFrame(asRequest.wire);
    expect(reflected).not.toBeNull();
    expect(verifyResponseFrame(reflected as NonNullable<typeof reflected>, key, nonce)).toBe(false);
    log('      · request and response MACs are domain-separated');
  });

  it('MUTATION CONTROL: a valid response verifies, and one changed byte does not', async () => {
    /* `verifyResponse` returning `false` everywhere above is consistent with a
     * function that always returns `false`. This is the other direction. */
    restore = applySolverEnv();
    const nonce = freshNonce();

    /* Produced by the real worker, so the "valid" arm is a real signature rather
     * than one this test computed from the same code it is testing. */
    const { spawnSync } = await import('node:child_process');
    const { SOLVER_ROOT } = await import('../support/solver.js');
    const payload = syntheticProblem();
    const frame = frameRequest(
      {
        protocolVersion: 1,
        messageType: 'SolveRequest',
        context: {
          organizationId: payload.organizationId,
          groupId: payload.groupId,
          buildRunId: randomUUID(),
          correlationId: 'auth-mutation',
        },
        snapshotId: randomUUID(),
        canonicalInputHash: canonicalInputHash(payload),
        parameters: DETERMINISTIC_PARAMETERS,
        control: {},
        snapshot: payload,
      },
      key,
      nonce,
    );
    const run = spawnSync('python3', ['-m', 'schedulepoint_solver'], {
      cwd: SOLVER_ROOT,
      input: frame.wire,
      env: {
        PATH: process.env['PATH'] ?? '',
        SP_SOLVER_RPC_SECRET: FIXTURE_RPC_SECRET,
        SP_SOLVER_RPC_KEY_ID: FIXTURE_RPC_KEY_ID,
      },
    });
    expect(run.status).toBe(0);
    const responseFrame = splitFrame(run.stdout);
    expect(responseFrame).not.toBeNull();
    const good = responseFrame as NonNullable<typeof responseFrame>;

    expect(verifyResponseFrame(good, key, nonce)).toBe(true);

    /* ONE BYTE of the covered region — not the tag — so the case proves the MAC
     * covers the whole body rather than a header. Flipped in the RAW BYTES,
     * because the raw bytes are now exactly what the MAC covers. */
    const flipped = Buffer.from(good.body);
    const at = flipped.length - 2;
    flipped.writeUInt8((flipped.readUInt8(at) ^ 0x01) & 0xff, at);
    expect(verifyResponseFrame({ authLine: good.authLine, body: flipped }, key, nonce)).toBe(false);
    log('      · MUTATION CONTROL: a real signature verifies; one flipped byte does not');
  });

  it.each(NON_ASCII_CASES)(
    'authenticates BOTH directions with non-ASCII in the payload: $label',
    async ({ label, text }) => {
      /* **The B-1 regression guard.** The MAC used to cover a re-derivation of
       * the message rather than the bytes sent: the platform signed raw UTF-8,
       * the worker re-derived `\uXXXX` escapes. Identical for ASCII, different
       * for every case below — so a period called "Février 2029" was refused as
       * forged, through the real production path.
       *
       * The astral case is the one that matters most: `ensure_ascii=False` alone
       * would have fixed the others and left this one, because the two runtimes
       * ALSO sort object keys differently above the BMP. MACing the raw bytes
       * removes the whole class rather than the instance. */
      const restoreEnv = applySolverEnv();
      try {
        const payload = syntheticProblem({ periodName: text, shiftTypeCode: text });
        const nonce = freshNonce();
        const frame = frameRequest(
          {
            protocolVersion: 1,
            messageType: 'SolveRequest',
            context: {
              organizationId: payload.organizationId,
              groupId: payload.groupId,
              buildRunId: randomUUID(),
              correlationId: 'auth-non-ascii',
            },
            snapshotId: randomUUID(),
            canonicalInputHash: canonicalInputHash(payload),
            parameters: DETERMINISTIC_PARAMETERS,
            control: {},
            snapshot: payload,
          },
          key,
          nonce,
        );

        const { spawnSync } = await import('node:child_process');
        const { SOLVER_ROOT } = await import('../support/solver.js');
        const run = spawnSync('python3', ['-m', 'schedulepoint_solver'], {
          cwd: SOLVER_ROOT,
          input: frame.wire,
          env: {
            PATH: process.env['PATH'] ?? '',
            SP_SOLVER_RPC_SECRET: FIXTURE_RPC_SECRET,
            SP_SOLVER_RPC_KEY_ID: FIXTURE_RPC_KEY_ID,
          },
        });

        /* The worker ACCEPTED it — exit 0, not the exit 2 of an auth refusal. */
        expect(run.status, `${label}: the worker refused an honest request`).toBe(0);
        const responseFrame = splitFrame(run.stdout);
        expect(responseFrame).not.toBeNull();
        /* …and the platform authenticates the answer. Both directions. */
        expect(
          verifyResponseFrame(responseFrame as NonNullable<typeof responseFrame>, key, nonce),
          `${label}: the response did not authenticate`,
        ).toBe(true);
        log(`      · ${label}: both directions authenticate`);
      } finally {
        restoreEnv();
      }
    },
  );

  it('a well-formed response shape alone is never enough', () => {
    /* Built to look exactly right and signed by nobody. The shape check and the
     * authentication are separate questions, and passing the first must not
     * imply the second. */
    const nonce = freshNonce();
    const unsigned = {
      authLine: JSON.stringify({ scheme: AUTH_SCHEME, principal: PRINCIPAL_WORKER, signed: false }),
      body: Buffer.from(JSON.stringify(signedResponse(nonce)), 'utf8'),
    };
    expect(verifyResponseFrame(unsigned, key, nonce)).toBe(false);
  });
});
