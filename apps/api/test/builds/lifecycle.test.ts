import { randomUUID } from 'node:crypto';

import type { HardRuleFinding, SolverInputSnapshotDocument } from '@schedulepoint/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claimQueuedBuild, heartbeat } from '../../src/builds/claim.js';
import {
  BuildIdempotencyConflictError,
  BuildResultFencedError,
  BuildSourceMovedError,
  BuildStateMovedError,
  BuildTransitionError,
} from '../../src/builds/errors.js';
import { reapStaleBuilds } from '../../src/builds/reaper.js';
import {
  persistOutcome,
  recordSolveOutcome,
  requestCancellation,
} from '../../src/builds/runner.js';
import { applyCandidateToNewDraft } from '../../src/builds/selection.js';
import {
  approveRun,
  createRun,
  loadRun,
  markReviewed,
  readConfiguration,
  sourceDigestOf,
  transitionRun,
  type BuildRunRow,
} from '../../src/builds/service.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { addManualAssignment } from '../../src/schedule/service.js';
import { createBuildInput } from '../../src/solver/build-input.js';
import { assembleCanonicalInput } from '../../src/solver/canonical-input.js';
import { seedBuildFixture, syntheticOutcome, type BuildFixture } from '../support/builds.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant, scheduleActor } from '../support/schedule.js';

/**
 * **The build lifecycle, end to end and against its guards** (OPUS-M4-003; doc
 * 35 §6e Required behaviour 2–5 and Tests/red cases).
 *
 * Every arm here is a proof about a control, and each one is driven from BOTH
 * sides where the packet asks for it: the service refuses with a typed error a
 * route can map, and — with the service bypassed entirely — the DATABASE refuses
 * the same thing. The second arm is the one that matters, because it is the one
 * that still holds when somebody writes a repair script.
 *
 * ## The deliberately incorrect verdict
 *
 * Several arms hand `persistOutcome` a verdict that the real `validateCandidate`
 * would never produce — `usable: true` beside a HARD finding. That is not a
 * shortcut: it is the packet's own probe ("attempt to make a hard-violating
 * candidate usable through ANY path"), and it is only expressible because M4-001
 * built the validation seam to be pure and substitutable. A compromised caller,
 * a translation defect and a hand-built response all produce exactly this shape.
 * There are THREE controls between such a verdict and a schedule, and each has
 * its own arm below: the `usable_is_earned` CHECK on the result row, the approve
 * guard's count over `build_run_violations`, and the transition matrix itself.
 */

const multi = ownedMulti('builds-lifecycle', {
  profile: 'full',
  seed: { catalogue: ['alpha'], schedule: true, scheduleCredentials: true },
});

let runtime: Runtime;
let admin: Awaited<ReturnType<typeof openAdmin>>;
let shiftTypeId: string;
let schedulerUserId: string;
let schedulerMembershipId: string;
let organizationId: string;
let groupId: string;

/** 2043-01-05, the Monday every window in this file is measured from. */
const WINDOW_ORIGIN = Date.UTC(2043, 0, 5);
let sequence = -1;

function nextWindow(): { startDate: string; endDate: string } {
  /* Each fixture takes its own week, fourteen days apart. D-2's exclusion
   * refuses overlapping periods in one group, so a shared — or merely adjacent —
   * window would make the SECOND fixture in this file fail for a reason that has
   * nothing to do with builds. The fortnight stride leaves a clear week between
   * every pair, so an off-by-one in the arithmetic cannot silently produce a
   * touching pair either. */
  sequence += 1;
  const start = new Date(WINDOW_ORIGIN + sequence * 14 * 86_400_000);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

/** A superuser connection, for the arms that must get past the GRANTS. */
async function openAdmin() {
  const client = adminClient();
  await client.connect();
  return client;
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 8 });
  admin = await openAdmin();
  const alpha = multi().alpha;
  const catalogue = multi.catalogue('alpha');
  const type = catalogue.shiftTypeIds[1];
  if (type === undefined) throw new Error('the alpha catalogue seed produced no shift type');
  shiftTypeId = type;
  organizationId = alpha.organizationId;
  groupId = alpha.groupOne.id;
  schedulerUserId = alpha.users.scheduler.id;
  schedulerMembershipId = alpha.users.scheduler.membershipId;
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
  await admin?.end();
});

async function fixture(label: string, options: { pinned?: boolean } = {}): Promise<BuildFixture> {
  const window = nextWindow();
  const seeded = await seedBuildFixture(runtime.runner, {
    organizationId,
    groupId,
    membershipId: schedulerMembershipId,
    userId: schedulerUserId,
    shiftTypeId,
    label,
    ...window,
  });

  if (options.pinned === true) {
    /* A PINNED manual assignment with a real pick position, so R-8 has something
     * to carry. `addManualAssignment` is the production authoring path and
     * `pickPosition` is its own parameter. */
    await runtime.runner.run(seeded.context, async (uow) => {
      await addManualAssignment(uow, scheduleActor(schedulerUserId), {
        versionId: seeded.versionId,
        membershipId: schedulerMembershipId,
        shiftTypeId,
        date: window.startDate,
        startsAt: fixtureInstant(window.startDate, 9),
        endsAt: fixtureInstant(window.startDate, 17),
        pickPosition: 7,
        isPinned: true,
      });
    });
  }

  return seeded;
}

const run = async <T>(
  context: BuildFixture['context'],
  fn: (uow: PgUnitOfWork) => Promise<T>,
): Promise<T> => runtime.runner.run(context, fn);

async function documentOf(seeded: BuildFixture): Promise<SolverInputSnapshotDocument> {
  return run(seeded.context, async (uow) => {
    const assembled = await assembleCanonicalInput(uow, {
      periodId: seeded.periodId,
      versionId: seeded.versionId,
      at: new Date('2043-01-01T12:00:00.000Z'),
    });
    return assembled.document;
  });
}

/**
 * `draft_configuration → … → queued`, binding a REAL pinned snapshot on the way.
 *
 * `submitBuild` does the same three transitions with the assembly between them.
 * The transitions are driven directly here so that an arm about (say) fencing is
 * not also a test of the readiness check — but the snapshot binding is kept,
 * because selection legitimately refuses a build with no pinned input and a
 * fixture that skipped it would be proving that refusal instead of the property
 * under test.
 */
async function toQueued(seeded: BuildFixture, buildRunId: string): Promise<void> {
  const persisted = await createBuildInput(runtime.runner, seeded.context, {
    periodId: seeded.periodId,
    versionId: seeded.versionId,
    at: new Date('2043-01-01T12:00:00.000Z'),
    idempotencyKey: `proof.${buildRunId}`,
  });

  await run(seeded.context, async (uow) => {
    const created = await loadRun(uow, buildRunId);
    if (created === null) throw new Error('the build run vanished');
    const validating = await transitionRun(uow, created, 'validating', { reason: 'submitted' });
    const checking = await transitionRun(uow, validating, 'readiness_check', {
      reason: 'configuration_consistent',
    });
    await uow.query
      .updateTable('build_runs')
      .set({
        snapshot_id: persisted.snapshotId,
        canonical_input_hash: persisted.canonicalInputHash,
      })
      .where('id', '=', buildRunId)
      .execute();
    await transitionRun(uow, checking, 'queued', { reason: 'ready' });
  });
}

