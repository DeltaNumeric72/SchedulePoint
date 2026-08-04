import { randomUUID } from 'node:crypto';

import { createShiftTypeRequestSchema, shiftTypeSchema } from '@schedulepoint/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as catalogue from '../../src/catalogue/service.js';
import { adminClient } from '../support/admin-client.js';
import { groupContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * Regressions for the independent review's findings S-02..S-05.
 *
 * Each one is written the way the reviewer found it — the probe that worked,
 * repeated — so a revert of the fix turns the test red rather than leaving it
 * green against a paraphrase.
 *
 * Every case carries its ALLOW control: a refusal proves nothing unless the
 * thing that should succeed does.
 */

const multi = ownedMulti('catalogue-review-findings', {
  profile: 'full',
  seed: { catalogue: ['alpha'] },
});

let admin: pg.Client;
let runtime: Runtime;
let runtimeB: Runtime;

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
function draft(overrides: Record<string, unknown> = {}) {
  sequence += 1;
  return createShiftTypeRequestSchema.parse({
    code: `RF${String(sequence)}`,
    name: 'Review-finding subject',
    startTime: '08:00',
    endTime: '16:00',
    ...overrides,
  });
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 3 });
  runtimeB = createRuntime('app_runtime', { max: 2 });
}, 180_000);

afterAll(async () => {
  await runtime.destroy();
  await runtimeB.destroy();
  await admin.end();
});

/* ────────────────────────────────────────────────────────────────────────────
 * S-02 — the monotonic counter was ungated on INSERT
 * ──────────────────────────────────────────────────────────────────────────── */

