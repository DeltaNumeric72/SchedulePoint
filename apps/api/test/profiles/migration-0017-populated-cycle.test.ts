import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../../src/db/migrate.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { digestRows } from '../../src/schedule/render.js';
import {
  createQualification,
  grantHolding,
  type QualificationRow,
} from '../../src/profiles/qualifications.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantStaffingCapabilities } from '../support/staffing.js';
import { observeBackend } from './lock-observation.js';

/**
 * **Migration 0017, up → down → up, over a POPULATED database** (OPUS-M4-001S;
 * doc 35 §6c Tests: "migration 0017 populated cycle by name").
 *
 * ## What this adds over the standing cycle
 *
 * `globalSetup` runs the whole stack up → down → up before every run, on an
 * EMPTY database, which proves the SQL is executable in both directions. It
 * cannot prove anything about a migration whose entire content is the BODY of
 * two guard functions: an empty database has no holding for the guards to
 * refuse, so an up migration that silently lost its locking clause would pass
 * that cycle unchanged.
 *
 * So this file populates first, and the cycle's midpoint is where the evidence
 * is:
 *
 *   1. a qualification with an open-ended live holding, written through the
 *      services, plus the SEQUENTIAL R5 refusal as a control;
 *   2. **down past 0017 BY NAME** — and with the serialization removed, the
 *      review's D3 interleaving is ADMITTED again, measured right here. That is
 *      what reversing this migration means, and it is the strongest available
 *      statement that the up migration is what enforces the invariant;
 *   3. the forbidden state is undone (`requires_expiry` back to `false`, which
 *      no guard forbids) so the fixture leaves nothing violating behind;
 *   4. **up again**, in a `finally`, and the same interleaving is now REFUSED.
 *
 * ## BY NAME, never by position (FAD-33(4))
 *
 * The loop rolls down one migration at a time until 0017 has come down, so the
 * termination condition IS the name and there is no count to go stale when 0018
 * lands above it. The whole cycle — including the loop's own "ran out of
 * migrations" throw — sits inside the `try`, and the re-up is unconditional in
 * the `finally`: an assertion failing between the two can never leave the schema
 * short for the rest of the run. Both properties are FAD-33(4) and the M4-001
 * close-out's extension of it, and both exist because the positional form
 * poisoned a shared cluster twice.
 *
 * ## Fixture ownership (FAD-15)
 *
 * The tenant is this file's own; every qualification and holding is created
 * here. The migration steps are global to the cluster, which is why they are
 * bracketed the way they are — the file is `fileParallelism: false` like every
 * other, so no sibling runs inside the window.
 */

const multi = ownedMulti('migration-0017-populated-cycle');

let admin: pg.Client;
let runtime: Runtime;

const alpha = () => multi().alpha;

const staffingContext = (correlationId: string) => ({
  organizationId: alpha().organizationId,
  groupId: alpha().groupOne.id,
  membershipId: alpha().users.groupOnly.membershipId,
  correlationId,
});

const staffingRun = async <T>(
  correlationId: string,
  fn: (uow: PgUnitOfWork) => Promise<T>,
): Promise<T> => runtime.runner.run(staffingContext(correlationId), fn);

const subject = () => alpha().users.scheduler.membershipId;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let created = 0;
async function newQualification(label: string): Promise<QualificationRow> {
  created += 1;
  return staffingRun(`q-${label}`, (uow) =>
    createQualification(uow, {
      key: `cycle-0017-${label}-${String(created)}`,
      name: `Cycle 0017 ${label}`,
    }),
  );
}

const flipStatement = (uow: PgUnitOfWork, qualificationId: string) =>
  sql`update qualifications set requires_expiry = true where id = ${qualificationId}::uuid`.execute(
    uow.query,
  );

interface FinalState {
  readonly requiresExpiry: boolean;
  readonly openEndedLive: number;
}

async function finalState(qualificationId: string): Promise<FinalState> {
  const row = await admin.query<{ requires_expiry: boolean; n: number }>(
    `select q.requires_expiry,
            (select count(*)::int from qualification_holdings h
              where h.qualification_id = q.id
                and h.valid_until is null
                and h.status in ('pending', 'valid', 'expiring')) as n
       from qualifications q where q.id = $1::uuid`,
    [qualificationId],
  );
  const found = row.rows[0];
  if (found === undefined) throw new Error('the qualification vanished');
  return { requiresExpiry: found.requires_expiry, openEndedLive: found.n };
}

