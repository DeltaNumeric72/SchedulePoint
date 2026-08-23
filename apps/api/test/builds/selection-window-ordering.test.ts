/**
 * **The selection window, closed — doc 35 §6g ruling 4 held under concurrency.**
 *
 * This file is the permanent regression for REV-A-003, and it is REV-A's own
 * probe (`EV-REVIEW-A/transcripts/probe-sources/p3-selection-window.test.ts`)
 * kept as a proof rather than as a report: the probe recorded whichever outcome
 * it found; this file requires the one the ruling prescribes.
 *
 * ## The construction, unchanged from the finding
 *
 * `applyCandidateToNewDraft` evaluates staleness and then writes a draft.
 * `createDraftVersion` writes an audit event, and migration 0003's chain trigger
 * takes `pg_advisory_xact_lock(hashtext('schedulepoint.audit'), hashtext(<org>))`
 * — so a second same-organization transaction holding that lock makes the
 * selection block at a deterministic point, and it blocks it at whatever point
 * the selection first reaches the lock. REV-A showed that with the acquisition
 * sitting AFTER the staleness read, a transaction holding the lock could move a
 * build constituent, commit, and let the selection write a draft from a world
 * that no longer existed — `stale` for the same run one statement later.
 *
 * The repair moved the acquisition ahead of the staleness evaluation
 * (`src/builds/selection.ts`), so the arm below proves the ordering rather than
 * the window: the concurrent constituent change either commits BEFORE that
 * evaluation — and the selection refuses with the ruling's typed refusal — or it
 * cannot commit until the selection has.
 *
 * ## What each arm is for
 *
 *  * **CONTROL** — the identical flow with nothing moved reaches a new draft.
 *    Without it, the second arm proves only that something refuses; with it, the
 *    refusal is attributable to the concurrent change and a repair that refused
 *    everything would be caught here.
 *  * **THE WINDOW** — the finding's interleaving, with the block VERIFIED in
 *    `pg_locks` (a waiter on THIS organization's audit lock) and the constituent
 *    move asserted non-vacuous, so the arm cannot pass by never racing at all.
 *  * **ORDERING** — the review's own construction against the repair: a
 *    concurrent `schedule_periods` writer, which took the audit lock in the
 *    opposite order and made the first version of the repair deadlock (`40P01`).
 *    It is the proof that closing the window did not buy the closure with a
 *    lock-order inversion.
 *
 * Composed-run safe: it owns its tenant (`ownedMulti`), touches only rows minted
 * under that fixture, and leaves no state a later file reads — the shift type it
 * moves belongs to this file's own catalogue.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SolverInputSnapshotDocument } from '@schedulepoint/domain';

import { claimQueuedBuild } from '../../src/builds/claim.js';
import { BuildInputsMovedError } from '../../src/builds/errors.js';
import { persistOutcome, submitBuild } from '../../src/builds/runner.js';
import { applyCandidateToNewDraft } from '../../src/builds/selection.js';
import { buildStaleness } from '../../src/builds/staleness.js';
import {
  approveRun,
  createConfiguration,
  createRun,
  loadRun,
  markReviewed,
  readConfiguration,
  sourceDigestOf,
} from '../../src/builds/service.js';
import { transitionPeriodStatus } from '../../src/schedule/publication.js';
import { assembleCanonicalInput } from '../../src/solver/canonical-input.js';
import { createDraftVersion, createPeriod, setRequirement } from '../../src/schedule/service.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { scheduleActor } from '../support/schedule.js';
import { syntheticOutcome } from '../support/builds.js';

const multi = ownedMulti('r4-selection-window', {
  profile: 'core',
  seed: { catalogue: ['alpha'], schedule: true, scheduleCredentials: true },
});

let runtime: Runtime;
let second: Runtime;

let organizationId: string;
let groupId: string;
let membershipId: string;
let userId: string;
let shiftTypeId: string;

beforeAll(() => {
  runtime = createRuntime('app_runtime', { max: 6 });
  second = createRuntime('app_runtime', { max: 3 });
  const alpha = multi().alpha;
  organizationId = alpha.organizationId;
  groupId = alpha.groupOne.id;
  membershipId = alpha.users.scheduler.membershipId;
  userId = alpha.users.scheduler.id;
  const type = multi.catalogue('alpha').shiftTypeIds[1];
  if (type === undefined) throw new Error('the alpha catalogue seed produced no shift type');
  shiftTypeId = type;
}, 300_000);

afterAll(async () => {
  await runtime?.destroy();
  await second?.destroy();
});

const actor = (): ReturnType<typeof scheduleActor> => scheduleActor(userId);
const context = (
  label: string,
): { organizationId: string; groupId: string; membershipId: string; correlationId: string } => ({
  organizationId,
  groupId,
  membershipId,
  correlationId: `r4-window-${label}`,
});

/** A build driven all the way to `approved` with a USABLE candidate. */
async function buildToApproved(
  label: string,
  startDate: string,
  endDate: string,
): Promise<{ buildRunId: string; periodId: string }> {
  const seeded = await runtime.runner.run(context(label), async (uow) => {
    const periodId = await createPeriod(uow, actor(), {
      name: `R-4 selection window ${label}`,
      startDate,
      endDate,
    });
    await setRequirement(uow, actor(), { periodId, date: startDate, shiftTypeId, requiredCount: 1 });
    const versionId = await createDraftVersion(uow, actor(), periodId);
    const configurationId = await createConfiguration(uow, actor(), {
      periodId,
      name: `R-4 configuration ${label}`,
      maxTimeSeconds: 5,
      heartbeatTimeoutMs: 1000,
    });
    const created = await createRun(uow, actor(), {
      configurationId,
      sourceVersionId: versionId,
      candidateLabel: `r4-${label}`,
      idempotencyKey: `r4.${label}.${randomUUID()}`,
    });
    return { periodId, versionId, configurationId, buildRunId: created.buildRunId };
  });

  const document = await runtime.runner.run(context(label), async (uow) => {
    const assembled = await assembleCanonicalInput(uow, {
      periodId: seeded.periodId,
      versionId: seeded.versionId,
      at: new Date(`${startDate}T12:00:00.000Z`),
    });
    return assembled.document;
  });

  /* The PRODUCTION submission path — it is what assembles and PINS the canonical
     input snapshot; the bare transitions do not. */
  const submitted = await submitBuild(
    runtime.runner,
    context(label),
    actor(),
    seeded.buildRunId,
    'draft_configuration',
  );
  expect(submitted.state, `${label}: the fixture did not queue`).toBe('queued');

  await runtime.runner.run(context(label), async (uow) => {
    const claim = await claimQueuedBuild(uow, seeded.buildRunId, `r4.${process.pid}.${label}`);
    if (claim === null) throw new Error('could not claim');
    const configuration = await readConfiguration(uow, seeded.configurationId);
    if (configuration === null) throw new Error('configuration vanished');
    await persistOutcome(uow, {
      buildRunId: seeded.buildRunId,
      claimEpoch: claim.claimEpoch,
      document: document as SolverInputSnapshotDocument,
      outcome: syntheticOutcome(
        claim.run.canonical_input_hash ?? 'f'.repeat(64),
        membershipId,
        startDate,
        shiftTypeId,
      ),
      verdict: { usable: true, rejections: [], findings: [], hardViolations: 0 },
      configuration,
    });
  });

  await runtime.runner.run(context(label), async (uow) => {
    const row = await loadRun(uow, seeded.buildRunId);
    if (row === null) throw new Error('run vanished');
    await markReviewed(uow, actor(), seeded.buildRunId, row.state);
    await approveRun(uow, actor(), seeded.buildRunId, 'reviewed');
  });

  const approved = await runtime.runner.run(context(label), async (uow) =>
    loadRun(uow, seeded.buildRunId),
  );
  expect(approved?.state, `${label}: the fixture did not reach approved`).toBe('approved');
  return { buildRunId: seeded.buildRunId, periodId: seeded.periodId };
}

