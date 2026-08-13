import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import {
  createQualification,
  grantHolding,
  type QualificationRow,
} from '../../src/profiles/qualifications.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantStaffingCapabilities } from '../support/staffing.js';
import { observeBackend, waitUntilBlockedOnLock } from './lock-observation.js';

/**
 * **NAMED PROOF — the `requires_expiry` flip is serialized against an in-flight
 * grant, in BOTH orders** (OPUS-M4-001S; doc 35 §6c; FAD-36(2), FAD-28 R5,
 * NR-17; migration 0017).
 *
 * ## The invariant under proof
 *
 *     no committed state has `requires_expiry = true` together with an
 *     open-ended live holding of that qualification
 *
 * FAD-28 R5 states it sequentially and migration 0012 §3b enforces it that way.
 * The M4-001R independent review falsified it under concurrency (probe D3): a
 * flip committing beside an in-flight open-ended grant produced exactly that
 * state, with no error on either side.
 *
 * **There is no read-side backstop here**, and that is what separates this from
 * the granted-while-retiring race (FAD-28(2)/FAD-35, pinned by
 * `granted-while-retiring-inertness.test.ts`). Retirement has a verdict
 * dimension — the shared eligibility function evaluates lifecycle first, so the
 * race-produced credential confers nothing. `requires_expiry` has none: it is not
 * an input to the verdict at all, so a race-admitted open-ended holding reads
 * `satisfied` for ever, on every consumer including canonical solver input.
 * FAD-36(2) therefore ruled write-time serialization the bounded fix, because
 * adding a verdict dimension would change the frozen eligibility module.
 *
 * ## What migration 0017 does, and what this file measures
 *
 * One lock object — the `qualifications` row both writers already touch — in two
 * conflicting modes:
 *
 *   * the holding guard reads `requires_expiry` **FOR KEY SHARE**, so the value
 *     it reads is the one it holds a lock against;
 *   * the flip guard takes **FOR UPDATE** before it looks for open-ended
 *     holdings, and FOR UPDATE conflicts with FOR KEY SHARE.
 *
 * Four cases below, in order:
 *
 *   (A) GRANT FIRST — the flip blocks on the grant's row lock, and once the
 *       grant commits the flip sees the holding and raises
 *       `QUALIFICATION_REQUIRES_EXPIRY_CONFLICT` (23001).
 *   (B) FLIP FIRST — the grant blocks INSIDE the holding guard, before it has
 *       read `requires_expiry`; once the flip commits the locking read returns
 *       the committed row and the grant is refused `QUALIFICATION_REQUIRES_EXPIRY`
 *       (23001).
 *   (C) CROSSED, UNGATED — both launch orders, several rounds, no gate and no
 *       sleep deciding anything: every attempt settles inside a bound, exactly
 *       one side of each pair succeeds, no deadlock is detected, and the
 *       invariant holds after every round.
 *   (D) LOCK-ORDER INVERSION — the mandatory deadlock hunt against migration
 *       0003's per-organization audit advisory lock. See its own docblock.
 *
 * Every case re-reads the FINAL STATE from ground truth and asserts the
 * invariant, so a case that stopped refusing for a new reason still fails.
 *
 * ## The blocks are OBSERVED, never assumed
 *
 * Each gated case waits until `pg_stat_activity` reports the blocked backend
 * waiting on a lock **held by the other backend** (`pg_blocking_pids`), naming
 * the wait event it expects — `../profiles/lock-observation.ts`, tightened under
 * review finding R-3. No `sleep` establishes an ordering here; a block that does
 * not happen fails loudly and says what it saw instead.
 *
 * ## Falsifiability (FAD-33(1))
 *
 * `scripts/red-cases/run.mjs` case `requires-expiry-flip-serialization` patches
 * migration 0017's two locking clauses back to their 0012 bodies. The migration
 * is applied by the api project's global setup, so the patch is observed by this
 * file without any rebuild. With the locks gone, (A) and (B) both admit the
 * forbidden final state and fail. Verified in both directions standalone; the
 * transcripts are in `docs/evidence/EV-M4-001S/`.
 *
 * ## Fixture ownership (FAD-15)
 *
 * The tenant is this file's own (`ownedMulti`), every qualification and holding
 * is created here, and each case creates its OWN qualification — so no case can
 * disturb another and file- or test-order shuffle cannot change an outcome. The
 * shared baseline is not touched.
 */