/**
 * The D3 interleaving, run once against whatever schema is currently applied.
 *
 * The grant is held open across the flip, so the flip meets an UNCOMMITTED
 * open-ended holding — the exact shape the review reproduced. Returns the flip's
 * SQLSTATE (or `NO ERROR`) and the state that committed.
 */
async function raceFlipAgainstOpenGrant(
  label: string,
  qualificationId: string,
): Promise<{ flipCode: string; flipBlocked: boolean; state: FinalState }> {
  const grantHoldsRow = deferred<void>();
  const grantGate = deferred<void>();
  const flipPid = deferred<number>();
  let grantSettled = false;
  let grantFailure: unknown;
  let flipSettledWhileGrantOpen = false;

  const grant = staffingRun(`${label}-grant`, async (uow) => {
    await grantHolding(uow, {
      membershipId: subject(),
      qualificationId,
      validFrom: '2030-01-01T00:00:00.000Z',
      validUntil: null,
      status: 'valid',
    });
    grantHoldsRow.resolve();
    await grantGate.promise;
  }).then(
    () => {
      grantSettled = true;
    },
    (error: unknown) => {
      /* A grant that fails where this helper expects it to WAIT must not leave
       * the gate closed for ever — a wedged pool is a hung run, not a failure. */
      grantSettled = true;
      grantHoldsRow.resolve();
      grantFailure = error;
    },
  );
  await grantHoldsRow.promise;
  if (grantFailure !== undefined) throw grantFailure;

  let flipCode = 'NO ERROR';
  let flipSettled = false;
  const flip = staffingRun(`${label}-flip`, async (uow) => {
    const pid = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(uow.query);
    flipPid.resolve(pid.rows[0]?.pid ?? 0);
    await flipStatement(uow, qualificationId);
  })
    .catch((error: unknown) => {
      flipCode = String((error as { code?: string }).code ?? `no code: ${String(error)}`);
      flipPid.resolve(0);
    })
    .finally(() => {
      flipSettled = true;
      flipSettledWhileGrantOpen = !grantSettled;
    });

  /* Wait for the flip to reach ONE of its two possible states — settled, or
   * blocked on a lock — so neither schema is measured on a timer. Under 0017 it
   * blocks; with 0017 reversed it settles beside the open grant. A budget
   * expiring here is a finding, not a flake. */
  const pid = await flipPid.promise;
  const deadline = Date.now() + 20_000;
  let flipBlocked = false;
  try {
    while (!flipSettled && !flipBlocked) {
      if (Date.now() > deadline) {
        throw new Error(`the flip neither settled nor blocked within 20s (backend ${String(pid)})`);
      }
      const seen = await observeBackend(admin, pid);
      flipBlocked = seen?.waitEventType === 'Lock' && seen.blockedBy.length > 0;
      if (!flipBlocked && !flipSettled) await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    /* Unconditional, for the same reason the serialization proof's arms release
     * theirs in a `finally`: a throw above must fail the test, never hang it. */
    grantGate.resolve();
    await grant;
    await flip;
  }

  /* If it settled at all, it settled while the grant was still open — that is
   * what makes an admission an admission rather than an ordinary sequential
   * write. */
  if (!flipBlocked) {
    expect(
      flipSettledWhileGrantOpen,
      'the flip settled only after the grant committed — no interleaving occurred',
    ).toBe(true);
  }

  return { flipCode, flipBlocked, state: await finalState(qualificationId) };
}

/** The tables the cycle must leave byte-identical. 0017 creates and drops none. */
const CENSUS = ['qualifications', 'qualification_holdings'] as const;

async function census(): Promise<Record<string, { count: number; digest: string }>> {
  const result: Record<string, { count: number; digest: string }> = {};
  for (const table of CENSUS) {
    const rows = await admin.query<Record<string, unknown>>(
      `select id, organization_id, status from ${table} order by id`,
    );
    result[table] = { count: rows.rows.length, digest: digestRows(rows.rows) };
  }
  return result;
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 6 });

  await grantStaffingCapabilities(runtime.runner, multi(), {
    organizationId: alpha().organizationId,
    groupId: alpha().groupOne.id,
    membershipId: alpha().users.groupOnly.membershipId,
    capabilities: [
      'staffing.qualification.administer',
      'staffing.qualification_holding.administer',
    ],
  });
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
  await admin?.end();
});