async function stalenessOf(
  buildRunId: string,
  label: string,
): Promise<{ stale: boolean; kinds: string[] }> {
  return runtime.runner.run(context(label), async (uow) => {
    const row = await loadRun(uow, buildRunId);
    if (row === null) throw new Error('run vanished');
    const verdict = await buildStaleness(uow, row);
    return {
      stale: verdict.stale,
      kinds: [...new Set(verdict.changes.map((change) => change.kind))],
    };
  });
}

async function digestOf(buildRunId: string, label: string): Promise<string> {
  return runtime.runner.run(context(label), async (uow) => {
    const row = await loadRun(uow, buildRunId);
    if (row === null) throw new Error('run vanished');
    return sourceDigestOf(uow, row);
  });
}

async function versionCount(periodId: string, label: string): Promise<number> {
  return runtime.runner.run(context(label), async (uow) => {
    const rows = await uow.query
      .selectFrom('schedule_versions')
      .select('id')
      .where('period_id', '=', periodId)
      .execute();
    return rows.length;
  });
}

/**
 * How many backends are WAITING on this organization's audit advisory lock.
 *
 * Read from `pg_locks` on the exact key migration 0003's chain trigger takes,
 * rather than from a global count of lock waiters: a composed run has a worker
 * and other pools alive, and "somebody, somewhere, is waiting on a lock" would
 * make the arm pass without the interleaving it claims to construct.
 */
