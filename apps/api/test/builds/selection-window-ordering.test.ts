/**
 * **The selection window, closed — doc 35 §6g ruling 4 held under concurrency.**
 *
 * This file is the permanent regression for REV-A-003, and it is REV-A's own
 * probe `p3-selection-window` — committed on the review branch `review/rev-a`,
 * under `docs/evidence/EV-REVIEW-A/transcripts/probe-sources/`, and NOT present
 * in this tree — kept as a proof rather than as a report: the probe recorded
 * whichever outcome it found; this file requires the one the ruling prescribes.
 *
 * (The provenance is unchanged; only its SPELLING is. The original wording put
 * the probe's full filename in the sentence, and `transcripts/` ends in the
 * literal `scripts/`, so the full-path sweep in
 * `citation-integrity.test.ts` read the tail as a citable path here and
 * correctly reported that nothing is there. It was invisible while this file was
 * untracked — the sweep enumerates `git ls-files` — and went red the moment the
 * file was committed. The REV-B-005 / R-9 class, in a test docblock.)
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
 *  * **THE SOURCE WINDOW** — R4-REV-2, the mirror the R-4 reviewer demonstrated:
 *    the same interleaving with an ordinary audited edit of the SOURCE DRAFT,
 *    which moves the material-input digest and no 0016 constituent. R-4 brought
 *    the staleness verdict inside the ordering domain and left FAD-26(2)'s
 *    compare-and-set outside it, so the selection APPLIED over an edit it never
 *    saw. This arm requires `STALE_BUILD_SOURCE` — the existing refusal, not a
 *    new kind — and it is the one that makes the two arms a pair rather than a
 *    single closed case beside an open one.
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
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SolverInputSnapshotDocument } from '@schedulepoint/domain';

import { claimQueuedBuild } from '../../src/builds/claim.js';
import { BuildInputsMovedError, BuildSourceMovedError } from '../../src/builds/errors.js';
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
import {
  addManualAssignment,
  createDraftVersion,
  createPeriod,
  setRequirement,
} from '../../src/schedule/service.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { waitUntilBlockedOnLock } from '../profiles/lock-observation.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant, scheduleActor } from '../support/schedule.js';
import { syntheticOutcome } from '../support/builds.js';

const multi = ownedMulti('r4-selection-window', {
  profile: 'core',
  seed: { catalogue: ['alpha'], schedule: true, scheduleCredentials: true },
});

let runtime: Runtime;
let second: Runtime;
/** Harness OBSERVATION only — see `../support/admin-client.ts`. */
let admin: pg.Client;