interface RecordOptions {
  readonly usable: boolean;
  readonly findings?: readonly HardRuleFinding[];
  readonly date: string;
}

/** Claim, then persist a hand-built outcome. Returns the resulting state. */
async function claimAndRecord(
  seeded: BuildFixture,
  buildRunId: string,
  document: SolverInputSnapshotDocument,
  options: RecordOptions,
): Promise<string> {
  return run(seeded.context, async (uow) => {
    const claim = await claimQueuedBuild(uow, buildRunId, 'proof.worker.one');
    if (claim === null) throw new Error('the build run could not be claimed');
    const configuration = await readConfiguration(uow, seeded.configurationId);
    if (configuration === null) throw new Error('the configuration vanished');

    return persistOutcome(uow, {
      buildRunId,
      claimEpoch: claim.claimEpoch,
      document,
      outcome: syntheticOutcome(
        claim.run.canonical_input_hash ?? 'a'.repeat(64),
        schedulerMembershipId,
        options.date,
        shiftTypeId,
      ),
      verdict: {
        usable: options.usable,
        rejections: [],
        findings: options.findings ?? [],
        hardViolations: (options.findings ?? []).filter((f) => f.finding === 'breach').length,
      },
      configuration,
    });
  });
}

const BREACH: HardRuleFinding = {
  finding: 'breach',
  ruleKey: 'proof.hard.breach',
  nodeKind: 'MaxConsecutive',
  field: 'rule',
  explanation: 'a synthetic breach, so the validation gate has something to refuse',
};

/** FAD-27's other half: a HARD rule the checker could not evaluate at all. */
const NOT_EVALUABLE: HardRuleFinding = {
  finding: 'not-evaluable',
  ruleKey: 'proof.hard.not-evaluable',
  nodeKind: 'PatternRule',
  field: 'rule',
  explanation: 'a synthetic not-evaluable HARD finding — FAD-27 blocks on it',
};