async function auditLockWaiters(label: string): Promise<number> {
  return runtime.runner.run(context(label), async ({ query }) => {
    const rows = await sql<{ n: string }>`
      select count(*)::text as n
        from pg_locks
       where locktype = 'advisory'
         and not granted
         and classid = hashtext('schedulepoint.audit')::oid
         and objid = hashtext(${organizationId}::uuid::text)::oid
    `.execute(query);
    return Number(rows.rows[0]?.n ?? '0');
  });
}

/**
 * How many backends are blocked on a ROW lock, anywhere in the cluster.
 *
 * Deliberately not narrowed to a tuple: a waiter on a row lock waits on the
 * HOLDER'S transaction id, and the arm below only needs to know that its second
 * writer has stopped moving — which of the two shapes it stopped in (the period
 * row, before the repair the audit lock) is the thing under test, not a
 * precondition of it.
 */
async function rowLockWaiters(label: string): Promise<number> {
  return runtime.runner.run(context(label), async ({ query }) => {
    const rows = await sql<{ n: string }>`
      select count(*)::text as n
        from pg_locks
       where not granted
         and locktype in ('transactionid', 'tuple')
    `.execute(query);
    return Number(rows.rows[0]?.n ?? '0');
  });
}

/** Wait until a backend is blocked on the audit lock, or fail saying it never was. */
async function awaitAuditLockWaiter(label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if ((await auditLockWaiters(label)) > 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        'the selection never blocked on this organization\'s audit advisory lock — ' +
          'the interleaving this test exists to construct did not happen',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('REV-A-003 — the selection window is closed by the audit ordering', () => {
  it('CONTROL: with nothing moved, the identical flow reaches a new draft', async () => {
    const { buildRunId } = await buildToApproved('control', '2030-02-04', '2030-02-17');
    const before = await stalenessOf(buildRunId, 'control-before');
    expect(before.stale, 'the control fixture was already stale').toBe(false);

    const digest = await digestOf(buildRunId, 'control');
    const applied = await runtime.runner.run(context('control'), async (uow) =>
      applyCandidateToNewDraft(uow, actor(), buildRunId, 'approved', digest),
    );

    expect(applied.draftVersionId).toBeTruthy();
    /* Non-vacuous: a selection that wrote no rows would satisfy "it applied"
     * while proving nothing about the path this file guards. */
    expect(applied.assignmentsWritten).toBeGreaterThan(0);

    const state = await runtime.runner.run(context('control'), async (uow) =>
      loadRun(uow, buildRunId),
    );
    expect(state?.state).toBe('applied_to_draft_schedule');
    expect(state?.applied_to_version_id).toBe(applied.draftVersionId);
  }, 300_000);

  it('THE WINDOW: an input that moves under the audit lock is REFUSED, not applied', async () => {
    const { buildRunId, periodId } = await buildToApproved('window', '2030-03-04', '2030-03-17');
    const before = await stalenessOf(buildRunId, 'window-before');
    expect(before.stale, 'the fixture was already stale before the race').toBe(false);

    const digest = await digestOf(buildRunId, 'window');
    const versionsBefore = await versionCount(periodId, 'window');

    /* ── T2: hold this organization's audit advisory lock ───────────────────── */
    let holderHasLock: (() => void) | undefined;
    const lockHeld = new Promise<void>((resolve) => {
      holderHasLock = resolve;
    });
    let releaseHolder: (() => void) | undefined;
    const mayRelease = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holder = second.runner.run(context('holder'), async ({ query }) => {
      await sql`select pg_advisory_xact_lock(hashtext('schedulepoint.audit'), hashtext(${organizationId}::uuid::text))`.execute(
        query,
      );
      holderHasLock?.();
      await mayRelease;
      /* Move a REAL build constituent in this same transaction, so it commits
       * when the lock is released — the M-11 `shiftType` class, moved exactly as
       * the shipped matrix moves it. */
      const moved = await sql`
        update shift_types set updated_at = now()
         where organization_id = ${organizationId}::uuid and id = ${shiftTypeId}::uuid
      `.execute(query);
      return Number(moved.numAffectedRows ?? 0n);
    });

    let movedRows = 0;
    let outcome = 'PENDING';
    let draftVersionId: string | null = null;
    let refusal: unknown = null;

    try {
      await lockHeld;

      /* ── T1: the selection. It blocks on T2's lock. ───────────────────────── */
      const selection = runtime.runner
        .run(context('window'), async (uow) =>
          applyCandidateToNewDraft(uow, actor(), buildRunId, 'approved', digest),
        )
        .then((result) => {
          outcome = 'APPLIED';
          draftVersionId = result.draftVersionId;
          return result;
        })
        .catch((error: unknown) => {
          outcome = 'REFUSED';
          refusal = error;
          return null;
        });

      /* VERIFIED, not assumed: a backend is waiting on THIS organization's audit
       * lock while T2 holds it. */
      await awaitAuditLockWaiter('observe');
      expect(outcome, 'the selection completed before the constituent moved').toBe('PENDING');

      releaseHolder?.();
      movedRows = await holder;
      await selection;
    } finally {
      releaseHolder?.();
      await holder.catch(() => 0);
    }

    expect(movedRows, 'the construction moved no constituent — the arm would be vacuous').toBe(1);

    /* ── doc 35 §6g ruling 4, in its own words ──────────────────────────────
     *
     * "a build whose ANY input revision changed after snapshot assembly is
     *  visibly STALE and can NEVER silently become the current draft — selection
     *  refuses stale with a typed reason".
     *
     * So the assertion is the REFUSAL and its reason, not merely the absence of
     * an application: a selection that failed for any other cause would satisfy
     * "it did not apply" while leaving the ruling unproven. */
    expect(outcome, `the selection applied a stale build (draft ${String(draftVersionId)})`).toBe(
      'REFUSED',
    );
    expect(refusal).toBeInstanceOf(BuildInputsMovedError);
    const moved = refusal as BuildInputsMovedError;
    expect(moved.code).toBe('STALE_BUILD_INPUTS');
    expect(moved.staleness.stale).toBe(true);
    expect(moved.staleness.changes.map((change) => change.kind)).toContain('shiftType');

    /* Never silently current: no draft, no application, the run still approved. */
    const state = await runtime.runner.run(context('window'), async (uow) =>
      loadRun(uow, buildRunId),
    );
    expect(state?.state).toBe('approved');
    expect(state?.applied_to_version_id).toBeNull();
    expect(await versionCount(periodId, 'window')).toBe(versionsBefore);

    /* And the condition the refusal named is the one the run reads afterwards. */
    const after = await stalenessOf(buildRunId, 'window-after');
    expect(after.stale).toBe(true);
    expect(after.kinds).toContain('shiftType');
  }, 300_000);

  /**
   * **The price of moving the acquisition, and the proof it is paid.**
   *
   * Taking the audit advisory lock before the draft write means holding it while
   * `createDraftVersion`'s insert takes `FOR KEY SHARE` on this period through
   * the composite foreign key. Two shipped writers take that same period row
   * `FOR UPDATE` and audit AFTERWARDS — `transitionPeriodStatus` and
   * `publishVersion` — so an audit-lock-first selection and a period writer form
   * a cycle, and the independent review REPRODUCED it as `40P01` on the first
   * version of this repair.
   *
   * The remedy is one statement — the period row locked in the FK's own mode
   * before the advisory lock, restoring migration 0017 §3's row-then-audit order
   * — and this arm is the reviewer's construction kept as its permanent proof.
   */
  it('ORDERING: a concurrent period writer does not deadlock the selection', async () => {
    const { buildRunId, periodId } = await buildToApproved('order', '2030-04-08', '2030-04-21');
    const digest = await digestOf(buildRunId, 'order');

    let holderHasLock: (() => void) | undefined;
    const lockHeld = new Promise<void>((resolve) => {
      holderHasLock = resolve;
    });
    let releaseHolder: (() => void) | undefined;
    const mayRelease = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    /* T0 — holds the organization's audit lock and nothing else, so that T1 has
     * to stop exactly at its acquisition point and T2 can get in front of it. */
    const holder = second.runner.run(context('order-holder'), async ({ query }) => {
      await sql`select pg_advisory_xact_lock(hashtext('schedulepoint.audit'), hashtext(${organizationId}::uuid::text))`.execute(
        query,
      );
      holderHasLock?.();
      await mayRelease;
      return 'released';
    });

    let selectionError: unknown = null;
    let periodError: unknown = null;
    let bothBlocked = false;

    try {
      await lockHeld;

      /* T1 — the selection, which will block at the audit lock. */
      const selection = runtime.runner
        .run(context('order'), async (uow) =>
          applyCandidateToNewDraft(uow, actor(), buildRunId, 'approved', digest),
        )
        .catch((error: unknown) => {
          selectionError = error;
          return null;
        });

      await awaitAuditLockWaiter('order-observe');

      /* T2 — the period writer: `schedule_periods … FOR UPDATE`, then an audit
       * write. This is the transaction the cycle needs. */
      const periodWriter = runtime.runner
        .run(context('order-period'), async (uow) =>
          transitionPeriodStatus(uow, actor(), periodId, 'closed'),
        )
        .catch((error: unknown) => {
          periodError = error;
          return null;
        });

      /* Wait until T2 has ALSO stopped — on the period row (repaired: T1 already
       * holds it in KEY SHARE) or on the audit lock itself (the pre-repair shape,
       * two advisory waiters). Either way both writers are in flight before T0
       * lets go, which is what makes the cycle possible at all. */
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const advisory = await auditLockWaiters('order-observe');
        const rows = await rowLockWaiters('order-observe');
        if (advisory >= 2 || (advisory >= 1 && rows >= 1)) {
          bothBlocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      releaseHolder?.();
      await holder;
      await Promise.all([selection, periodWriter]);
    } finally {
      releaseHolder?.();
      await holder.catch(() => 'released');
    }

    /* Non-vacuous: if the second writer never blocked, nothing was ordered and a
     * green result would mean only that two transactions ran one after another. */
    expect(bothBlocked, 'the second writer never blocked — no ordering was exercised').toBe(true);

    /* The assertion: NEITHER transaction was chosen as a deadlock victim. 40P01
     * is asserted by code and not only by "no error", because a deadlock that
     * arrived as some other failure would otherwise pass quietly. */
    const codeOf = (error: unknown): string | undefined =>
      (error as { code?: string } | null)?.code;
    expect(codeOf(selectionError), 'the selection was a deadlock victim').not.toBe('40P01');
    expect(codeOf(periodError), 'the period writer was a deadlock victim').not.toBe('40P01');
    expect(selectionError, 'the selection failed').toBeNull();
    expect(periodError, 'the period transition failed').toBeNull();

    /* Both did their work: the candidate is a draft, and the period is closed. */
    const state = await runtime.runner.run(context('order'), async (uow) =>
      loadRun(uow, buildRunId),
    );
    expect(state?.state).toBe('applied_to_draft_schedule');
    expect(state?.applied_to_version_id).not.toBeNull();

    const status = await runtime.runner.run(context('order'), async (uow) =>
      uow.query
        .selectFrom('schedule_periods')
        .select('status')
        .where('id', '=', periodId)
        .executeTakeFirst(),
    );
    expect(status?.status).toBe('closed');
  }, 300_000);
});