let organizationId: string;
let groupId: string;
let membershipId: string;
let userId: string;
let shiftTypeId: string;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
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
  await admin?.end();
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
): Promise<{ buildRunId: string; periodId: string; sourceVersionId: string }> {
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
  return {
    buildRunId: seeded.buildRunId,
    periodId: seeded.periodId,
    sourceVersionId: seeded.versionId,
  };
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
 * This backend's pid, read inside the caller's own transaction.
 *
 * The ORDERING arm needs it to name its two writers to `waitUntilBlockedOnLock`
 * — see the arm for why naming them is the difference between a proof and a
 * coincidence (R4-REV-2 note N-1).
 */
async function backendPid(uow: PgUnitOfWork): Promise<number> {
  const row = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(uow.query);
  return row.rows[0]?.pid ?? 0;
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
   * **THE SOURCE WINDOW — R4-REV-2, the mirror of REV-A-003.**
   *
   * R-4 brought the STALENESS verdict inside the ordering domain. It left the
   * OTHER precondition — FAD-26(2)'s source-digest compare-and-set — outside it,
   * and the reviewer's construction below shows that the same window the arm
   * above closes was still open one check to its left.
   *
   * The mover here is not a catalogue edit. It is an ordinary audited edit of
   * the SOURCE DRAFT — `addManualAssignment`, the cell editor's own writer —
   * which moves the material-input digest and moves NO 0016 constituent. So the
   * staleness verdict this build reads is honestly `fresh`, and before the
   * repair the pre-lock CAS had already compared a digest read one statement
   * before the edit committed: the selection applied, and the docblock promise
   * in `src/builds/selection.ts` item 4 — "not a schedule that quietly
   * discarded somebody's work" — was false as worded.
   *
   * The repair re-evaluates the CAS under the two locks. A source mover audits,
   * so it holds the organization's audit lock until it commits: it either
   * commits before the grant, and the re-read sees it, or it is ordered after
   * this transaction. The refusal is the EXISTING vocabulary — the same
   * `BuildSourceMovedError` / `STALE_BUILD_SOURCE` the pre-lock CAS raises — and
   * this arm requires exactly that and not a new kind.
   */
  it('THE SOURCE WINDOW: a source draft that moves under the audit lock is REFUSED, not applied', async () => {
    const { buildRunId, periodId, sourceVersionId } = await buildToApproved(
      'source',
      '2030-05-06',
      '2030-05-19',
    );
    const before = await stalenessOf(buildRunId, 'source-before');
    expect(before.stale, 'the fixture was already stale before the race').toBe(false);

    const digest = await digestOf(buildRunId, 'source');
    const versionsBefore = await versionCount(periodId, 'source');

    /* ── T2: hold this organization's audit advisory lock ───────────────────── */
    let holderHasLock: (() => void) | undefined;
    const lockHeld = new Promise<void>((resolve) => {
      holderHasLock = resolve;
    });
    let releaseHolder: (() => void) | undefined;
    const mayRelease = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holder = second.runner.run(context('source-holder'), async (uow) => {
      await sql`select pg_advisory_xact_lock(hashtext('schedulepoint.audit'), hashtext(${organizationId}::uuid::text))`.execute(
        uow.query,
      );
      holderHasLock?.();
      await mayRelease;
      /* An ordinary audited edit of the SOURCE draft, in this same transaction,
       * so it commits when the lock is released. It moves the material-input
       * digest (`assignment_snapshots` is its first class) and no constituent —
       * which is what makes this the MIRROR of the arm above rather than a
       * second spelling of it. */
      const added = await addManualAssignment(uow, actor(), {
        versionId: sourceVersionId,
        membershipId,
        shiftTypeId,
        date: '2030-05-06',
        startsAt: fixtureInstant('2030-05-06', 8),
        endsAt: fixtureInstant('2030-05-06', 16),
      });
      return added.assignmentIdentityId;
    });

    let addedIdentity: string | null = null;
    let outcome = 'PENDING';
    let draftVersionId: string | null = null;
    let refusal: unknown = null;

    try {
      await lockHeld;

      /* ── T1: the selection. It blocks on T2's lock. ───────────────────────── */
      const selection = runtime.runner
        .run(context('source'), async (uow) =>
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
       * lock while T2 holds it. Before the repair the selection had already
       * compared the digest by the time it got here — which is the finding. */
      await awaitAuditLockWaiter('source-observe');
      expect(outcome, 'the selection completed before the source draft moved').toBe('PENDING');

      releaseHolder?.();
      addedIdentity = await holder;
      await selection;
    } finally {
      releaseHolder?.();
      await holder.catch(() => null);
    }

    expect(
      addedIdentity,
      'the construction added no assignment to the source draft — the arm would be vacuous',
    ).toBeTruthy();

    /* Non-vacuous in the term the CAS actually compares: the digest MOVED. */
    const digestAfter = await digestOf(buildRunId, 'source-after');
    expect(digestAfter, 'the source edit did not move the digest').not.toBe(digest);

    /* And it moved NOTHING the staleness verdict reads, so this arm cannot be
     * satisfied by the constituent ordering the arm above proves. */
    const after = await stalenessOf(buildRunId, 'source-after');
    expect(after.stale, 'the source edit moved a constituent — this is not the mirror').toBe(false);

    expect(outcome, `the selection applied over a moved source (draft ${String(draftVersionId)})`).toBe(
      'REFUSED',
    );
    expect(refusal).toBeInstanceOf(BuildSourceMovedError);
    const moved = refusal as BuildSourceMovedError;
    expect(moved.code).toBe('STALE_BUILD_SOURCE');
    expect(moved.currentSourceDigest).toBe(digestAfter);

    /* Nobody's work was discarded: no draft, no application, the run still approved. */
    const state = await runtime.runner.run(context('source'), async (uow) =>
      loadRun(uow, buildRunId),
    );
    expect(state?.state).toBe('approved');
    expect(state?.applied_to_version_id).toBeNull();
    expect(await versionCount(periodId, 'source')).toBe(versionsBefore);
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

    /* The two writers' backend pids, resolved from INSIDE their own
     * transactions. `waitUntilBlockedOnLock` checks `pg_blocking_pids()` against
     * a named backend, and a pid read anywhere else would be a different
     * connection (R4-REV-2 note N-1). */
    let announceSelectionPid: ((pid: number) => void) | undefined;
    const selectionPid = new Promise<number>((resolve) => {
      announceSelectionPid = resolve;
    });
    let announcePeriodPid: ((pid: number) => void) | undefined;
    const periodPid = new Promise<number>((resolve) => {
      announcePeriodPid = resolve;
    });

    const inFlight: Promise<unknown>[] = [];

    try {
      await lockHeld;

      /* T1 — the selection, which will block at the audit lock. */
      const selection = runtime.runner
        .run(context('order'), async (uow) => {
          announceSelectionPid?.(await backendPid(uow));
          return applyCandidateToNewDraft(uow, actor(), buildRunId, 'approved', digest);
        })
        .catch((error: unknown) => {
          selectionError = error;
          announceSelectionPid?.(0);
          return null;
        });
      inFlight.push(selection);

      await awaitAuditLockWaiter('order-observe');

      /* T2 — the period writer: `schedule_periods … FOR UPDATE`, then an audit
       * write. This is the transaction the cycle needs. */
      const periodWriter = runtime.runner
        .run(context('order-period'), async (uow) => {
          announcePeriodPid?.(await backendPid(uow));
          return transitionPeriodStatus(uow, actor(), periodId, 'closed');
        })
        .catch((error: unknown) => {
          periodError = error;
          announcePeriodPid?.(0);
          return null;
        });
      inFlight.push(periodWriter);

      /* Wait until T2 has ALSO stopped, and stopped BEHIND T1 — one named
       * backend blocked by the other, checked through `pg_blocking_pids()`.
       *
       * The first version of this arm counted ungranted `('transactionid',
       * 'tuple')` locks across the WHOLE cluster, which the R-4 review filed as
       * N-1: a composed run has a worker pool and other fixtures alive, so an
       * unrelated backend queued on an unrelated row satisfied the flag and the
       * arm could report "both blocked" without T2 ever having stopped. The
       * in-repo observer names the backends instead, and it is the same one
       * arm D of `requires-expiry-flip-serialization.test.ts` uses for exactly
       * this — a deliberate cycle whose second edge has to be VERIFIED before
       * the holder lets go.
       *
       * `blockedBy` and no `waitEvent`, deliberately: WHICH lock T2 stops on is
       * the thing under test (the period row after the repair; the advisory lock
       * before it, with T1 ahead of it in the queue), not a precondition of the
       * arm — so constraining the event here would make the red case fail as an
       * observation error instead of as the `40P01` it exists to show. */
      await waitUntilBlockedOnLock(admin, await periodPid, {
        blockedBy: await selectionPid,
        budgetMs: 30_000,
      });
      bothBlocked = true;

      releaseHolder?.();
      await holder;
      await Promise.all([selection, periodWriter]);
    } finally {
      releaseHolder?.();
      await holder.catch(() => 'released');
      await Promise.allSettled(inFlight);
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