const multi = ownedMulti('requires-expiry-flip-serialization');

let admin: pg.Client;
let runtime: Runtime;

const alpha = () => multi().alpha;

/* The staffing actor is `groupOnly` rather than the scheduler, for the reason
 * `verdict-convergence.test.ts` records: the catalogue seeding opens and closes
 * staffing keys on the scheduler, and `capability_grants_no_overlapping_window`
 * refuses re-opening a window over a closed row. */
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

/** The credential subject. Distinct from the acting principal throughout. */
const subject = () => alpha().users.scheduler.membershipId;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function backendPid(uow: PgUnitOfWork): Promise<number> {
  const row = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(uow.query);
  return row.rows[0]?.pid ?? 0;
}

/** The flip, as the only writer that can perform it: there is NO service path. */
const flipStatement = (uow: PgUnitOfWork, qualificationId: string) =>
  sql`update qualifications set requires_expiry = true where id = ${qualificationId}::uuid`.execute(
    uow.query,
  );

let created = 0;
async function newQualification(label: string): Promise<QualificationRow> {
  created += 1;
  return staffingRun(`q-${label}`, (uow) =>
    createQualification(uow, {
      key: `flip-serialization-${label}-${String(created)}`,
      name: `Flip serialization ${label}`,
    }),
  );
}

/** An OPEN-ENDED live holding — the shape the flip is forbidden to sit over. */
async function grantOpenEnded(uow: PgUnitOfWork, qualificationId: string): Promise<unknown> {
  return grantHolding(uow, {
    membershipId: subject(),
    qualificationId,
    validFrom: '2030-01-01T00:00:00.000Z',
    validUntil: null,
    status: 'valid',
  });
}

interface FinalState {
  readonly requiresExpiry: boolean;
  readonly openEndedLive: number;
}

/** Ground truth, read with the superuser: what actually COMMITTED. */
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

/** THE invariant. Asserted after every case, whatever that case's outcome was. */
function expectInvariant(state: FinalState, where: string): void {
  expect(
    state.requiresExpiry && state.openEndedLive > 0,
    `${where}: requires_expiry=true with ${String(state.openEndedLive)} open-ended live holding(s) ` +
      '— the forbidden state FAD-28 R5 refuses',
  ).toBe(false);
}

/**
 * A transaction that failed where the file expected it to WAIT.
 *
 * Recorded rather than thrown from inside a `.catch`, so the gated arms can
 * settle their deferreds first and report the real cause instead of timing out
 * twenty seconds later on an observation that was never going to happen.
 */
let unexpected: unknown;

/** `NO ERROR` for a settled transaction, the SQLSTATE (or service code) otherwise. */
function sqlstateOf(error: unknown): string {
  if (error === undefined || error === null) return 'NO ERROR';
  return String((error as { code?: string }).code ?? `no code: ${String(error)}`);
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 8 });

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

