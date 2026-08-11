import { randomUUID } from 'node:crypto';

import { createShiftTypeRequestSchema } from '@schedulepoint/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CATALOGUE_AUDIT_EVENTS } from '../../src/catalogue/policies.js';
import * as catalogue from '../../src/catalogue/service.js';
import { staffingAdvisoryLockKey } from '../../src/catalogue/staffing-set-version.js';
import { advisoryLockKey } from '../../src/http/routes/schedule-authoring.route.js';
import { adminClient } from '../support/admin-client.js';
import { groupContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **The weekday-demand editor's atomicity, concurrency, and emission proofs**
 * (OPUS-M4-000A; doc 34 §4-A; doc 35 §3 Required behaviour clause 1).
 *
 * Four claims, each with the assertion that can catch it lying:
 *
 *  1. Two concurrent whole-set replacements carrying the same
 *     `expectedVersion` can NEVER combine into a union — 12 rounds, DISJOINT
 *     presented sets, asserted against the DATABASE state.
 *  2. A no-op save emits NO audit event, and a real save still emits — both
 *     directions, because an emission control that only checks silence is
 *     satisfied by a dead emitter (FAD-24's load-bearing control).
 *  3. The advisory-lock key derivation matches the schedule surface's, so the
 *     restatement in `staffing-set-version.ts` cannot drift from the original.
 *  4. MUTATION CONTROL — the race oracle detects a union when one is planted,
 *     so round after round of "no union" is a measurement, not a tautology.
 *
 * The lock-removal falsification for claim 1 lives in the red-case runner
 * (`stale-edit-cas` patches the `pg_advisory_xact_lock` out of
 * `acquireStaffingSet`, and this file's race must then fail).
 */

const multi = ownedMulti('demand-replacement', { seed: { catalogue: ['alpha'] } });

let admin: pg.Client;
let runtime: Runtime;
let harness: HttpHarness;

const alpha = () => multi().alpha;

function author(correlationId: string) {
  return groupContext(
    alpha().organizationId,
    alpha().groupOne.id,
    alpha().users.scheduler.membershipId,
    correlationId,
  );
}

let sequence = 0;
async function freshShiftType(): Promise<string> {
  sequence += 1;
  const created = await runtime.runner.run(author(`demand-race-setup-${String(sequence)}`), (uow) =>
    catalogue.createShiftType(
      uow,
      createShiftTypeRequestSchema.parse({
        code: `RACE${String(sequence)}`,
        name: 'Race subject',
        startTime: '08:00',
        endTime: '16:00',
      }),
    ),
  );
  if (created.kind !== 'ok') throw new Error(`setup shift type reported ${created.kind}`);
  return created.value.shiftTypeId;
}

async function storedDemand(
  shiftTypeId: string,
): Promise<{ day: string; demand_count: number }[]> {
  const rows = await admin.query<{ day: string; demand_count: number }>(
    'select day, demand_count from shift_type_weekday_demand where shift_type_id = $1 order by day',
    [shiftTypeId],
  );
  return rows.rows;
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 6 });
  harness = await buildHttpHarness();
}, 180_000);

afterAll(async () => {
  await harness.close();
  await runtime.destroy();
  await admin.end();
});

describe('the 12-round whole-set race — no union, ever', () => {
  it('two replacements, same expectedVersion, disjoint sets: one whole winner, one explicit refusal', async () => {
    const ROUNDS = 12;
    const results: string[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const shiftTypeId = await freshShiftType();

      // Both writers read the same state: a never-written aggregate at 1.
      const writerA = runtime.runner.run(author(`race-${String(round)}-a`), (uow) =>
        catalogue.replaceWeekdayDemand(uow, shiftTypeId, {
          demand: [{ day: 'mon', demandCount: 2 }],
          expectedVersion: 1,
        }),
      );
      const writerB = runtime.runner.run(author(`race-${String(round)}-b`), (uow) =>
        catalogue.replaceWeekdayDemand(uow, shiftTypeId, {
          demand: [{ day: 'fri', demandCount: 7 }],
          expectedVersion: 1,
        }),
      );
      const [a, b] = await Promise.all([writerA, writerB]);

      const winners = [a, b].filter((outcome) => outcome.kind === 'ok');
      const losers = [a, b].filter((outcome) => outcome.kind === 'stale-set');
      const stored = await storedDemand(shiftTypeId);
      results.push(
        `round ${String(round)}: ${a.kind}/${b.kind} stored=${JSON.stringify(stored)}`,
      );

      expect(winners, `round ${String(round)}: both replacements were accepted`).toHaveLength(1);
      expect(losers, `round ${String(round)}: the loser was not told explicitly`).toHaveLength(1);
      const loser = losers[0];
      if (loser?.kind === 'stale-set') {
        // The refetch hint: the version the winner's writes produced.
        expect(loser.currentVersion).toBeGreaterThan(1);
      }

      /* The decisive assertion. The DATABASE holds exactly ONE row — the
       * winner's — never the two-row union, and never the loser's row alone. */
      const winnerWasA = winners[0] === a;
      expect(stored, `round ${String(round)}: the stored set is not exactly the winner's`).toEqual([
        winnerWasA ? { day: 'mon', demand_count: 2 } : { day: 'fri', demand_count: 7 },
      ]);
    }

    log(`demand whole-set race:\n  ${results.join('\n  ')}`);
  }, 240_000);

  it('MUTATION CONTROL: the union oracle detects a planted union', async () => {
    /* The race above asserts `stored == [winner's row]`. This control PLANTS
     * the union outcome — both writers' rows — as the superuser (RLS and
     * grants do not bind it), and asserts the same oracle REJECTS it. If this
     * control ever passes with a green equality, the race has gone vacuous. */
    const shiftTypeId = await freshShiftType();
    const saved = await runtime.runner.run(author('union-control'), (uow) =>
      catalogue.replaceWeekdayDemand(uow, shiftTypeId, {
        demand: [{ day: 'mon', demandCount: 2 }],
        expectedVersion: 1,
      }),
    );
    expect(saved.kind).toBe('ok');

    /* Planted inside a transaction that is ALWAYS rolled back, with the
     * capability-guard triggers suspended for its span (superuser
     * `session_replication_role = replica`, transaction-local) — the union is
     * a state the guarded write path cannot produce, which is the point of
     * proving the oracle would see it. Read back INSIDE the transaction;
     * verified gone after the rollback. */
    try {
      await admin.query('begin');
      await admin.query(`set local session_replication_role = replica`);
      await admin.query(
        `insert into shift_type_weekday_demand
           (id, organization_id, group_id, shift_type_id, day, demand_count)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'fri', 7)`,
        [randomUUID(), alpha().organizationId, alpha().groupOne.id, shiftTypeId],
      );
      const planted = await storedDemand(shiftTypeId);
      // The union is exactly what the race's oracle must refuse:
      expect(planted).not.toEqual([{ day: 'mon', demand_count: 2 }]);
      expect(planted).toHaveLength(2);
    } finally {
      await admin.query('rollback');
    }
    // …and the rollback held: the guarded state is intact.
    expect(await storedDemand(shiftTypeId)).toEqual([{ day: 'mon', demand_count: 2 }]);
    log('union control: the planted two-row union is visibly NOT the winner-only shape');
  });
});