describe('migration 0017 over a populated database', () => {
  it('up → down → up, resolved BY NAME, with the interleaving measured at the midpoint', async () => {
    /* ── 1. Populate, through the production path ─────────────────────────── */
    const sequential = await newQualification('sequential-control');
    await staffingRun('seed-holding', (uow) =>
      grantHolding(uow, {
        membershipId: subject(),
        qualificationId: sequential.id,
        validFrom: '2030-01-01T00:00:00.000Z',
        validUntil: null,
        status: 'valid',
      }),
    );

    /* The SEQUENTIAL rule (FAD-28 R5, migration 0012 §3b) — untouched by this
     * packet, asserted here so the cycle has a control that does not depend on
     * concurrency at all. */
    const sequentialRefusal = await staffingRun('seq-flip', (uow) =>
      flipStatement(uow, sequential.id).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    expect(String((sequentialRefusal as { code?: string }).code)).toBe('23001');

    const censusBefore = await census();

    /* ── 2. DOWN to a NAMED TARGET, and back UP unconditionally ───────────── */
    let up: readonly string[] = [];
    const down: string[] = [];
    let admitted: { flipCode: string; flipBlocked: boolean; state: FinalState } | undefined;
    let censusMidway: Record<string, { count: number; digest: string }> | undefined;
    let reverted: FinalState | undefined;

    try {
      while (!down.some((name) => name.includes('0017'))) {
        const step = await migrate('down', { count: 1 });
        if (step.applied.length === 0) {
          throw new Error('ran out of migrations before reaching 0017 — the ledger is empty');
        }
        down.push(...step.applied);
      }
      expect(
        down.some((name) => name.includes('0017')),
        '0017 must be among the reversed migrations',
      ).toBe(true);

      /* 0017 creates no table and drops none, so NOTHING may have moved. */
      censusMidway = await census();

      /* THE MEASUREMENT. With the serialization reversed, the flip commits
       * beside an in-flight open-ended grant and the forbidden state exists —
       * the review's D3 finding, reproduced against the down migration's own
       * schema. */
      const target = await newQualification('midway-admission');
      admitted = await raceFlipAgainstOpenGrant('midway', target.id);

      /* Undone immediately: `true → false` is not a flip and no guard forbids
       * it, so the fixture leaves no violating row behind for the re-up to
       * inherit or for a later file to trip over. */
      await staffingRun('midway-undo', (uow) =>
        sql`update qualifications set requires_expiry = false where id = ${target.id}::uuid`.execute(
          uow.query,
        ),
      );
      reverted = await finalState(target.id);
    } finally {
      up = (await migrate('up', { count: down.length })).applied;
    }

    expect(up).toHaveLength(down.length);
    expect(
      up.some((name) => name.includes('0017')),
      '0017 must be among the re-applied migrations',
    ).toBe(true);

    for (const table of CENSUS) {
      expect(censusMidway?.[table]?.count, `${table} row count after down`).toBe(
        censusBefore[table]?.count,
      );
      expect(censusMidway?.[table]?.digest, `${table} content after down`).toBe(
        censusBefore[table]?.digest,
      );
    }

    expect(admitted?.flipBlocked, 'the reversed migration still blocked the flip').toBe(false);
    expect(admitted?.flipCode, 'the down migration did not restore the 0012 behaviour').toBe(
      'NO ERROR',
    );
    expect(admitted?.state.requiresExpiry).toBe(true);
    expect(admitted?.state.openEndedLive).toBe(1);
    expect(reverted?.requiresExpiry, 'the midway state was not undone').toBe(false);
    log(
      `midway (0017 down): flip=${String(admitted?.flipCode)} → requires_expiry=true with ` +
        `${String(admitted?.state.openEndedLive)} open-ended live holding — the D3 admission`,
    );

    /* ── 3. The guards are ENFORCING again after the re-up ────────────────── */
    const afterCycle = await newQualification('after-cycle');
    const refused = await raceFlipAgainstOpenGrant('after', afterCycle.id);
    expect(refused.flipBlocked, 'the re-applied 0017 did not BLOCK the flip').toBe(true);
    expect(refused.flipCode, 'the re-applied 0017 did not refuse the flip').toBe('23001');
    expect(refused.state.requiresExpiry).toBe(false);
    expect(refused.state.openEndedLive).toBe(1);

    /* And the sequential rule still holds, on the row seeded before the cycle. */
    const sequentialAfter = await staffingRun('seq-flip-after', (uow) =>
      flipStatement(uow, sequential.id).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    expect(String((sequentialAfter as { code?: string }).code)).toBe('23001');
    log('after re-up: concurrent flip refused 23001, sequential flip refused 23001');
  }, 180_000);
});