describe('the requires_expiry flip is serialized against an in-flight grant', () => {
  it('(A) GRANT FIRST: the flip BLOCKS on the grant, then refuses 23001', async () => {
    const qualification = await newQualification('order-a');

    const grantHoldsRow = deferred<void>();
    const grantGate = deferred<void>();
    const grantPid = deferred<number>();

    let grantSettled = false;
    const grant = staffingRun('a-grant', async (uow) => {
      grantPid.resolve(await backendPid(uow));
      await grantOpenEnded(uow, qualification.id);
      // The holding is inserted and NOT yet committed. This transaction holds
      // FOR KEY SHARE on the qualification row (migration 0017's guard) and the
      // per-organization audit advisory lock (0003).
      grantHoldsRow.resolve();
      await grantGate.promise;
    }).then(
      () => {
        grantSettled = true;
      },
      (error: unknown) => {
        /* An unexpected failure must not leave the file waiting on a gate that
         * will never open. The deferreds this transaction owns are settled and
         * the error is re-raised below rather than floating. */
        grantSettled = true;
        grantPid.resolve(0);
        grantHoldsRow.resolve();
        unexpected ??= error;
      },
    );
    await grantHoldsRow.promise;
    expect(unexpected, 'the grant failed before the interleaving could be built').toBeUndefined();

    const flipPid = deferred<number>();
    let flipError: unknown;
    const flip = staffingRun('a-flip', async (uow) => {
      flipPid.resolve(await backendPid(uow));
      await flipStatement(uow, qualification.id);
    }).catch((error: unknown) => {
      flipError = error;
    });

    /* The ordering proof: the flip is blocked on a ROW lock held by the GRANT's
     * backend. Without 0017 it would not block at all — FOR NO KEY UPDATE (which
     * is all an UPDATE of a non-key column takes) does not conflict with the
     * FOR KEY SHARE the holding's foreign key holds.
     *
     * The `finally` is not decoration. When the block does NOT happen — which is
     * exactly what the red-case violation produces — the wait above throws, and
     * without this the gated grant would stay open for ever, `pool.end()` would
     * never resolve, and a case that should FAIL would HANG instead. A
     * falsification arm has to fail fast to be worth anything. */
    let blocked;
    try {
      blocked = await waitUntilBlockedOnLock(admin, await flipPid.promise, {
        waitEvent: ['transactionid', 'tuple'],
        blockedBy: await grantPid.promise,
      });
      expect(
        grantSettled,
        'the grant committed before the flip was observed blocked — no interleaving occurred',
      ).toBe(false);
    } finally {
      grantGate.resolve();
      await grant;
      await flip;
    }

    expect(flipError, 'the flip was ADMITTED beside an in-flight open-ended grant').toBeDefined();
    expect(sqlstateOf(flipError)).toBe('23001');
    expect(String((flipError as { message?: string }).message)).toContain(
      'QUALIFICATION_REQUIRES_EXPIRY_CONFLICT',
    );

    const state = await finalState(qualification.id);
    expect(state.requiresExpiry, 'the flip must not have taken effect').toBe(false);
    expect(state.openEndedLive, 'the grant is the writer that won').toBe(1);
    expectInvariant(state, 'order A');
    log(
      `A: flip backend ${String(await flipPid.promise)} blocked on Lock/${String(blocked.waitEvent)} ` +
        `held by grant backend ${String(await grantPid.promise)}, then refused 23001`,
    );
  }, 120_000);

  it('(B) FLIP FIRST: the grant BLOCKS in the guard, then is refused 23001', async () => {
    /* No holding yet, so the flip is LEGAL and commits. What must not happen is
     * the open-ended grant sliding in beside it under a stale snapshot. */
    const qualification = await newQualification('order-b');

    const flipHoldsRow = deferred<void>();
    const flipGate = deferred<void>();
    const flipPid = deferred<number>();

    let flipSettled = false;
    const flip = staffingRun('b-flip', async (uow) => {
      flipPid.resolve(await backendPid(uow));
      await flipStatement(uow, qualification.id);
      // FOR UPDATE is held on the qualification row until this commits.
      flipHoldsRow.resolve();
      await flipGate.promise;
    }).then(
      () => {
        flipSettled = true;
      },
      (error: unknown) => {
        flipSettled = true;
        flipPid.resolve(0);
        flipHoldsRow.resolve();
        unexpected ??= error;
      },
    );
    await flipHoldsRow.promise;
    expect(unexpected, 'the flip failed before the interleaving could be built').toBeUndefined();

    const grantPid = deferred<number>();
    let grantError: unknown;
    const grant = staffingRun('b-grant', async (uow) => {
      grantPid.resolve(await backendPid(uow));
      /* The SERVICE lookup ahead of the insert reads this transaction's snapshot
       * and sees `requires_expiry = false`, so it does NOT refuse — which is
       * exactly why the database boundary has to. */
      return grantOpenEnded(uow, qualification.id);
    }).catch((error: unknown) => {
      grantError = error;
    });

    /* The `finally` again: a wait that throws must still release the gate, or a
     * failing arm becomes a hanging one (see (A)). */
    let blocked;
    try {
      blocked = await waitUntilBlockedOnLock(admin, await grantPid.promise, {
        waitEvent: ['transactionid', 'tuple'],
        blockedBy: await flipPid.promise,
      });
      expect(
        flipSettled,
        'the flip committed before the grant was observed blocked — no interleaving occurred',
      ).toBe(false);
    } finally {
      flipGate.resolve();
      await flip;
      await grant;
    }

    expect(grantError, 'the open-ended grant was ADMITTED beside an in-flight flip').toBeDefined();
    expect(sqlstateOf(grantError)).toBe('23001');
    expect(String((grantError as { message?: string }).message)).toContain(
      'QUALIFICATION_REQUIRES_EXPIRY',
    );

    const state = await finalState(qualification.id);
    expect(state.requiresExpiry, 'the flip is the writer that won').toBe(true);
    expect(state.openEndedLive, 'the refused grant must have left nothing behind').toBe(0);
    expectInvariant(state, 'order B');
    log(
      `B: grant backend ${String(await grantPid.promise)} blocked on Lock/${String(blocked.waitEvent)} ` +
        `held by flip backend ${String(await flipPid.promise)}, then refused 23001`,
    );
  }, 120_000);

  it('(C) CROSSED and UNGATED: every round settles bounded, exactly one writer wins', async () => {
    /* No gate, no observation, no sleep — the two transactions are launched at
     * once and the database decides. Six rounds, alternating which side is
     * launched first, so neither ordering is the only one measured.
     *
     * The bound is the deadlock claim in operational form: PostgreSQL's detector
     * fires after `deadlock_timeout` (1s by default) and would surface as 40P01,
     * which is asserted absent; a lock CYCLE that the detector somehow missed
     * would surface as this case exceeding its budget rather than as a green
     * run. */
    const ROUNDS = 6;
    const startedAt = Date.now();
    const outcomes: string[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const qualification = await newQualification(`crossed-${String(round)}`);
      const grantFirst = round % 2 === 0;

      let grantError: unknown;
      let flipError: unknown;
      const startGrant = () =>
        staffingRun(`c-grant-${String(round)}`, (uow) =>
          grantOpenEnded(uow, qualification.id),
        ).catch((error: unknown) => {
          grantError = error;
        });
      const startFlip = () =>
        staffingRun(`c-flip-${String(round)}`, (uow) =>
          flipStatement(uow, qualification.id),
        ).catch((error: unknown) => {
          flipError = error;
        });

      const pair = grantFirst
        ? [startGrant(), startFlip()]
        : [startFlip(), startGrant()];
      await Promise.all(pair);

      for (const error of [grantError, flipError]) {
        if (error === undefined) continue;
        expect(
          sqlstateOf(error),
          'a DEADLOCK was detected — the lock ordering in migration 0017 §3 does not hold',
        ).not.toBe('40P01');
        /* Two legitimate refusals, and which one appears depends only on how far
         * the loser got: `23001` from the guard, or the service's own
         * `QUALIFICATION_REQUIRES_EXPIRY` when the flip had already committed
         * before the grant's lookup ran. Anything else is a finding. */
        expect(['23001', 'QUALIFICATION_REQUIRES_EXPIRY']).toContain(sqlstateOf(error));
      }

      /* Exactly one writer wins. Both succeeding is the forbidden state; both
       * failing would mean neither wrote, which cannot happen — the loser is
       * refused BECAUSE the winner committed. */
      const winners = [grantError === undefined, flipError === undefined].filter((won) => won)
        .length;
      expect(winners, `round ${String(round)}: ${String(winners)} writers committed`).toBe(1);

      const state = await finalState(qualification.id);
      expectInvariant(state, `crossed round ${String(round)}`);
      outcomes.push(
        `${grantFirst ? 'grant-first' : 'flip-first'}:${grantError === undefined ? 'grant' : 'flip'}`,
      );
    }

    const elapsed = Date.now() - startedAt;
    expect(elapsed, 'the crossed rounds did not settle inside their bound').toBeLessThan(60_000);
    log(`C: ${String(ROUNDS)} crossed rounds in ${String(elapsed)}ms — ${outcomes.join(' ')}`);
  }, 180_000);

  it('(D) LOCK-ORDER INVERSION against the 0003 audit lock: pre-existing, bounded, never violating', async () => {
    /* ## The mandatory deadlock hunt (doc 35 §6c)
     *
     * Migration 0003 takes a per-organization advisory lock at every audit
     * insert and holds it to commit, so it is a lock nearly every writing
     * transaction ends up holding. Migration 0017 §3 records the ordering rule
     * that keeps it safe:
     *
     *     the qualification ROW lock is acquired BEFORE the audit advisory lock,
     *     in every shipped writer
     *
     * — and it holds because every staffing service writes its audit row LAST.
     * Case (C) is that rule in operation.
     *
     * This case measures what happens when the rule is BROKEN, because "no
     * shipped path inverts it" is a claim that deserves a measurement rather
     * than a paragraph. Two halves, and the first is the important one:
     *
     *   D1  the inversion using ONLY 0012 objects — two qualification UPDATEs,
     *       nothing from 0017. It deadlocks. The hazard is a property of the
     *       audit advisory lock and it predates this migration.
     *   D2  the same inversion routed through 0017's new edge (flip vs an
     *       in-flight grant). It behaves identically: a bounded 40P01 that
     *       aborts one transaction and commits nothing.
     *
     * In both halves the invariant survives, because a deadlock is a refusal:
     * PostgreSQL aborts one side and the other's work is the only work that
     * commits. */

    /* ── D1: the inversion WITHOUT migration 0017 ──────────────────────────── */
    const d1Target = await newQualification('inversion-pre-existing');

    const auditHeld = deferred<void>();
    const inverterPid = deferred<number>();
    const rowHeld = deferred<void>();
    const holderPid = deferred<number>();
    let inverterError: unknown;
    let holderError: unknown;

    // T1 takes the AUDIT lock first (a mutation of its own), then wants the row.
    const inverter = staffingRun('d1-inverter', async (uow) => {
      inverterPid.resolve(await backendPid(uow));
      await createQualification(uow, {
        key: `flip-serialization-d1-inverter-${String(Date.now())}`,
        name: 'D1 inverter',
      });
      auditHeld.resolve();
      await rowHeld.promise;
      // The inverted acquisition: audit lock already held, row lock wanted.
      await sql`update qualifications set status = 'retired' where id = ${d1Target.id}::uuid`.execute(
        uow.query,
      );
    }).catch((error: unknown) => {
      inverterError = error;
      inverterPid.resolve(0);
      auditHeld.resolve();
    });
    await auditHeld.promise;

    // T2 takes the ROW lock first, then wants the audit lock.
    const holder = staffingRun('d1-holder', async (uow) => {
      holderPid.resolve(await backendPid(uow));
      await sql`update qualifications set issuing_body = 'd1' where id = ${d1Target.id}::uuid`.execute(
        uow.query,
      );
      rowHeld.resolve();
      // Waits for the inverter to be blocked on this row, then asks for the
      // audit lock the inverter is holding: the cycle closes here.
      await waitUntilBlockedOnLock(admin, await inverterPid.promise, {
        blockedBy: await holderPid.promise,
      });
      await createQualification(uow, {
        key: `flip-serialization-d1-holder-${String(Date.now())}`,
        name: 'D1 holder',
      });
    }).catch((error: unknown) => {
      holderError = error;
      holderPid.resolve(0);
      rowHeld.resolve();
    });

    await Promise.all([inverter, holder]);
    const d1Codes = [sqlstateOf(inverterError), sqlstateOf(holderError)];
    log(`D1 (0012 objects only, no 0017): inverter=${d1Codes[0]} holder=${d1Codes[1]}`);
    expect(
      d1Codes.filter((code) => code === '40P01').length,
      'D1: the inversion did NOT deadlock — re-derive migration 0017 §3, the hazard analysis ' +
        'assumes this shape is pre-existing',
    ).toBe(1);
    expectInvariant(await finalState(d1Target.id), 'D1');

    /* ── D2: the same inversion through 0017's new edge ────────────────────── */
    const d2Target = await newQualification('inversion-0017-edge');

    const d2AuditHeld = deferred<void>();
    const d2FlipperPid = deferred<number>();
    const d2GrantPid = deferred<number>();
    let flipperError: unknown;
    let granterError: unknown;

    // T1: audit lock first (a mutation of its own), then the FLIP — the inverted
    // order 0017 §3 names as unreachable from any shipped path.
    const flipper = staffingRun('d2-flipper', async (uow) => {
      d2FlipperPid.resolve(await backendPid(uow));
      await createQualification(uow, {
        key: `flip-serialization-d2-flipper-${String(Date.now())}`,
        name: 'D2 flipper',
      });
      d2AuditHeld.resolve();
      // Wait until the grant holds FOR KEY SHARE and is queued behind the audit
      // lock this transaction is holding, so the cycle is closed deliberately.
      await waitUntilBlockedOnLock(admin, await d2GrantPid.promise, {
        waitEvent: 'advisory',
        blockedBy: await d2FlipperPid.promise,
      });
      await flipStatement(uow, d2Target.id);
    }).catch((error: unknown) => {
      flipperError = error;
      d2FlipperPid.resolve(0);
      d2AuditHeld.resolve();
    });
    await d2AuditHeld.promise;

    // T2: the ordinary shipped order — row lock, then audit lock.
    const granter = staffingRun('d2-grant', async (uow) => {
      d2GrantPid.resolve(await backendPid(uow));
      return grantOpenEnded(uow, d2Target.id);
    }).catch((error: unknown) => {
      granterError = error;
      d2GrantPid.resolve(0);
    });

    await Promise.all([flipper, granter]);
    const d2Codes = [sqlstateOf(flipperError), sqlstateOf(granterError)];
    log(`D2 (0017 edge, inverted order): flipper=${d2Codes[0]} granter=${d2Codes[1]}`);
    /* Whatever the detector chose, exactly one transaction was aborted and the
     * other's work is all that committed. The claim under test is NOT "no
     * deadlock is possible when the ordering rule is broken" — it is that the
     * outcome is bounded and the invariant survives it. */
    expect(
      d2Codes.filter((code) => code === '40P01').length,
      'D2: the inverted order did not produce the bounded refusal the analysis predicts',
    ).toBe(1);
    expectInvariant(await finalState(d2Target.id), 'D2');

    /* And nothing is wedged: a fresh, ordinary flip on an untouched
     * qualification still works after both deadlocks. */
    const after = await newQualification('inversion-aftermath');
    await staffingRun('d-aftermath', (uow) => flipStatement(uow, after.id));
    expect((await finalState(after.id)).requiresExpiry).toBe(true);
    /* And no backend was left inside a transaction by the aborts — a leaked
     * `idle in transaction` connection would hold locks for the rest of the run
     * and turn every later file into a mystery. */
    for (const pid of [await d2GrantPid.promise, await d2FlipperPid.promise]) {
      expect((await observeBackend(admin, pid))?.state).not.toBe('idle in transaction');
    }
  }, 180_000);
});
