/**
 * REV-A PROBE 3 — TEMPORARY. Applied, measured, and REMOVED. Not a shipped test.
 *
 * **doc 36 §10 limitation 4, attacked directly.** The M4 exit report records:
 *
 *   > "The un-falsified selection window — `applyCandidateToNewDraft` reads
 *   >  staleness and writes the draft in one READ COMMITTED transaction without
 *   >  ordering locks; **the reviewer could not construct the interleaving and did
 *   >  not assert it reachable**; recorded as an admitted, undemonstrated
 *   >  limitation."
 *
 * This probe tries to construct it, deterministically rather than by racing.
 *
 * ## The construction
 *
 * Inside `applyCandidateToNewDraft` the order is: load the run FOR UPDATE →
 * source-digest CAS → `buildStaleness` → read the snapshot → read the candidate →
 * `createDraftVersion`. `createDraftVersion` calls `recordAuditEvent`, and
 * migration 0003's chain trigger takes
 * `pg_advisory_xact_lock(hashtext('schedulepoint.audit'), hashtext(<organization>))`.
 *
 * That lock is a deterministic hook AFTER the staleness read and BEFORE the write.
 * A second transaction that already holds it makes the selection block at exactly
 * the right point; that transaction then moves a real build input and commits,
 * releasing the lock, and the selection proceeds to write a draft from a world
 * that no longer exists.
 *
 * Both outcomes are recorded honestly. If the selection REFUSES, the limitation is
 * narrower than recorded and that is the finding; if it SUCCEEDS while the same
 * run reads `stale` immediately afterwards, the limitation is real and reachable.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SolverInputSnapshotDocument } from '@schedulepoint/domain';

import { claimQueuedBuild } from '../../src/builds/claim.js';
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
  transitionRun,
} from '../../src/builds/service.js';
import { assembleCanonicalInput } from '../../src/solver/canonical-input.js';
import { createDraftVersion, createPeriod, setRequirement } from '../../src/schedule/service.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { scheduleActor } from '../support/schedule.js';
import { syntheticOutcome } from '../support/builds.js';

const multi = ownedMulti('rev-a-p3', {
  profile: 'core',
  seed: { catalogue: ['alpha'], schedule: true, scheduleCredentials: true },
});

let runtime: Runtime;
let second: Runtime;
const log = (...p: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.log(...p);
};

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
  shiftTypeId = multi().catalogue?.alpha.shiftTypeIds[1] as string;
}, 300_000);

afterAll(async () => {
  await runtime?.destroy();
  await second?.destroy();
});

const actor = (): ReturnType<typeof scheduleActor> => scheduleActor(userId);
const context = (label: string): {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
} => ({ organizationId, groupId, membershipId, correlationId: `rev-a-p3-${label}` });

/** A build driven all the way to `approved` with a USABLE candidate. */
async function buildToApproved(label: string, startDate: string, endDate: string): Promise<string> {
  const seeded = await runtime.runner.run(context(label), async (uow) => {
    const periodId = await createPeriod(uow, actor(), {
      name: `REV-A selection window ${label}`,
      startDate,
      endDate,
    });
    await setRequirement(uow, actor(), { periodId, date: startDate, shiftTypeId, requiredCount: 1 });
    const versionId = await createDraftVersion(uow, actor(), periodId);
    const configurationId = await createConfiguration(uow, actor(), {
      periodId,
      name: `REV-A configuration ${label}`,
      maxTimeSeconds: 5,
      heartbeatTimeoutMs: 1000,
    });
    const created = await createRun(uow, actor(), {
      configurationId,
      sourceVersionId: versionId,
      candidateLabel: `rev-a-${label}`,
      idempotencyKey: `rev-a.${label}.${randomUUID()}`,
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
     input snapshot; the three bare transitions do not. */
  const submitted = await submitBuild(
    runtime.runner,
    context(label),
    actor(),
    seeded.buildRunId,
    'draft_configuration',
  );
  expect(submitted.state, `${label}: the fixture did not queue`).toBe('queued');

  await runtime.runner.run(context(label), async (uow) => {
    const claim = await claimQueuedBuild(uow, seeded.buildRunId, `rev-a.${process.pid}.${label}`);
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
      /* USABLE, with no findings — the DB validation gate requires both before
       * `reviewed -> approved` is permitted at all. */
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
  return seeded.buildRunId;
}

async function stalenessOf(buildRunId: string, label: string): Promise<{ stale: boolean; kinds: string[] }> {
  return runtime.runner.run(context(label), async (uow) => {
    const row = await loadRun(uow, buildRunId);
    if (row === null) throw new Error('run vanished');
    const s = await buildStaleness(uow, row);
    return {
      stale: s.stale,
      kinds: [...new Set((s.changes ?? []).map((c: { kind: string }) => c.kind))],
    };
  });
}

describe('REV-A/W — doc 36 §10.4: the un-falsified selection window', () => {
  it('CONTROL: with nothing moved, the identical flow reaches a new draft', async () => {
    const buildRunId = await buildToApproved('control', '2030-02-04', '2030-02-17');
    const before = await stalenessOf(buildRunId, 'control-before');
    expect(before.stale, 'the control fixture was already stale').toBe(false);

    const digest = await runtime.runner.run(context('control'), async (uow) => {
      const row = await loadRun(uow, buildRunId);
      if (row === null) throw new Error('run vanished');
      return sourceDigestOf(uow, row);
    });
    const applied = await runtime.runner.run(context('control'), async (uow) =>
      applyCandidateToNewDraft(uow, actor(), buildRunId, 'approved', digest),
    );
    log('[REV-A/W] CONTROL applied ->', applied.draftVersionId, 'assignments', applied.assignmentsWritten);
    expect(applied.draftVersionId).toBeTruthy();
  }, 300_000);

  it('THE WINDOW: an input moves AFTER the staleness read and BEFORE the write', async () => {
    const buildRunId = await buildToApproved('window', '2030-03-04', '2030-03-17');
    const before = await stalenessOf(buildRunId, 'window-before');
    log('[REV-A/W] staleness before the race:', JSON.stringify(before));
    expect(before.stale).toBe(false);

    const digest = await runtime.runner.run(context('window'), async (uow) => {
      const row = await loadRun(uow, buildRunId);
      if (row === null) throw new Error('run vanished');
      return sourceDigestOf(uow, row);
    });

    /* ── T2: hold the per-organization audit advisory lock ──────────────────── */
    let holderHasLock: (() => void) | undefined;
    const lockHeld = new Promise<void>((resolve) => {
      holderHasLock = resolve;
    });
    let releaseHolder: (() => void) | undefined;
    const mayRelease = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holder = second.runner.run(context('holder'), async ({ query }) => {
      await sql`select pg_advisory_xact_lock(hashtext('schedulepoint.audit'), hashtext(${organizationId}::text))`.execute(
        query,
      );
      holderHasLock?.();
      await mayRelease;
      /* Move a REAL build input, in this same transaction, so it commits when the
       * lock is released. This is the M-10 `rule` class, edited exactly as the
       * shipped matrix edits it (the M-11 shiftType class). */
      const moved = await sql`
        update shift_types set updated_at = now()
         where organization_id = ${organizationId}::uuid and id = ${shiftTypeId}::uuid
      `.execute(query);
      return Number(moved.numAffectedRows ?? 0n);
    });

    await lockHeld;
    log('[REV-A/W] T2 holds the audit advisory lock for this organization');

    /* ── T1: the selection. It will pass staleness, then block in
     *        createDraftVersion -> recordAuditEvent on T2's lock. ───────────── */
    let selectionOutcome = 'PENDING';
    let draftVersionId: string | null = null;
    const selection = runtime.runner
      .run(context('window'), async (uow) =>
        applyCandidateToNewDraft(uow, actor(), buildRunId, 'approved', digest),
      )
      .then((r) => {
        selectionOutcome = 'APPLIED';
        draftVersionId = r.draftVersionId;
        return r;
      })
      .catch((e: Error) => {
        selectionOutcome = `REFUSED: ${e.constructor.name} ${e.message.slice(0, 80)}`;
        return null;
      });

    /* Give T1 time to reach the lock. It is blocked in the database, so this is a
     * wait for a state we then VERIFY rather than a hope. */
    await new Promise((r) => setTimeout(r, 2500));
    const blocked = await runtime.runner.run(context('observe'), async ({ query }) => {
      const rows = await sql<{ n: string }>`
        select count(*)::text as n from pg_stat_activity
         where wait_event_type = 'Lock' and state = 'active'`.execute(query);
      return rows.rows[0]?.n ?? '0';
    });
    log('[REV-A/W] backends waiting on a lock while T2 holds it:', blocked, '(selection is', selectionOutcome + ')');

    /* T2 now moves the input and commits, releasing the lock. */
    releaseHolder?.();
    const movedRows = await holder;
    log('[REV-A/W] T2 moved', movedRows, 'shift_type row(s) and committed');

    await selection;
    log('[REV-A/W] selection outcome:', selectionOutcome, 'draft =', draftVersionId);

    const after = await stalenessOf(buildRunId, 'window-after');
    log('[REV-A/W] staleness AFTER, for the same run:', JSON.stringify(after));

    const state = await runtime.runner.run(context('window'), async (uow) => {
      const row = await loadRun(uow, buildRunId);
      return { state: row?.state, applied: row?.applied_to_version_id };
    });
    log('[REV-A/W] run state:', JSON.stringify(state));

    log(
      '[REV-A/W] VERDICT:',
      selectionOutcome === 'APPLIED' && after.stale
        ? 'THE WINDOW IS REACHABLE — a candidate was applied over inputs that moved after the staleness read'
        : selectionOutcome === 'APPLIED'
          ? 'applied, but the inputs did NOT read stale afterwards — the construction did not move a constituent'
          : 'the selection REFUSED — the window is narrower than doc 36 §10.4 records',
    );

    /* REV-A reports; it does not decide. Both outcomes are legitimate RESULTS of
     * the probe, and the arm must not fail for reporting the one it found — but it
     * MUST fail if the construction never happened at all. */
    expect(movedRows, 'the construction moved no constituent — the probe would be vacuous').toBeGreaterThan(0);
    expect(before.stale, 'the fixture was already stale before the race').toBe(false);
  }, 300_000);
});