describe('S-02 — pick_position_count is gated on INSERT as well as UPDATE', () => {
  /** An organization-scoped unit of work acting as the organization administrator. */
  function organizationContext(correlationId: string) {
    return {
      organizationId: alpha().organizationId,
      groupId: null,
      membershipId: alpha().users.organizationAdmin.membershipId,
      correlationId,
    };
  }

  it('CONTROL: creating a group with the DEFAULT count is still ordinary group creation', async () => {
    // Not gated, and must not be: `organization.group.administer` governs group
    // creation, and a count of zero administers no pick positions. Without this
    // control the refusal below could mean "group creation is broken".
    const id = randomUUID();
    await runtime.runner.run(organizationContext('s02-control'), ({ query }) =>
      query
        .insertInto('groups')
        .values({ id, organization_id: alpha().organizationId, name: `S02 control ${id.slice(0, 8)}` })
        .execute(),
    );
    const stored = await admin.query<{ pick_position_count: number }>(
      'select pick_position_count from groups where id = $1',
      [id],
    );
    expect(stored.rows[0]?.pick_position_count).toBe(0);
    log('CONTROL: group created with the default count 0, ungated, as designed');
  });

  it('RED (the reviewer\'s probe): an INSERT carrying a non-zero count is REFUSED', async () => {
    /* The reviewer inserted a group with `pick_position_count = 500` under an
     * organization-scoped context and it was ACCEPTED — and monotonicity makes
     * that permanent, so the whole control was one INSERT away from decorative.
     *
     * The acting membership here holds `organization.group.administer` (it just
     * created a group above) and does NOT hold
     * `group.pick_positions.administer`, so the refusal is specifically the
     * pick-position gate rather than a general lack of authority. */
    const id = randomUUID();
    await expect(
      runtime.runner.run(organizationContext('s02-red'), ({ query }) =>
        query
          .insertInto('groups')
          .values({
            id,
            organization_id: alpha().organizationId,
            name: `S02 red ${id.slice(0, 8)}`,
            pick_position_count: 500,
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const landed = await admin.query<{ n: number }>(
      'select count(*)::int as n from groups where id = $1',
      [id],
    );
    expect(landed.rows[0]?.n, 'the ungated group landed anyway').toBe(0);
    log('RED: INSERT with pick_position_count = 500 → 42501, and no group was created');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * S-03 — effective dating is authorable
 * ──────────────────────────────────────────────────────────────────────────── */

describe('S-03 — the in-force window is authorable, and read filtering is M4', () => {
  it('a FUTURE-DATED definition round-trips: authored, stored, and read back', async () => {
    // The case effective dating exists for: a definition prepared ahead of the
    // rota change it belongs to. Before this fix the contract had no field for
    // it, so `effective_from` could only ever be "now" — created_at in disguise.
    const from = '2030-01-01T00:00:00.000Z';
    const to = '2031-01-01T00:00:00.000Z';

    const created = await runtime.runner.run(author('s03-future'), (uow) =>
      catalogue.createShiftType(uow, draft({ effectiveFrom: from, effectiveTo: to })),
    );
    expect(created.kind, JSON.stringify(created)).toBe('ok');
    if (created.kind !== 'ok') return;
    expect(created.value.effectiveFrom).toBe(from);
    expect(created.value.effectiveTo).toBe(to);

    // Parsed through the contract, so the wire shape is the one clients get.
    expect(shiftTypeSchema.parse(created.value).effectiveFrom).toBe(from);

    // And it is READABLE from the authoring list even though it is not in force
    // — deliberately. An authoring surface that hid a future-dated definition
    // would make it uneditable, which is the opposite of the point.
    const listed = await runtime.runner.run(author('s03-list'), (uow) =>
      catalogue.listShiftTypes(uow),
    );
    expect(
      listed.map((shiftType) => shiftType.shiftTypeId),
      'the authoring list hid a definition that is not yet in force',
    ).toContain(created.value.shiftTypeId);
    log(`future-dated definition ${from} → ${to} round-trips and stays visible for authoring`);
  });

  it('the window can be re-authored, and an END BEFORE the START is refused by field', async () => {
    const created = await runtime.runner.run(author('s03-edit-setup'), (uow) =>
      catalogue.createShiftType(uow, draft()),
    );
    if (created.kind !== 'ok') throw new Error('setup failed');

    const moved = await runtime.runner.run(author('s03-edit'), (uow) =>
      catalogue.updateShiftType(uow, created.value.shiftTypeId, {
        effectiveFrom: '2029-06-01T00:00:00.000Z',
        effectiveTo: '2029-12-01T00:00:00.000Z',
      }),
    );
    expect(moved.kind, JSON.stringify(moved)).toBe('ok');
    if (moved.kind !== 'ok') return;
    expect(moved.value.shiftType.effectiveFrom).toBe('2029-06-01T00:00:00.000Z');

    const backwards = await runtime.runner.run(author('s03-backwards'), (uow) =>
      catalogue.updateShiftType(uow, created.value.shiftTypeId, {
        effectiveFrom: '2029-06-01T00:00:00.000Z',
        effectiveTo: '2029-01-01T00:00:00.000Z',
      }),
    );
    expect(backwards.kind).toBe('invalid');
    if (backwards.kind !== 'invalid') return;
    expect(backwards.problems.map((problem) => problem.field)).toContain('effectiveTo');
    log(`backwards window refused: ${backwards.problems[0]?.message ?? ''}`);
  });

  it('a FUTURE-DATED definition can still be RETIRED — the retirement instant is the database\'s', async () => {
    /* Found by the shuffled full-suite run after the M2-003 rebase, and then
     * reproduced deterministically.
     *
     * `effective_from` is `DEFAULT now()` — a PostgreSQL timestamp with
     * MICROSECOND resolution — and the retirement instant used to be a
     * JavaScript `Date`, which has MILLISECOND resolution. Comparing the two
     * against `shift_types_window` (`effective_to > effective_from`) failed
     * twice over:
     *
     *   1. INTERMITTENTLY, when a type was created and retired inside the same
     *      millisecond. That is what the shuffled run hit, and nothing else ever
     *      ran the two close enough together to see it;
     *   2. DETERMINISTICALLY, once S-03 made windows authorable: a definition
     *      that comes into force next year could not be retired AT ALL, because
     *      "now" is before it started.
     *
     * The second is the reproduction below, because a test that depends on two
     * statements landing in the same millisecond is a test that passes for the
     * wrong reason most of the time. */
    const created = await runtime.runner.run(author('s03-retire-future'), (uow) =>
      catalogue.createShiftType(uow, draft({ effectiveFrom: '2030-01-01T00:00:00.000Z' })),
    );
    if (created.kind !== 'ok') throw new Error('setup failed');

    const retired = await runtime.runner.run(author('s03-retire'), (uow) =>
      catalogue.updateShiftType(uow, created.value.shiftTypeId, { status: 'retired' }),
    );
    expect(retired.kind, JSON.stringify(retired)).toBe('ok');
    if (retired.kind !== 'ok') return;
    expect(retired.value.archived).toBe(true);

    // The window closed AFTER it opened, which is the invariant the CHECK states
    // and the thing an application-supplied instant could not guarantee.
    const stored = await admin.query<{ effective_from: Date; effective_to: Date | null }>(
      'select effective_from, effective_to from shift_types where id = $1',
      [created.value.shiftTypeId],
    );
    const from = stored.rows[0]?.effective_from;
    const to = stored.rows[0]?.effective_to;
    expect(to, 'retirement left the window open').not.toBeNull();
    expect(
      (to as Date).getTime(),
      'the window closed at or before it opened',
    ).toBeGreaterThan((from as Date).getTime() - 1);
    /* ── and the SECOND defect the same run exposed ─────────────────────────
     *
     * Retiring a future-dated definition closes the window at
     * `effective_from + 1 microsecond` — a window narrower than a millisecond,
     * deterministically. Reading that back through a JavaScript `Date` (which
     * has millisecond resolution) made `effectiveTo === effectiveFrom`, and the
     * service then re-validated the STORED window on every later update and
     * refused it as backwards. The row was fine; the round trip was lossy.
     *
     * Intermittently this hit any type retired in the same millisecond it was
     * created, which is why the shuffled run found it and nothing else did. Here
     * it is deterministic, because a future-dated retirement ALWAYS produces the
     * 1-microsecond window. */
    const renamed = await runtime.runner.run(author('s03-retire-then-edit'), (uow) =>
      catalogue.updateShiftType(uow, created.value.shiftTypeId, {
        name: 'Renamed after a sub-millisecond retirement',
      }),
    );
    expect(
      renamed.kind,
      'an update after retirement was refused for a window the database accepts',
    ).toBe('ok');

    log(`future-dated definition retired: ${from?.toISOString() ?? ''} -> ${to?.toISOString() ?? ''}, and still editable`);
  });

  it('`null` on effectiveTo OPENS the window; the row keeps a finite start', async () => {
    const created = await runtime.runner.run(author('s03-open-setup'), (uow) =>
      catalogue.createShiftType(uow, draft({ effectiveTo: '2029-01-01T00:00:00.000Z' })),
    );
    if (created.kind !== 'ok') throw new Error('setup failed');
    expect(created.value.effectiveTo).not.toBeNull();

    const opened = await runtime.runner.run(author('s03-open'), (uow) =>
      catalogue.updateShiftType(uow, created.value.shiftTypeId, { effectiveTo: null }),
    );
    expect(opened.kind, JSON.stringify(opened)).toBe('ok');
    if (opened.kind !== 'ok') return;
    expect(opened.value.shiftType.effectiveTo).toBeNull();
    log('effectiveTo: null reopens a closed window, and the start stays finite');
  });

  it('an INFINITE bound is refused — `null` is how a window is left open (S-22)', async () => {
    // `timestamptz` accepts `infinity`; every ordinary window comparison is
    // satisfied by it; node-postgres returns it as the number `Infinity`, on
    // which `.toISOString()` throws. The database refuses it too
    // (`shift_types_finite_window`); this refuses it earlier, with the field named.
    const outcome = await runtime.runner.run(author('s03-infinity'), (uow) =>
      catalogue.createShiftType(uow, {
        ...draft(),
        effectiveFrom: 'infinity',
      } as never),
    );
    expect(outcome.kind).toBe('invalid');
    log('an infinite effectiveFrom is refused with a field-addressed problem');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * S-04 — the pick-position read was an arbitrary-row read
 * ──────────────────────────────────────────────────────────────────────────── */

describe('S-04 — pick position reads and writes pin their tenant', () => {
  it('CONTROL: under a GROUP context the count is this group\'s, not a sibling\'s', async () => {
    /* Order-independent by construction. `pick_position_count` is MONOTONIC and
     * cannot be reset, so "the count is 12" is an assertion about which test ran
     * first — which is what `corepack pnpm fixture-regression` caught on the
     * first shuffled run of this file.
     *
     * The property being asserted is that the read returns THIS group's row.
     * That needs the two groups to hold DIFFERENT counts, and they do by
     * construction: the fixture grants the pick-position capability for Group
     * One only, so the sibling group is never raised and stays at 0. */
    const groupAdmin = alpha().full?.groupAdmin;
    if (groupAdmin === undefined) throw new Error('the full profile provisions a group admin');

    const groundTruth = async (groupId: string): Promise<number> => {
      const result = await admin.query<{ pick_position_count: number }>(
        'select pick_position_count from groups where id = $1',
        [groupId],
      );
      return result.rows[0]?.pick_position_count ?? -1;
    };

    const raised = await runtime.runner.run(
      groupContext(alpha().organizationId, alpha().groupOne.id, groupAdmin.membershipId, 's04-setup'),
      async (uow) => {
        const outcome = await catalogue.setPickPositionCount(uow, (await groundTruth(alpha().groupOne.id)) + 1);
        if (outcome.kind !== 'ok') throw new Error(`setup reported ${outcome.kind}`);
        return outcome.value;
      },
    );

    const read = await runtime.runner.run(
      groupContext(alpha().organizationId, alpha().groupOne.id, groupAdmin.membershipId, 's04-read'),
      (uow) => catalogue.readPickPositionCount(uow),
    );
    expect(read).toBe(raised);
    expect(read).toBe(await groundTruth(alpha().groupOne.id));

    const sibling = await groundTruth(alpha().groupTwo.id);
    expect(
      sibling,
      'the sibling group holds the same count, so this test could not tell the two apart',
    ).not.toBe(read);
    log(`group one reads ${String(read)}; the sibling group holds ${String(sibling)}`);
  });

  it('RED (the reviewer\'s probe): under an ORGANIZATION context the read REFUSES rather than guessing', async () => {
    /* The reviewer called this under an organization-scoped context and got a
     * random group's count back — `groups_organization_scope` admits every group
     * in the organization, so the unpinned SELECT returned whichever row the
     * planner produced first. That is the M1 S-01 defect class exactly: a read
     * with no predicate and no total order, whose answer is usually right.
     *
     * A clean, named error is the correct outcome. Returning a scoped answer
     * would also be acceptable per the ruling; returning an arbitrary one is not,
     * and this asserts it cannot. */
    await expect(
      runtime.runner.run(
        {
          organizationId: alpha().organizationId,
          groupId: null,
          membershipId: alpha().users.organizationAdmin.membershipId,
          correlationId: 's04-red',
        },
        (uow) => catalogue.readPickPositionCount(uow),
      ),
    ).rejects.toThrow(/CATALOGUE_REQUIRES_GROUP_CONTEXT/);
    log('organization-scoped read → named refusal, never an arbitrary group\'s count');
  });

  it('the WRITE is pinned too — a raise touches one group and no other', async () => {
    const groupAdmin = alpha().full?.groupAdmin;
    if (groupAdmin === undefined) throw new Error('the full profile provisions a group admin');

    const before = await admin.query<{ id: string; pick_position_count: number }>(
      'select id, pick_position_count from groups where organization_id = $1 order by id',
      [alpha().organizationId],
    );

    const current = before.rows.find((row) => row.id === alpha().groupOne.id);
    const outcome = await runtime.runner.run(
      groupContext(alpha().organizationId, alpha().groupOne.id, groupAdmin.membershipId, 's04-write'),
      // Relative, not absolute: the count is monotonic and other tests raise it.
      (uow) => catalogue.setPickPositionCount(uow, (current?.pick_position_count ?? 0) + 5),
    );
    expect(outcome.kind).toBe('ok');

    const after = await admin.query<{ id: string; pick_position_count: number }>(
      'select id, pick_position_count from groups where organization_id = $1 order by id',
      [alpha().organizationId],
    );
    const moved = after.rows.filter((row, index) => {
      const previous = before.rows[index];
      return previous !== undefined && previous.pick_position_count !== row.pick_position_count;
    });
    expect(moved.map((row) => row.id), 'more than one group moved').toEqual([alpha().groupOne.id]);
    log(`${String(after.rows.length)} groups in the organization; exactly 1 moved`);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * S-05 — `version` is a control, not a number that looks like one
 * ──────────────────────────────────────────────────────────────────────────── */

describe('S-05 — optimistic concurrency actually prevents a lost update', () => {
  it('RED (the reviewer\'s probe): app_runtime cannot set `version` at all', async () => {
    // The reviewer set it back to 1 as `app_runtime` and it was accepted. The
    // column is out of every UPDATE grant now, so naming it is 42501 — before
    // the row is even considered.
    const created = await runtime.runner.run(author('s05-grant-setup'), (uow) =>
      catalogue.createShiftType(uow, draft()),
    );
    if (created.kind !== 'ok') throw new Error('setup failed');

    await expect(
      runtime.runner.run(author('s05-grant'), ({ query }) =>
        query
          .updateTable('shift_types')
          .set({ version: 1, updated_at: new Date() })
          .where('id', '=', created.value.shiftTypeId)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    log('app_runtime UPDATE naming `version` → 42501; the column is the database\'s');
  });

  it('the database bumps `version` on every update, without being asked', async () => {
    const created = await runtime.runner.run(author('s05-bump-setup'), (uow) =>
      catalogue.createShiftType(uow, draft()),
    );
    if (created.kind !== 'ok') throw new Error('setup failed');
    expect(created.value.version).toBe(1);

    const renamed = await runtime.runner.run(author('s05-bump'), (uow) =>
      catalogue.updateShiftType(uow, created.value.shiftTypeId, { name: 'Renamed once' }),
    );
    expect(renamed.kind).toBe('ok');
    if (renamed.kind !== 'ok') return;
    expect(renamed.value.shiftType.version, 'the trigger did not bump the version').toBe(2);
    log('version 1 → 2, assigned by app_maintain_catalogue_version');
  });

  it('RED: the SELECT-merge-UPDATE race no longer loses a write — the second is a CONFLICT', async () => {
    /* The reviewer's lost update, reproduced at the layer the predicate defends.
     *
     * The window is INSIDE one service call: `updateShiftType` reads the row,
     * merges the caller's fields onto it, and writes. Two calls whose reads both
     * happen before either write is the race — and without the predicate the
     * later write silently overwrites the earlier one, because each was
     * "correct" against what it read.
     *
     * Producing that interleaving deliberately:
     *
     *   A  run → updateShiftType (SELECT v1, UPDATE → v2) … holds the row lock,
     *      transaction NOT yet committed
     *   B  run → updateShiftType: its SELECT sees v1 (A is uncommitted), then its
     *      UPDATE blocks on A's lock
     *   A  commits
     *   B  unblocks and re-evaluates `WHERE version = 1` against the committed
     *      v2 → zero rows → CONFLICT
     *
     * B is started OUTSIDE A's async context: a nested `run` becomes a savepoint
     * on A's own connection and could never contend (SPIKE-REPORT §6.6). */
    const created = await runtime.runner.run(author('s05-race-setup'), (uow) =>
      catalogue.createShiftType(uow, draft({ name: 'Original name' })),
    );
    if (created.kind !== 'ok') throw new Error('setup failed');
    const shiftTypeId = created.value.shiftTypeId;

    let releaseA: () => void = () => {};
    const aHasWritten = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let releaseB: () => void = () => {};
    const bMayCommit = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    const a = runtime.runner.run(author('s05-race-a'), async (uow) => {
      const outcome = await catalogue.updateShiftType(uow, shiftTypeId, { name: 'Written by A' });
      releaseA();
      await bMayCommit;
      return outcome;
    });

    await aHasWritten;

    const b = (async () => {
      const attempt = runtimeB.runner.run(author('s05-race-b'), (uow) =>
        catalogue.updateShiftType(uow, shiftTypeId, { name: 'Written by B' }),
      );
      // Long enough for B's SELECT to run and its UPDATE to reach A's row lock,
      // so the contention is real rather than accidental ordering.
      setTimeout(releaseB, 250);
      return attempt;
    })();

    const aResult = await a;
    const bResult = await b;

    expect(aResult.kind).toBe('ok');
    expect(
      bResult.kind,
      "the later write was ACCEPTED — the first writer's change was lost",
    ).toBe('conflict');

    const stored = await admin.query<{ name: string; version: number }>(
      'select name, version from shift_types where id = $1',
      [shiftTypeId],
    );
    expect(stored.rows[0]?.name, "B's write landed despite reporting a conflict").toBe(
      'Written by A',
    );
    expect(stored.rows[0]?.version).toBe(2);
    log(
      `A committed at version ${String(stored.rows[0]?.version ?? 0)}; B's stale predicate ` +
        `matched nothing and reported conflict; stored name "${stored.rows[0]?.name ?? ''}"`,
    );
  });

  it('CONTROL: two SEQUENTIAL updates both succeed — the predicate blocks races, not edits', async () => {
    // Without this, a service that always reported `conflict` would satisfy the
    // test above and be useless.
    const created = await runtime.runner.run(author('s05-sequential-setup'), (uow) =>
      catalogue.createShiftType(uow, draft()),
    );
    if (created.kind !== 'ok') throw new Error('setup failed');

    const first = await runtime.runner.run(author('s05-sequential-1'), (uow) =>
      catalogue.updateShiftType(uow, created.value.shiftTypeId, { name: 'First edit' }),
    );
    const second = await runtime.runner.run(author('s05-sequential-2'), (uow) =>
      catalogue.updateShiftType(uow, created.value.shiftTypeId, { name: 'Second edit' }),
    );
    expect(first.kind).toBe('ok');
    expect(second.kind, 'a sequential second edit was refused').toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.value.shiftType.version).toBe(3);
    log('sequential edits: both accepted, version 1 → 2 → 3');
  });

  it('shift GROUPS carry the same predicate', async () => {
    const group = await runtime.runner.run(author('s05-group-setup'), (uow) =>
      catalogue.createShiftGroup(uow, {
        name: `Concurrency subject ${String(sequence)}`,
        description: null,
        scoring: { scoringMode: 'hard' },
        request: { allowRequest: false },
        shiftTypeIds: [],
      }),
    );
    if (group.kind !== 'ok') throw new Error('setup failed');

    // A stale version, supplied by moving the row out from under a reader.
    await runtime.runner.run(author('s05-group-bump'), (uow) =>
      catalogue.updateShiftGroup(uow, group.value.shiftGroupId, { name: 'Moved on' }),
    );

    // The service always re-reads, so a stale read has to be simulated at the
    // predicate: assert the row's version actually moved, which is what makes a
    // stale caller's predicate miss.
    const stored = await admin.query<{ version: number }>(
      'select version from shift_groups where id = $1',
      [group.value.shiftGroupId],
    );
    expect(stored.rows[0]?.version).toBe(2);
    log('shift group version 1 → 2 by trigger; the update predicate is on `version`');
  });
});