/* ────────────────────────────────────────────────────────────────────────────
 * 1. The legal path, and D-4a
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the legal path', () => {
  it('walks draft_configuration → … → approved, and records every edge', async () => {
    const seeded = await fixture('legal-path');
    const document = await documentOf(seeded);
    const window = { date: document.startDate };

    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'legal-path',
        idempotencyKey: `legal.${randomUUID().slice(0, 20)}`,
      }),
    );
    expect(created.replayed).toBe(false);

    await toQueued(seeded, created.buildRunId);
    const state = await claimAndRecord(seeded, created.buildRunId, document, {
      usable: true,
      date: window.date,
    });
    expect(state).toBe('completed');

    await run(seeded.context, async (uow) => {
      await markReviewed(uow, scheduleActor(schedulerUserId), created.buildRunId, 'completed');
      await approveRun(uow, scheduleActor(schedulerUserId), created.buildRunId, 'reviewed');
    });

    const final = await run(seeded.context, async (uow) => loadRun(uow, created.buildRunId));
    expect(final?.state).toBe('approved');

    /* The timeline carries every edge, in order, with the claim epoch. */
    const events = await run(seeded.context, async (uow) =>
      uow.query
        .selectFrom('build_run_events')
        .select(['kind', 'from_state', 'to_state'])
        .where('build_run_id', '=', created.buildRunId)
        .orderBy('occurred_at')
        .execute(),
    );
    const transitions = events
      .filter((event) => event.kind === 'transition')
      .map((event) => `${String(event.from_state)}->${String(event.to_state)}`);
    expect(transitions).toEqual([
      'null->draft_configuration',
      'draft_configuration->validating',
      'validating->readiness_check',
      'readiness_check->queued',
      'queued->running',
      'running->completed',
      'completed->reviewed',
      'reviewed->approved',
    ]);
    expect(events.some((event) => event.kind === 'claim')).toBe(true);
  }, 180_000);

  it('D-4a: a second in-flight build of one configuration is refused by the index', async () => {
    const seeded = await fixture('d4a');
    const actor = scheduleActor(schedulerUserId);

    await run(seeded.context, async (uow) =>
      createRun(uow, actor, {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'first',
        idempotencyKey: `d4a.first.${randomUUID().slice(0, 12)}`,
      }),
    );

    await expect(
      run(seeded.context, async (uow) =>
        createRun(uow, actor, {
          configurationId: seeded.configurationId,
          sourceVersionId: seeded.versionId,
          candidateLabel: 'second',
          idempotencyKey: `d4a.second.${randomUUID().slice(0, 12)}`,
        }),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  }, 120_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Illegal transitions — refused at BOTH layers
 * ──────────────────────────────────────────────────────────────────────────── */

describe('illegal transitions', () => {
  it('the service refuses, and the database refuses the SAME edge with the service bypassed', async () => {
    const seeded = await fixture('illegal');
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'illegal',
        idempotencyKey: `illegal.${randomUUID().slice(0, 16)}`,
      }),
    );

    /* Layer 1 — the service. `draft_configuration → approved` is not an edge. */
    await expect(
      run(seeded.context, async (uow) => {
        const row = await loadRun(uow, created.buildRunId);
        if (row === null) throw new Error('vanished');
        return transitionRun(uow, row, 'approved');
      }),
    ).rejects.toBeInstanceOf(BuildTransitionError);

    /* Layer 2 — raw SQL as `app_runtime`, no service code in the path at all. */
    await expect(
      run(
        seeded.context,
        async ({ query }) =>
          await sql`UPDATE build_runs SET state = 'approved', termination_reason = 'completed'
                    WHERE id = ${created.buildRunId}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('BUILD_TRANSITION_ILLEGAL') });

    /* And the row did not move. */
    const after = await run(seeded.context, async (uow) => loadRun(uow, created.buildRunId));
    expect(after?.state).toBe('draft_configuration');
  }, 120_000);

  it('the database refuses to re-point a build at another configuration or snapshot', async () => {
    const seeded = await fixture('identity-frozen');
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'identity',
        idempotencyKey: `identity.${randomUUID().slice(0, 16)}`,
      }),
    );

    await expect(
      run(
        seeded.context,
        async ({ query }) =>
          await sql`UPDATE build_runs SET period_id = ${randomUUID()}::uuid
                    WHERE id = ${created.buildRunId}::uuid`.execute(query),
      ),
      /* Two controls stand here and the GRANT is the outer one: `period_id` is
       * not in `build_runs`' column-level UPDATE grant, so the statement is
       * refused with `permission denied` before the trigger is ever reached. The
       * trigger's `BUILD_IDENTITY_FROZEN` is the redundant inner control and is
       * what would fire for a role that did hold the column. Either word is a
       * refusal; asserting only one would make the test fail if the grant were
       * ever widened, which is the wrong direction to be sensitive in. */
    ).rejects.toMatchObject({
      message: expect.stringMatching(/permission denied|BUILD_IDENTITY_FROZEN/),
    });
  }, 120_000);

  it('a build run is never deleted, by any role', async () => {
    const seeded = await fixture('no-delete');
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'no-delete',
        idempotencyKey: `nodelete.${randomUUID().slice(0, 14)}`,
      }),
    );

    await expect(
      run(
        seeded.context,
        async ({ query }) =>
          await sql`DELETE FROM build_runs WHERE id = ${created.buildRunId}::uuid`.execute(query),
      ),
    ).rejects.toThrow();
  }, 120_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Fencing
 * ──────────────────────────────────────────────────────────────────────────── */

describe('claim fencing', () => {
  it('a stale-epoch result is REFUSED by the service and RECORDED', async () => {
    const seeded = await fixture('fence-service');
    const document = await documentOf(seeded);
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'fence',
        idempotencyKey: `fence.${randomUUID().slice(0, 16)}`,
      }),
    );
    await toQueued(seeded, created.buildRunId);

    const claim = await run(seeded.context, async (uow) =>
      claimQueuedBuild(uow, created.buildRunId, 'proof.worker.stale'),
    );
    expect(claim).not.toBeNull();
    const staleEpoch = claim?.claimEpoch ?? 0;

    /* The reaper advances the epoch — the worker is now fenced. */
    await run(seeded.context, async ({ query }) => {
      await sql`UPDATE build_runs SET heartbeat_at = now() - interval '1 day'
                WHERE id = ${created.buildRunId}::uuid`.execute(query);
    });
    const reaped = await run(seeded.context, async (uow) => reapStaleBuilds(uow));
    expect(reaped.map((entry) => entry.buildRunId)).toContain(created.buildRunId);

    const configurationRow = await run(seeded.context, async (uow) =>
      readConfiguration(uow, seeded.configurationId),
    );
    if (configurationRow === null) throw new Error('the configuration vanished');

    /* The stale worker comes back — through the PRODUCTION result path, because
     * the durability of the refusal record is exactly what is under test and it
     * lives in `recordSolveOutcome`'s sequencing rather than in the fence
     * itself. Calling `assertClaimIsCurrent` directly would assert the throw and
     * silently lose the row, which is the defect this arm found. */
    await expect(
      recordSolveOutcome(runtime.runner, seeded.context, {
        buildRunId: created.buildRunId,
        claimEpoch: staleEpoch,
        document,
        outcome: syntheticOutcome(
          'a'.repeat(64),
          schedulerMembershipId,
          document.startDate,
          shiftTypeId,
        ),
        verdict: { usable: true, rejections: [], findings: [], hardViolations: 0 },
        configuration: configurationRow,
      }),
    ).rejects.toBeInstanceOf(BuildResultFencedError);

    /* …and the refusal is a ROW, not an absence. */
    const refusals = await run(seeded.context, async (uow) =>
      uow.query
        .selectFrom('build_run_events')
        .select(['claim_epoch', 'current_claim_epoch', 'reason'])
        .where('build_run_id', '=', created.buildRunId)
        .where('kind', '=', 'result_refused')
        .execute(),
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.claim_epoch).toBe(staleEpoch);
    expect(refusals[0]?.current_claim_epoch).toBe(staleEpoch + 1);
    expect(refusals[0]?.reason).toBe('stale_claim_epoch');
  }, 180_000);

  it('the DATABASE refuses a stale-epoch result row with the service bypassed entirely', async () => {
    const seeded = await fixture('fence-database');
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'fence-db',
        idempotencyKey: `fencedb.${randomUUID().slice(0, 14)}`,
      }),
    );
    await toQueued(seeded, created.buildRunId);
    const claim = await run(seeded.context, async (uow) =>
      claimQueuedBuild(uow, created.buildRunId, 'proof.worker.db'),
    );
    const currentEpoch = claim?.claimEpoch ?? 0;

    /* GREEN control: the CURRENT epoch goes in. Without this the red arm below
     * could be passing because the insert is malformed. */
    await run(seeded.context, async ({ query }) => {
      await sql`INSERT INTO build_run_violations
                  (organization_id, group_id, build_run_id, claim_epoch, finding,
                   rule_key, node_kind, field, explanation)
                VALUES (${organizationId}::uuid, ${groupId}::uuid,
                        ${created.buildRunId}::uuid, ${currentEpoch}, 'breach',
                        'proof.control', 'MaximumConsecutiveDays', 'rule',
                        'the green control for the fencing red arm')`.execute(query);
    });

    /* RED: one less than the current epoch — a worker from a superseded claim. */
    await expect(
      run(seeded.context, async ({ query }) => {
        await sql`INSERT INTO build_run_violations
                    (organization_id, group_id, build_run_id, claim_epoch, finding,
                     rule_key, node_kind, field, explanation)
                  VALUES (${organizationId}::uuid, ${groupId}::uuid,
                          ${created.buildRunId}::uuid, ${currentEpoch - 1}, 'breach',
                          'proof.stale', 'MaximumConsecutiveDays', 'rule',
                          'a result from a claim that has been superseded')`.execute(query);
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('BUILD_RESULT_FENCED') });
  }, 180_000);

  it('a heartbeat at a fenced epoch answers false rather than throwing', async () => {
    const seeded = await fixture('heartbeat');
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'heartbeat',
        idempotencyKey: `hb.${randomUUID().slice(0, 16)}`,
      }),
    );
    await toQueued(seeded, created.buildRunId);
    const claim = await run(seeded.context, async (uow) =>
      claimQueuedBuild(uow, created.buildRunId, 'proof.worker.hb'),
    );
    const epoch = claim?.claimEpoch ?? 0;

    expect(await run(seeded.context, async (uow) => heartbeat(uow, created.buildRunId, epoch))).toBe(
      true,
    );
    expect(
      await run(seeded.context, async (uow) => heartbeat(uow, created.buildRunId, epoch - 1)),
    ).toBe(false);
  }, 120_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3a. The five database controls the review found unproven (FAD-45(3), R-3)
 *
 * Each is a guard that had only ever been observed NOT firing. FAD-33(1): a
 * control observed only passing is not evidence of anything. Every arm below
 * drives the guard from raw SQL with no service code in the path, and each is
 * paired with a GREEN control on the same statement shape so the refusal cannot
 * be an accident of a malformed insert.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the database controls, driven directly', () => {
  /** A run parked in `running` at a known epoch, ready to be attacked. */
  async function runningBuild(label: string): Promise<{
    seeded: BuildFixture;
    buildRunId: string;
    epoch: number;
  }> {
    const seeded = await fixture(label);
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: label,
        idempotencyKey: `${label}.${randomUUID().slice(0, 12)}`,
      }),
    );
    await toQueued(seeded, created.buildRunId);
    const claim = await run(seeded.context, async (uow) =>
      claimQueuedBuild(uow, created.buildRunId, `proof.worker.${label.slice(0, 12)}`),
    );
    return { seeded, buildRunId: created.buildRunId, epoch: claim?.claimEpoch ?? 0 };
  }

  async function insertViolation(
    seeded: BuildFixture,
    buildRunId: string,
    epoch: number,
    ruleKey: string,
  ): Promise<void> {
    await run(seeded.context, async ({ query }) => {
      await sql`INSERT INTO build_run_violations
                  (organization_id, group_id, build_run_id, claim_epoch, finding,
                   rule_key, node_kind, field, explanation)
                VALUES (${organizationId}::uuid, ${groupId}::uuid, ${buildRunId}::uuid,
                        ${epoch}, 'breach', ${ruleKey}, 'MaxConsecutive', 'rule',
                        'driven directly, with no service code in the path')`.execute(query);
    });
  }

  it('R-3a: the SETTLED-RUN clause refuses an injection at the CURRENT epoch', async () => {
    /* The reviewer's serious one. The epoch clause catches a superseded WORKER;
     * this clause is the sole refusal for injecting into a run that has already
     * settled — a `failed` build acquiring a usable candidate, or an `approved`
     * one acquiring extra assignments after the gate that checked it. The epoch
     * still matches, because settling does not change it. */
    const { seeded, buildRunId, epoch } = await runningBuild('state-clause');

    /* GREEN control: while the run is RUNNING, the identical statement succeeds.
     * Without it, the red arm below could be passing on a malformed insert. */
    await insertViolation(seeded, buildRunId, epoch, 'proof.control.running');

    /* Settle the run through the production path. */
    await run(seeded.context, async (uow) => {
      const row = await loadRun(uow, buildRunId);
      if (row === null) throw new Error('vanished');
      await transitionRun(uow, row, 'failed', {
        terminationReason: 'crashed',
        solverStatus: 'FAILED',
        reason: 'settled_for_the_proof',
      });
    });

    /* RED: same epoch, same statement, settled run. */
    await expect(
      insertViolation(seeded, buildRunId, epoch, 'proof.injected.after.settling'),
    ).rejects.toMatchObject({
      message: expect.stringContaining('BUILD_RESULT_NOT_RUNNING'),
    });

    /* …and nothing landed. */
    const rows = await run(seeded.context, async (uow) =>
      uow.query
        .selectFrom('build_run_violations')
        .select('rule_key')
        .where('build_run_id', '=', buildRunId)
        .execute(),
    );
    expect(rows.map((row) => row.rule_key)).toEqual(['proof.control.running']);
  }, 240_000);

  it('R-3b: the result tables are APPEND-ONLY — the TRIGGER, past the grants', async () => {
    /* ## What the first version of this arm got wrong, and how it was caught
     *
     * It drove the UPDATE and the DELETE through `run(seeded.context, …)` — as
     * `app_runtime` — and asserted only `.rejects.toThrow()`. But `app_runtime`
     * holds `SELECT, INSERT` on these tables and nothing else, so the statement
     * was refused by the GRANT with `permission denied` and never reached the
     * trigger at all. The comment claimed the arm bound "the OWNER too"; it did
     * not. The delta review demonstrated it by removing all four
     * `*_append_only` triggers and observing the suite stay green, and the
     * removal was reproduced here before this repair was written.
     *
     * That is the FAD-33(1) failure mode exactly: a control observed only NOT
     * firing, with a comment asserting what it had never been asked to do.
     *
     * ## The two controls, now named separately
     *
     * They bind different writers and the arm proves each against the writer it
     * actually binds:
     *
     *   * the GRANT stops `app_runtime` — `permission denied`;
     *   * the TRIGGER stops everything the grant does not, including the table
     *     owner and a superuser — `APPEND_ONLY`.
     *
     * Only the second half can go red when the triggers are removed, which is
     * what makes this arm evidence rather than decoration. */
    const { seeded, buildRunId, epoch } = await runningBuild('append-only');
    await insertViolation(seeded, buildRunId, epoch, 'proof.appendonly');

    /* ── the GRANT, as the application role ──────────────────────────────── */
    await expect(
      run(seeded.context, async ({ query }) => {
        await sql`UPDATE build_run_violations SET explanation = 'edited by app_runtime'
                  WHERE build_run_id = ${buildRunId}::uuid`.execute(query);
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('permission denied') });

    /* ── the TRIGGER, as the SUPERUSER, where no grant intervenes ─────────── */
    await expect(
      admin.query(`UPDATE build_run_violations SET explanation = $1 WHERE build_run_id = $2`, [
        'edited after the fact by the owner',
        buildRunId,
      ]),
    ).rejects.toMatchObject({ message: expect.stringContaining('APPEND_ONLY') });

    await expect(
      admin.query(`DELETE FROM build_run_violations WHERE build_run_id = $1`, [buildRunId]),
    ).rejects.toMatchObject({ message: expect.stringContaining('APPEND_ONLY') });

    /* The same guard on the other result-bearing tables, so removing any ONE of
     * the four triggers is caught rather than only the violations one.
     *
     * Every target is asserted NON-EMPTY first. A `FOR EACH ROW` trigger does
     * not fire for a statement that matches nothing, so a DELETE over an empty
     * table RESOLVES — which is exactly how the first draft of this repair
     * failed its own green control, and it would otherwise have been a second
     * decorative assertion in an arm written to remove one. */
    await run(seeded.context, async ({ query }) => {
      await sql`INSERT INTO build_run_candidate_assignments
                  (organization_id, group_id, build_run_id, claim_epoch, ordinal,
                   membership_id, date, shift_type_id, location_id)
                VALUES (${organizationId}::uuid, ${groupId}::uuid, ${buildRunId}::uuid,
                        ${epoch}, 0, ${schedulerMembershipId}::uuid,
                        ${'2043-01-05'}::date, ${shiftTypeId}::uuid, NULL)`.execute(query);
    });

    const populated = await run(seeded.context, async ({ query }) =>
      sql<{ events: string; candidates: string }>`
        SELECT (SELECT count(*)::text FROM build_run_events
                 WHERE build_run_id = ${buildRunId}::uuid) AS events,
               (SELECT count(*)::text FROM build_run_candidate_assignments
                 WHERE build_run_id = ${buildRunId}::uuid) AS candidates`.execute(query),
    );
    expect(Number(populated.rows[0]?.events), 'no events to guard').toBeGreaterThan(0);
    expect(Number(populated.rows[0]?.candidates), 'no candidates to guard').toBeGreaterThan(0);

    await expect(
      admin.query(`UPDATE build_run_events SET reason = $1 WHERE build_run_id = $2`, [
        'rewritten',
        buildRunId,
      ]),
    ).rejects.toMatchObject({ message: expect.stringContaining('APPEND_ONLY') });

    await expect(
      admin.query(`DELETE FROM build_run_candidate_assignments WHERE build_run_id = $1`, [
        buildRunId,
      ]),
    ).rejects.toMatchObject({ message: expect.stringContaining('APPEND_ONLY') });

    /* GREEN control on the same superuser connection: a table WITHOUT the guard
     * accepts the identical statement shape, so the four refusals above are the
     * triggers rather than a read-only session or a broken connection. */
    await admin.query(`UPDATE build_runs SET candidate_label = $1 WHERE id = $2`, [
      'the owner may still edit an unguarded column',
      buildRunId,
    ]);

    /* And the row is byte-identical. A refusal that had already written would
     * look the same from the error alone. */
    const rows = await run(seeded.context, async (uow) =>
      uow.query
        .selectFrom('build_run_violations')
        .select(['rule_key', 'explanation'])
        .where('build_run_id', '=', buildRunId)
        .execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.explanation).toBe('driven directly, with no service code in the path');
  }, 240_000);

  it('R-3c: BUILD_CLAIM_EPOCH_REGRESSED — the epoch moves forward only', async () => {
    const { seeded, buildRunId, epoch } = await runningBuild('epoch-regress');

    /* GREEN control: forward is fine. `claim_epoch` IS in the column-level
     * UPDATE grant, so this statement is reaching the trigger and not a grant. */
    await run(seeded.context, async ({ query }) => {
      await sql`UPDATE build_runs SET claim_epoch = ${epoch + 1}
                WHERE id = ${buildRunId}::uuid`.execute(query);
    });

    /* RED: backward. A decrement is exactly how a fenced worker would become
     * un-fenced, which is why the guard exists at all. */
    await expect(
      run(seeded.context, async ({ query }) => {
        await sql`UPDATE build_runs SET claim_epoch = ${epoch}
                  WHERE id = ${buildRunId}::uuid`.execute(query);
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('BUILD_CLAIM_EPOCH_REGRESSED'),
    });

    const after = await run(seeded.context, async (uow) => loadRun(uow, buildRunId));
    expect(after?.claim_epoch).toBe(epoch + 1);
  }, 240_000);

  it('R-3d: BUILD_IDENTITY_FROZEN — reached as the OWNER, past the grants', async () => {
    /* Two controls stand over a build's identity and they bind different
     * writers. The column-level UPDATE grant stops `app_runtime` — proven by the
     * `illegal transitions` arm, which meets `permission denied`. The TRIGGER is
     * what stops everything the grant does not: the table owner, a superuser, a
     * repair script. It had never been observed firing, which is what R-3 says.
     *
     * So this arm drives it as the superuser, where no grant intervenes. */
    const { seeded, buildRunId } = await runningBuild('identity-frozen');

    await expect(
      admin.query(
        `UPDATE build_runs SET semantic_request_digest = $1 WHERE id = $2`,
        ['0'.repeat(64), buildRunId],
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('BUILD_IDENTITY_FROZEN'),
    });

    /* GREEN control on the same connection and the same table: a column the
     * guard does NOT freeze updates fine, so the refusal above is the identity
     * clause rather than a broken connection or a read-only session. */
    await admin.query(`UPDATE build_runs SET candidate_label = $1 WHERE id = $2`, [
      'renamed by the owner',
      buildRunId,
    ]);
    const after = await run(seeded.context, async (uow) => loadRun(uow, buildRunId));
    expect(after?.candidate_label).toBe('renamed by the owner');
  }, 240_000);

  it('R-3e: a build run is never DELETED, as the OWNER', async () => {
    /* The service has no delete path and `app_runtime` holds no DELETE grant.
     * The trigger is what binds the owner, and this is the arm that proves it
     * rather than assuming the absent grant covers everybody. */
    const { seeded, buildRunId } = await runningBuild('no-delete-owner');

    await expect(
      admin.query(`DELETE FROM build_runs WHERE id = $1`, [buildRunId]),
    ).rejects.toMatchObject({
      message: expect.stringContaining('BUILD_RUN_NOT_DELETABLE'),
    });

    const after = await run(seeded.context, async (uow) => loadRun(uow, buildRunId));
    expect(after).not.toBeNull();
  }, 240_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. The reaper
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the reaper', () => {
  it('moves a dead-heartbeat run to failed/crashed and advances the epoch', async () => {
    const seeded = await fixture('reaper');
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'reaper',
        idempotencyKey: `reap.${randomUUID().slice(0, 16)}`,
      }),
    );
    await toQueued(seeded, created.buildRunId);
    const claim = await run(seeded.context, async (uow) =>
      claimQueuedBuild(uow, created.buildRunId, 'proof.worker.dead'),
    );

    /* A LIVE heartbeat is not reaped. Without this control the arm below would
     * pass for a reaper that reaped everything. */
    const noneReaped = await run(seeded.context, async (uow) => reapStaleBuilds(uow));
    expect(noneReaped.map((entry) => entry.buildRunId)).not.toContain(created.buildRunId);

    await run(seeded.context, async ({ query }) => {
      await sql`UPDATE build_runs SET heartbeat_at = now() - interval '1 hour'
                WHERE id = ${created.buildRunId}::uuid`.execute(query);
    });

    const reaped = await run(seeded.context, async (uow) => reapStaleBuilds(uow));
    expect(reaped.map((entry) => entry.buildRunId)).toContain(created.buildRunId);

    const after = await run(seeded.context, async (uow) => loadRun(uow, created.buildRunId));
    expect(after?.state).toBe('failed');
    /* `crashed`, not `deadline` and not `killed`. A dead heartbeat means the
     * worker stopped without saying why; guessing a more specific word would be
     * inventing evidence (FAD-34(2)). */
    expect(after?.termination_reason).toBe('crashed');
    expect(after?.claim_epoch).toBe((claim?.claimEpoch ?? 0) + 1);
    expect(after?.claimed_by).toBeNull();
    expect(after?.heartbeat_at).toBeNull();
  }, 180_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. The validation gate
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the validation gate', () => {
  it('a candidate the checker refused settles in failed/rejected, never completed', async () => {
    const seeded = await fixture('gate-refused');
    const document = await documentOf(seeded);
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'refused',
        idempotencyKey: `gate1.${randomUUID().slice(0, 14)}`,
      }),
    );
    await toQueued(seeded, created.buildRunId);

    const state = await claimAndRecord(seeded, created.buildRunId, document, {
      usable: false,
      findings: [BREACH],
      date: document.startDate,
    });

    /* `failed`, not `infeasible`: the problem may well have a solution — this
     * candidate is not it. And `rejected`, the FAD-34 word. */
    expect(state).toBe('failed');
    const row = await run(seeded.context, async (uow) => loadRun(uow, created.buildRunId));
    expect(row?.termination_reason).toBe('rejected');
    expect(row?.solver_status).toBe('FEASIBLE');
  }, 180_000);

  it('ARM: a hard-violating candidate can NEVER reach approved, even claimed usable', async () => {
    const seeded = await fixture('gate-arm');
    const document = await documentOf(seeded);
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'arm',
        idempotencyKey: `gate2.${randomUUID().slice(0, 14)}`,
      }),
    );
    await toQueued(seeded, created.buildRunId);

    /* The deliberately incorrect verdict: `usable: true` beside a HARD finding
     * the checker could not evaluate. A caller that lied, a translation defect,
     * or a compromised worker all produce this shape.
     *
     * `not-evaluable` rather than `breach`, and the difference is load-bearing:
     * `hard_violations` counts BREACHES only, so a lying verdict can carry a
     * not-evaluable finding past `build_run_results_usable_is_earned` — which is
     * precisely the case FAD-27 rules on ("this HARD rule cannot be checked, so
     * this version cannot be asserted to satisfy it"). The approve guard counts
     * BOTH kinds, and that is what this arm proves. The breach arm below covers
     * the other half, where the CHECK refuses the row outright. */
    const state = await claimAndRecord(seeded, created.buildRunId, document, {
      usable: true,
      findings: [NOT_EVALUABLE],
      date: document.startDate,
    });
    expect(state).toBe('completed');

    await run(seeded.context, async (uow) => {
      await markReviewed(uow, scheduleActor(schedulerUserId), created.buildRunId, 'completed');
    });

    /* Through the service… */
    await expect(
      run(seeded.context, async (uow) =>
        approveRun(uow, scheduleActor(schedulerUserId), created.buildRunId, 'reviewed'),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('BUILD_HARD_VIOLATIONS_UNRESOLVED'),
    });

    /* …and with the service bypassed entirely. */
    await expect(
      run(
        seeded.context,
        async ({ query }) =>
          await sql`UPDATE build_runs SET state = 'approved'
                    WHERE id = ${created.buildRunId}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('BUILD_HARD_VIOLATIONS_UNRESOLVED'),
    });

    const after = await run(seeded.context, async (uow) => loadRun(uow, created.buildRunId));
    expect(after?.state).toBe('reviewed');
  }, 180_000);

  it('a lying verdict carrying a BREACH is refused by the result CHECK itself', async () => {
    /* The outer of the three controls. `usable = true` with `hard_violations > 0`
     * is refused by `build_run_results_usable_is_earned` before the row exists —
     * so the approve guard is never even reached for this shape, and a caller
     * that lies about a breach gets no result row at all. */
    const seeded = await fixture('gate-breach');
    const document = await documentOf(seeded);
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'breach',
        idempotencyKey: `gate5.${randomUUID().slice(0, 14)}`,
      }),
    );
    await toQueued(seeded, created.buildRunId);

    await expect(
      claimAndRecord(seeded, created.buildRunId, document, {
        usable: true,
        findings: [BREACH],
        date: document.startDate,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('build_run_results_usable_is_earned'),
    });
  }, 180_000);

  it('MUTATION CONTROL: the identical flow WITHOUT the finding reaches approved', async () => {
    /* Without this, the arm above could be passing because `reviewed → approved`
     * is refused for some other reason entirely — a missing capability, a
     * mis-spelled state, an unrelated constraint. This is the same nine
     * statements with one finding removed. */
    const seeded = await fixture('gate-control');
    const document = await documentOf(seeded);
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'control',
        idempotencyKey: `gate3.${randomUUID().slice(0, 14)}`,
      }),
    );
    await toQueued(seeded, created.buildRunId);
    await claimAndRecord(seeded, created.buildRunId, document, {
      usable: true,
      findings: [],
      date: document.startDate,
    });

    await run(seeded.context, async (uow) => {
      await markReviewed(uow, scheduleActor(schedulerUserId), created.buildRunId, 'completed');
      await approveRun(uow, scheduleActor(schedulerUserId), created.buildRunId, 'reviewed');
    });
    const after = await run(seeded.context, async (uow) => loadRun(uow, created.buildRunId));
    expect(after?.state).toBe('approved');
  }, 180_000);

  it('a run with NO recorded result is not approvable — "not checked" never reads as "clean"', async () => {
    const seeded = await fixture('gate-noresult');
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'noresult',
        idempotencyKey: `gate4.${randomUUID().slice(0, 14)}`,
      }),
    );
    await toQueued(seeded, created.buildRunId);
    await run(seeded.context, async (uow) =>
      claimQueuedBuild(uow, created.buildRunId, 'proof.worker.silent'),
    );

    /* Forced to `completed` with no result row — legal edges only, so the only
     * thing standing between this and `approved` is the gate. */
    await run(seeded.context, async ({ query }) => {
      await sql`UPDATE build_runs SET state = 'completed', termination_reason = 'completed'
                WHERE id = ${created.buildRunId}::uuid`.execute(query);
      await sql`UPDATE build_runs SET state = 'reviewed'
                WHERE id = ${created.buildRunId}::uuid`.execute(query);
    });

    await expect(
      run(
        seeded.context,
        async ({ query }) =>
          await sql`UPDATE build_runs SET state = 'approved'
                    WHERE id = ${created.buildRunId}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('BUILD_RESULT_MISSING') });
  }, 180_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6. Idempotent submission
 * ──────────────────────────────────────────────────────────────────────────── */

describe('idempotent creation (D-17)', () => {
  it('twelve concurrent requests with one key produce exactly one row', async () => {
    const seeded = await fixture('idempotency');
    const key = `race.${randomUUID().slice(0, 20)}`;
    const actor = scheduleActor(schedulerUserId);

    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, async () =>
        run(seeded.context, async (uow) =>
          createRun(uow, actor, {
            configurationId: seeded.configurationId,
            sourceVersionId: seeded.versionId,
            candidateLabel: 'race',
            idempotencyKey: key,
          }),
        ),
      ),
    );

    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<{ buildRunId: string; replayed: boolean }> =>
        attempt.status === 'fulfilled',
    );
    expect(fulfilled.length, 'every attempt should answer, none should fault').toBeGreaterThan(0);

    /* One id, whatever the interleaving. */
    const ids = new Set(fulfilled.map((attempt) => attempt.value.buildRunId));
    expect(ids.size).toBe(1);
    expect(fulfilled.filter((attempt) => !attempt.value.replayed)).toHaveLength(1);

    /* DB-asserted, not inferred from the return values. */
    const rows = await run(seeded.context, async ({ query }) =>
      sql<{ n: string }>`SELECT count(*)::text AS n FROM build_runs
                         WHERE period_id = ${seeded.periodId}::uuid
                           AND idempotency_key = ${key}`.execute(query),
    );
    expect(Number(rows.rows[0]?.n)).toBe(1);
  }, 240_000);

  it('the same key naming a DIFFERENT request is refused explicitly', async () => {
    const seeded = await fixture('idempotency-conflict');
    const key = `conflict.${randomUUID().slice(0, 16)}`;
    const actor = scheduleActor(schedulerUserId);

    await run(seeded.context, async (uow) =>
      createRun(uow, actor, {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'first-label',
        idempotencyKey: key,
      }),
    );

    await expect(
      run(seeded.context, async (uow) =>
        createRun(uow, actor, {
          configurationId: seeded.configurationId,
          sourceVersionId: seeded.versionId,
          /* One field different — that is the whole point of the digest. */
          candidateLabel: 'a-different-label',
          idempotencyKey: key,
        }),
      ),
    ).rejects.toBeInstanceOf(BuildIdempotencyConflictError);
  }, 120_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6a. The audit chain (FAD-44(2))
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the audit chain', () => {
  it('writes a `build.*` chain entry for every transition a human takes', async () => {
    const seeded = await fixture('audit');
    const document = await documentOf(seeded);
    const actor = scheduleActor(schedulerUserId);

    const created = await run(seeded.context, async (uow) =>
      createRun(uow, actor, {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'audit',
        idempotencyKey: `audit.${randomUUID().slice(0, 16)}`,
      }),
    );
    await toQueued(seeded, created.buildRunId);
    await claimAndRecord(seeded, created.buildRunId, document, {
      usable: true,
      findings: [],
      date: document.startDate,
    });
    await run(seeded.context, async (uow) => {
      await markReviewed(uow, actor, created.buildRunId, 'completed');
      await approveRun(uow, actor, created.buildRunId, 'reviewed');
    });

    const events = await run(seeded.context, async ({ query }) =>
      sql<{ event_name: string; subject_type: string }>`
        SELECT event_name, subject_type FROM audit_events
        WHERE subject_id = ${created.buildRunId}::uuid
        ORDER BY sequence`.execute(query),
    );
    const names = events.rows.map((row) => row.event_name);

    /* Filed under its OWN aggregate, never under a version it may never
     * produce. */
    expect(events.rows.every((row) => row.subject_type === 'build_run')).toBe(true);

    expect(names[0]).toBe('build.run.created');
    expect(names).toContain('build.run.submitted');
    /* The two moments a human takes responsibility have their OWN names, so
     * "who approved this" is a filter rather than a payload scan. */
    expect(names).toContain('build.run.approved');
    /* …and the system-driven edges share the generic one rather than minting a
     * name per edge. */
    expect(names).toContain('build.run.state_changed');
  }, 240_000);

  it('names a cancellation as a cancellation, not as a generic state change', async () => {
    const seeded = await fixture('audit-cancel');
    const actor = scheduleActor(schedulerUserId);
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, actor, {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'audit-cancel',
        idempotencyKey: `auditc.${randomUUID().slice(0, 14)}`,
      }),
    );
    await toQueued(seeded, created.buildRunId);
    await run(seeded.context, async (uow) =>
      requestCancellation(uow, actor, created.buildRunId, 'queued'),
    );

    const events = await run(seeded.context, async ({ query }) =>
      sql<{ event_name: string }>`
        SELECT event_name FROM audit_events WHERE subject_id = ${created.buildRunId}::uuid`.execute(
        query,
      ),
    );
    expect(events.rows.map((row) => row.event_name)).toContain('build.run.cancelled');
  }, 240_000);

  it('does NOT write a chain entry for a reap — that is a fact about a worker', async () => {
    /* The chain records what happened to the AGGREGATE. A heartbeat expiring is
     * a fact about a worker; it lands on the build's timeline, where the
     * scheduler's screen reads it, and the resulting `running -> failed` moves
     * the aggregate and IS chained. */
    const seeded = await fixture('audit-reap');
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'audit-reap',
        idempotencyKey: `auditr.${randomUUID().slice(0, 14)}`,
      }),
    );
    await toQueued(seeded, created.buildRunId);
    await run(seeded.context, async (uow) =>
      claimQueuedBuild(uow, created.buildRunId, 'proof.worker.audit'),
    );
    await run(seeded.context, async ({ query }) => {
      await sql`UPDATE build_runs SET heartbeat_at = now() - interval '1 hour'
                WHERE id = ${created.buildRunId}::uuid`.execute(query);
    });
    await run(seeded.context, async (uow) => reapStaleBuilds(uow));

    const timeline = await run(seeded.context, async (uow) =>
      uow.query
        .selectFrom('build_run_events')
        .select('kind')
        .where('build_run_id', '=', created.buildRunId)
        .where('kind', '=', 'heartbeat_reaped')
        .execute(),
    );
    expect(timeline).toHaveLength(1);

    const chain = await run(seeded.context, async ({ query }) =>
      sql<{ event_name: string }>`
        SELECT event_name FROM audit_events WHERE subject_id = ${created.buildRunId}::uuid`.execute(
        query,
      ),
    );
    const names = chain.rows.map((row) => row.event_name);
    expect(names).not.toContain('build.run.reaped');
    /* The state change it caused IS chained. */
    expect(names).toContain('build.run.state_changed');
  }, 240_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 7. Selection
 * ──────────────────────────────────────────────────────────────────────────── */

describe('selection', () => {
  async function approvedBuild(label: string, pinned: boolean): Promise<{
    seeded: BuildFixture;
    buildRunId: string;
    document: SolverInputSnapshotDocument;
  }> {
    const seeded = await fixture(label, { pinned });
    const document = await documentOf(seeded);
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: label,
        idempotencyKey: `${label}.${randomUUID().slice(0, 12)}`,
      }),
    );
    await toQueued(seeded, created.buildRunId);
    await claimAndRecord(seeded, created.buildRunId, document, {
      usable: true,
      findings: [],
      date: document.startDate,
    });
    await run(seeded.context, async (uow) => {
      await markReviewed(uow, scheduleActor(schedulerUserId), created.buildRunId, 'completed');
      await approveRun(uow, scheduleActor(schedulerUserId), created.buildRunId, 'reviewed');
    });
    return { seeded, buildRunId: created.buildRunId, document };
  }

  it('creates a NEW draft, leaves the source untouched, and carries R-8 pick positions', async () => {
    const { seeded, buildRunId } = await approvedBuild('selection-r8', true);

    const sourceBefore = await run(seeded.context, async ({ query }) =>
      sql<{ n: string }>`SELECT count(*)::text AS n FROM assignment_snapshots
                         WHERE version_id = ${seeded.versionId}::uuid`.execute(query),
    );

    const digest = await run(seeded.context, async (uow) => {
      const row = await loadRun(uow, buildRunId);
      if (row === null) throw new Error('vanished');
      return sourceDigestOf(uow, row);
    });

    const applied = await run(seeded.context, async (uow) =>
      applyCandidateToNewDraft(
        uow,
        scheduleActor(schedulerUserId),
        buildRunId,
        'approved',
        digest,
      ),
    );

    expect(applied.draftVersionId).not.toBe(seeded.versionId);
    expect(applied.assignmentsWritten).toBeGreaterThan(0);
    /* R-8: the candidate row mirrors the PINNED fixed input, so its real pick
     * position (7) travelled rather than being flattened to NULL. */
    expect(applied.pickPositionsCarried).toBe(1);

    const written = await run(seeded.context, async (uow) =>
      uow.query
        .selectFrom('assignment_snapshots')
        .select(['origin', 'pick_position', 'is_pinned', 'assignment_identity_id'])
        .where('version_id', '=', applied.draftVersionId)
        .execute(),
    );
    expect(written).toHaveLength(applied.assignmentsWritten);
    /* Solver-produced, and said so. Recording this as `manual` would make the
     * production mechanism indistinguishable from an override (rule 7). */
    expect(written.every((row) => row.origin === 'solver')).toBe(true);
    expect(written.some((row) => row.pick_position === 7 && row.is_pinned)).toBe(true);

    /* FAD-44(1): the IDENTITY carries the origin too. "Was this assignment ever
     * solver-made?" must be answerable without reading every snapshot of it —
     * and a mirrored identity keeps the origin the manual path gave it, which is
     * what makes the progressive stage able to tell the two apart. */
    const identities = await run(seeded.context, async (uow) =>
      uow.query
        .selectFrom('assignment_identities')
        .select(['id', 'origin'])
        .where('period_id', '=', seeded.periodId)
        .execute(),
    );
    const mirrored = written.find((row) => row.pick_position === 7);
    expect(identities.find((row) => row.id === mirrored?.assignment_identity_id)?.origin).toBe(
      'manual',
    );
    const solverChosen = written.filter((row) => row.pick_position === null);
    for (const row of solverChosen) {
      expect(
        identities.find((identity) => identity.id === row.assignment_identity_id)?.origin,
      ).toBe('solver');
    }

    /* ONE write path (FAD-44(1)): the rows came through `addAssignment`, so the
     * schedule module's own audit event fired for each of them. Before the
     * refactor, selection wrote the rows itself and this event did not exist. */
    const added = await run(seeded.context, async ({ query }) =>
      sql<{ n: string }>`SELECT count(*)::text AS n FROM audit_events
                         WHERE event_name = 'schedule.assignment.added'
                           AND payload ->> 'version' = ${applied.draftVersionId}`.execute(query),
    );
    expect(Number(added.rows[0]?.n)).toBe(applied.assignmentsWritten);

    /* …and the payload says WHICH mechanism placed it. */
    const solverAdds = await run(seeded.context, async ({ query }) =>
      sql<{ n: string }>`SELECT count(*)::text AS n FROM audit_events
                         WHERE event_name = 'schedule.assignment.added'
                           AND payload ->> 'version' = ${applied.draftVersionId}
                           AND payload ->> 'origin' = 'solver'`.execute(query),
    );
    expect(Number(solverAdds.rows[0]?.n)).toBe(applied.assignmentsWritten);

    /* The SOURCE version is byte-for-byte where the scheduler left it. */
    const sourceAfter = await run(seeded.context, async ({ query }) =>
      sql<{ n: string }>`SELECT count(*)::text AS n FROM assignment_snapshots
                         WHERE version_id = ${seeded.versionId}::uuid`.execute(query),
    );
    expect(sourceAfter.rows[0]?.n).toBe(sourceBefore.rows[0]?.n);

    const run2 = await run(seeded.context, async (uow) => loadRun(uow, buildRunId));
    expect(run2?.state).toBe('applied_to_draft_schedule');
    expect(run2?.applied_to_version_id).toBe(applied.draftVersionId);
  }, 240_000);

  it('refuses when the source draft moved since the build (FAD-26(2))', async () => {
    const { seeded, buildRunId } = await approvedBuild('selection-cas', false);

    await expect(
      run(seeded.context, async (uow) =>
        applyCandidateToNewDraft(
          uow,
          scheduleActor(schedulerUserId),
          buildRunId,
          'approved',
          'b'.repeat(64),
        ),
      ),
    ).rejects.toBeInstanceOf(BuildSourceMovedError);

    /* Nothing was created. A refused selection leaves no orphan draft. */
    const versions = await run(seeded.context, async (uow) =>
      uow.query
        .selectFrom('schedule_versions')
        .select('id')
        .where('period_id', '=', seeded.periodId)
        .execute(),
    );
    expect(versions).toHaveLength(1);
  }, 240_000);

  it('refuses a second selection of the same build (the state has moved)', async () => {
    const { seeded, buildRunId } = await approvedBuild('selection-twice', false);
    const digest = await run(seeded.context, async (uow) => {
      const row = await loadRun(uow, buildRunId);
      if (row === null) throw new Error('vanished');
      return sourceDigestOf(uow, row);
    });

    await run(seeded.context, async (uow) =>
      applyCandidateToNewDraft(uow, scheduleActor(schedulerUserId), buildRunId, 'approved', digest),
    );

    await expect(
      run(seeded.context, async (uow) =>
        applyCandidateToNewDraft(
          uow,
          scheduleActor(schedulerUserId),
          buildRunId,
          'approved',
          digest,
        ),
      ),
    ).rejects.toBeInstanceOf(BuildStateMovedError);
  }, 240_000);

  it('D-4d: two builds cannot be applied to one version — the index refuses the second', async () => {
    const { seeded, buildRunId } = await approvedBuild('selection-d4d', false);
    const digest = await run(seeded.context, async (uow) => {
      const row = await loadRun(uow, buildRunId);
      if (row === null) throw new Error('vanished');
      return sourceDigestOf(uow, row);
    });
    const applied = await run(seeded.context, async (uow) =>
      applyCandidateToNewDraft(uow, scheduleActor(schedulerUserId), buildRunId, 'approved', digest),
    );

    /* A second build, forced to name the SAME applied version. The partial
     * unique index is the control and it binds raw SQL as well as the service. */
    const other = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'd4d-second',
        idempotencyKey: `d4d2.${randomUUID().slice(0, 12)}`,
      }),
    );

    await expect(
      run(seeded.context, async ({ query }) => {
        await sql`UPDATE build_runs
                    SET applied_to_version_id = ${applied.draftVersionId}::uuid,
                        applied_at = now()
                  WHERE id = ${other.buildRunId}::uuid`.execute(query);
      }),
    ).rejects.toMatchObject({ code: '23505' });
  }, 240_000);

  it('approving supersedes the period’s other completed builds', async () => {
    const seeded = await fixture('supersede');
    const document = await documentOf(seeded);
    const actor = scheduleActor(schedulerUserId);

    const first = await run(seeded.context, async (uow) =>
      createRun(uow, actor, {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'first',
        idempotencyKey: `sup1.${randomUUID().slice(0, 12)}`,
      }),
    );
    await toQueued(seeded, first.buildRunId);
    await claimAndRecord(seeded, first.buildRunId, document, {
      usable: true,
      findings: [],
      date: document.startDate,
    });
    await run(seeded.context, async (uow) => {
      await markReviewed(uow, actor, first.buildRunId, 'completed');
    });

    /* The first build is settled, so D-4a admits a second of the same
     * configuration — which is exactly the reading D-4a's "non-terminal" has. */
    const second = await run(seeded.context, async (uow) =>
      createRun(uow, actor, {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'second',
        idempotencyKey: `sup2.${randomUUID().slice(0, 12)}`,
      }),
    );
    await toQueued(seeded, second.buildRunId);
    await claimAndRecord(seeded, second.buildRunId, document, {
      usable: true,
      findings: [],
      date: document.startDate,
    });
    await run(seeded.context, async (uow) => {
      await markReviewed(uow, actor, second.buildRunId, 'completed');
      await approveRun(uow, actor, second.buildRunId, 'reviewed');
    });

    const firstAfter = await run(seeded.context, async (uow) => loadRun(uow, first.buildRunId));
    expect(firstAfter?.state).toBe('superseded');
    expect(firstAfter?.superseded_by_build_run_id).toBe(second.buildRunId);
  }, 300_000);
});

/** Kept so a reader can see the row type is exercised rather than inferred. */
export type { BuildRunRow };