describe('lock-key parity', () => {
  it('staffingAdvisoryLockKey and the schedule surface derive identical keys', () => {
    for (const anchor of ['a', 'tenant|group|staffing-set:weekday_demand:x', '']) {
      expect(staffingAdvisoryLockKey(anchor)).toBe(advisoryLockKey(anchor));
    }
    log('the two sha-256→int64 derivations agree on shared vectors — no silent drift');
  });
});

describe('FAD-24 emission control — both directions, over the real route', () => {
  async function request(
    method: 'GET' | 'PUT',
    path: string,
    payload?: unknown,
  ): Promise<{ statusCode: number; body: string }> {
    const userId = alpha().users.scheduler.id;
    const counters = await currentCounters(admin, {
      organizationId: alpha().organizationId,
      groupId: alpha().groupOne.id,
      userId,
    });
    const response = await harness.app.inject({
      method,
      url: `/organizations/${alpha().organizationId}/groups/${alpha().groupOne.id}/catalogue${path}`,
      headers: {
        ...contextHeaders(userId, counters),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    return { statusCode: response.statusCode, body: response.body };
  }

  async function demandAuditCount(subjectId: string): Promise<number> {
    const rows = await admin.query<{ n: number }>(
      `select count(*)::int as n from audit_events
        where organization_id = $1::uuid and event_name = $2 and subject_id = $3::uuid`,
      [alpha().organizationId, CATALOGUE_AUDIT_EVENTS.shiftTypeDemandSet, subjectId],
    );
    return rows.rows[0]?.n ?? 0;
  }

  it('a REAL save emits exactly one event; the byte-identical re-save emits none', async () => {
    const shiftTypeId = await freshShiftType();

    // Direction one: something moves, and the event fires. Without this arm a
    // dead emitter would pass the silence check below forever.
    const first = await request('PUT', `/shift-types/${shiftTypeId}/weekday-demand`, {
      demand: [
        { day: 'mon', demandCount: 3 },
        { day: 'holiday', demandCount: 1 },
      ],
      expectedVersion: 1,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(await demandAuditCount(shiftTypeId)).toBe(1);
    const savedVersion = (JSON.parse(first.body) as { version: number }).version;

    // The editor's exact round trip: load, save back unchanged.
    const loaded = await request('GET', `/shift-types/${shiftTypeId}/weekday-demand`);
    expect(loaded.statusCode, loaded.body).toBe(200);
    const set = JSON.parse(loaded.body) as {
      demand: { day: string; demandCount: number }[];
      version: number;
    };
    expect(set.version).toBe(savedVersion);

    const noop = await request('PUT', `/shift-types/${shiftTypeId}/weekday-demand`, {
      demand: set.demand,
      expectedVersion: set.version,
    });
    expect(noop.statusCode, noop.body).toBe(200);

    // Direction two: the no-op emitted NOTHING (FAD-24), the version did not
    // move, and the values did not reset.
    expect(await demandAuditCount(shiftTypeId), 'a no-op save was audited as a change').toBe(1);
    const after = JSON.parse(noop.body) as { demand: unknown; version: number };
    expect(after.version).toBe(savedVersion);
    expect(after.demand).toEqual(set.demand);

    // And a REAL change after the no-op still emits — the emitter is alive.
    const changed = await request('PUT', `/shift-types/${shiftTypeId}/weekday-demand`, {
      demand: [{ day: 'mon', demandCount: 4 }],
      expectedVersion: savedVersion,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(await demandAuditCount(shiftTypeId)).toBe(2);
    log('emission: change→1 event, no-op→0 events, change→1 event. Both directions live');
  });
});
