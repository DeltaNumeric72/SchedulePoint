import { randomUUID } from 'node:crypto';

import { selectInForce } from '@schedulepoint/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadWorkProfiles, workProfileInForce } from '../../src/profiles/in-force-loader.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantStaffingCapabilities } from '../support/staffing.js';

/**
 * **NAMED CONDITION (1) — in-force determinism under adjacent and future-dated
 * rows, at the database.**
 *
 * `packages/domain/test/profiles/in-force.test.ts` proves the RULE against
 * hand-built rows. This proves the same rule against rows PostgreSQL actually
 * stored, through the shipped loader, with the EXCLUDE constraint in force and
 * the real RLS policies applying — which is a different claim, and the one that
 * failed at S-01: the rule there was fine in isolation; the loader that fed it
 * was not.
 *
 * Standalone as well as in-suite, per the standing verification discipline
 * (OPUS-M1-004: a proof that passes in the battery may fail alone).
 */

const multi = ownedMulti('profiles-in-force-determinism');

let runtime: Runtime;

/** The membership whose profile history this file builds. */
const subject = (): string => multi().alpha.users.scheduler.membershipId;
/** The actor: `groupOnly` holds no other membership, so the grant guard is satisfied. */
const actor = (): string => multi().alpha.users.groupOnly.membershipId;

function groupContext(correlationId: string): {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
} {
  return {
    organizationId: multi().alpha.organizationId,
    groupId: multi().alpha.groupOne.id,
    membershipId: actor(),
    correlationId,
  };
}

/**
 * Plants a profile window directly, so the fixture is the SHAPE under test rather
 * than the output of the writer.
 *
 * Deliberate: the writer is proven separately. Here the question is whether the
 * READER selects correctly from an arbitrary legal history, and building that
 * history through the writer would only ever produce histories the writer knows
 * how to make.
 */
async function plant(from: string, to: string | null, percentage: string): Promise<string> {
  const id = randomUUID();
  await runtime.runner.run(groupContext('plant-profile'), async ({ query }) => {
    await query
      .insertInto('membership_work_profiles')
      .values({
        id,
        organization_id: multi().alpha.organizationId,
        group_id: multi().alpha.groupOne.id,
        membership_id: subject(),
        effective_from: new Date(from),
        effective_to: to === null ? null : new Date(to),
        work_percentage: percentage,
      })
      .execute();
  });
  return id;
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  await grantStaffingCapabilities(runtime.runner, multi(), {
    organizationId: multi().alpha.organizationId,
    groupId: multi().alpha.groupOne.id,
    membershipId: actor(),
    capabilities: ['staffing.work_profile.administer', 'staffing.work_profile.read'],
  });
}, 120_000);

afterAll(async () => {
  await runtime.destroy();
});

describe('in-force determinism against stored rows', () => {
  /** Three adjacent windows plus one future-dated: the shape supersession produces. */
  let p1: string;
  let p2: string;
  let p3: string;
  let future: string;

  beforeAll(async () => {
    p1 = await plant('2022-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', '100.00');
    p2 = await plant('2024-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '80.00');
    p3 = await plant('2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '60.00');
    future = await plant('2027-01-01T00:00:00.000Z', null, '40.00');
  });

  const at = async (instant: string): Promise<{ kind: string; id: string | null; reason: string | null }> =>
    runtime.runner.run(groupContext('read-in-force'), async ({ query }) => {
      const selection = await workProfileInForce(query, {
        organizationId: multi().alpha.organizationId,
        membershipId: subject(),
        at: new Date(instant),
      });
      return {
        kind: selection.kind,
        id: selection.kind === 'in-force' ? selection.row.id : null,
        reason: selection.kind === 'none' ? selection.reason : null,
      };
    });

  it('the fixture really has four adjacent windows — otherwise everything below is vacuous', async () => {
    const rows = await runtime.runner.run(groupContext('census'), ({ query }) =>
      loadWorkProfiles(query, {
        organizationId: multi().alpha.organizationId,
        membershipId: subject(),
      }),
    );
    expect(rows.map((row) => row.id)).toEqual([p1, p2, p3, future]);
    log(`four stored windows for one membership: ${rows.map((r) => r.workPercentage).join('% -> ')}%`);
  });

  it('the exact instant of change belongs to the SUCCESSOR, not the predecessor', async () => {
    expect((await at('2024-01-01T00:00:00.000Z')).id).toBe(p2);
    expect((await at('2023-12-31T23:59:59.999Z')).id).toBe(p1);
    expect((await at('2024-01-01T00:00:00.001Z')).id).toBe(p2);
    log('the instant of change is the first instant of the new row and not the last of the old');
  });

  it('a FUTURE-DATED row does not govern the present', async () => {
    // The defect this is aimed at is `ORDER BY effective_from DESC LIMIT 1`, which
    // is what a careful engineer writes when told to make row selection
    // deterministic — and which applies tomorrow's change today.
    const now = await at('2026-08-03T00:00:00.000Z');
    expect(now.id, 'a future-dated profile governed the present').toBe(p3);
    expect((await at('2027-01-01T00:00:00.000Z')).id, 'the future row never took effect').toBe(future);
  });

  it('an instant before the first window is `before-first`, not the first row', async () => {
    const answer = await at('2021-01-01T00:00:00.000Z');
    expect(answer.id).toBeNull();
    expect(answer.reason).toBe('before-first');
  });

  it('timezone-explicit instants resolve identically to their UTC form', async () => {
    // `2024-01-01T02:00:00+02:00` IS `2024-01-01T00:00:00Z`. Effective dating is
    // exactly where "the 1st" means two different instants.
    expect((await at('2024-01-01T02:00:00.000+02:00')).id).toBe(p2);
    expect((await at('2023-12-31T18:59:59.999-05:00')).id).toBe(p1);
    log('an offset-bearing instant selects the same row as its UTC spelling');
  });

  it('a gap in the history reports `gap`, and does not fall back to the previous row', async () => {
    // Its own membership, so the four-window history above stays intact.
    const gapSubject = multi().alpha.users.member.membershipId;
    const before = randomUUID();
    const after = randomUUID();
    await runtime.runner.run(groupContext('plant-gap'), async ({ query }) => {
      for (const [id, from, to] of [
        [before, '2022-01-01T00:00:00.000Z', '2023-01-01T00:00:00.000Z'],
        [after, '2025-01-01T00:00:00.000Z', null],
      ] as const) {
        await query
          .insertInto('membership_work_profiles')
          .values({
            id,
            organization_id: multi().alpha.organizationId,
            group_id: multi().alpha.groupOne.id,
            membership_id: gapSubject,
            effective_from: new Date(from),
            effective_to: to === null ? null : new Date(to),
            work_percentage: '50.00',
          })
          .execute();
      }
    });

    const answer = await runtime.runner.run(groupContext('read-gap'), async ({ query }) => {
      const selection = await workProfileInForce(query, {
        organizationId: multi().alpha.organizationId,
        membershipId: gapSubject,
        at: new Date('2024-01-01T00:00:00.000Z'),
      });
      return selection;
    });

    expect(answer.kind, 'a gap returned a row — an ended arrangement was applied').toBe('none');
    if (answer.kind === 'none') {
      expect(answer.reason).toBe('gap');
      // `nearest` is a diagnostic. It names the ended row so an operator can find
      // it, and it is on a different field of a different outcome so it cannot be
      // mistaken for a verdict.
      expect(answer.nearest?.id).toBe(before);
    }
    log('a gap between two windows reports `gap` and names the ended row as a diagnostic only');
  });

  it('order independence: the same answer when the rows come back reversed', async () => {
    // The loader's ORDER BY exists so a failure is reproducible, not so the rule
    // works. Proven here against REAL rows by re-running the pure rule over the
    // reversed set.
    const rows = await runtime.runner.run(groupContext('order-independence'), ({ query }) =>
      loadWorkProfiles(query, {
        organizationId: multi().alpha.organizationId,
        membershipId: subject(),
      }),
    );
    for (const instant of [
      '2023-06-01T00:00:00.000Z',
      '2024-01-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2030-01-01T00:00:00.000Z',
    ]) {
      const forward = selectInForce(rows, new Date(instant));
      const reversed = selectInForce([...rows].reverse(), new Date(instant));
      expect(JSON.stringify(reversed), `order-dependent at ${instant}`).toBe(JSON.stringify(forward));
    }
  });
});
