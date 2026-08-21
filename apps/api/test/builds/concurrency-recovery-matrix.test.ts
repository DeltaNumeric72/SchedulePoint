import { randomUUID } from 'node:crypto';

import type { SolverInputSnapshotDocument } from '@schedulepoint/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claimQueuedBuild, workerToken } from '../../src/builds/claim.js';
import {
  admitBuildUnderCap,
  capacityAdvisoryLockKey,
  maxConcurrentBuildsPerOrganization,
  runningBuildCount,
  DEFAULT_MAX_CONCURRENT_BUILDS,
  MAX_CONCURRENT_BUILDS_ENV,
} from '../../src/builds/capacity.js';
import {
  BuildInputsMovedError,
  BuildResultFencedError,
  BuildSourceMovedError,
  BuildStateMovedError,
} from '../../src/builds/errors.js';
import {
  BUILD_SOLVE_TASK,
  enqueueBuildSolve,
  parseBuildSolvePayload,
  requeueOrphanedQueuedBuilds,
} from '../../src/builds/queue.js';
import {
  BuildCapacitySaturatedError,
  runBuildSolveJob,
  startBuildQueueRunner,
} from '../../src/builds/queue-runner.js';
import { reapStaleBuilds } from '../../src/builds/reaper.js';
import {
  persistOutcome,
  recordSolveOutcome,
  requestCancellation,
  runQueuedBuild,
  submitBuild,
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
import { CHANGE_LIMIT, FRESH, stalenessWire } from '../../src/builds/constituent-diff.js';
import { buildStaleness, compareConstituents } from '../../src/builds/staleness.js';
import { staffingAdvisoryLockKey } from '../../src/catalogue/staffing-set-version.js';
import { openQueuePoolRegistry } from '../../src/db/queue-pools.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { assembleCanonicalInput } from '../../src/solver/canonical-input.js';
import { adminClient } from '../support/admin-client.js';
import { seedBuildFixture, syntheticOutcome, type BuildFixture } from '../support/builds.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { seedRulesForSweep } from '../support/rules.js';
import { fixtureInstant, grantScheduleCapabilities, scheduleActor } from '../support/schedule.js';
import { seedLocationsForSweep } from '../support/settings.js';
import { setRequirement } from '../../src/schedule/service.js';
import { applySolverEnv } from '../support/solver.js';

/**
 * **THE CONCURRENCY-AND-RECOVERY MATRIX** — doc 35 §6g Included (B), one named
 * proof per row, every outcome asserted in the DATABASE.
 *
 * ## What this file is for, and what it deliberately is not
 *
 * M4-003 proved the lifecycle's controls exist. This file asks a different
 * question of every one of them: **what happens when two things happen at
 * once, or when a process disappears in the middle.** Those are not the same
 * question, and a control that holds sequentially and fails under a race is the
 * defect class every one of these rows exists to catch — `stale-edit-cas`'s red
 * case records the shape: "removing the lock leaves two concurrent writers
 * reading the same pre-state, both finding their token current, and both
 * writing. That is invisible to any test that does not actually race."
 *
 * So every race here is a REAL race on independent pooled connections, released
 * together, and asserted on the OUTCOME SET rather than on which side won.
 *
 * ## The queued path is re-proved, not assumed (doc 35 §6g Required behaviour 4)
 *
 * D-4b moved dispatch from the API process to a `build.solve` worker task. Every
 * property M4-003 proved — the claim, the epoch, the fence, the reaper, the
 * honest outcome vocabulary — is the same code called from a different process,
 * and "the same code" is exactly the kind of claim that is true until it is not.
 * §2 re-drives each of them THROUGH the task body.
 *
 * ## Staleness (§3) is the packet's absolute rule
 *
 * > A build whose ANY input revision changed after snapshot assembly is visibly
 * > STALE and can NEVER silently become the current draft.
 *
 * One arm per input class, and each one moves a DIFFERENT constituent so that a
 * staleness check which only ever noticed one kind would fail seven of them.
 * The red arm — "and the same flow WITHOUT the change reaches the draft" — is
 * the mutation control that keeps the other eight from being vacuous.
 */

const multi = ownedMulti('builds-matrix', {
  profile: 'full',
  seed: { catalogue: ['alpha', 'beta'], schedule: true, scheduleCredentials: true },
});

let runtime: Runtime;
let worker: Runtime;
let admin: Awaited<ReturnType<typeof openAdmin>>;
let restoreSolverEnv: () => void;

let shiftTypeId: string;
let schedulerUserId: string;
let schedulerMembershipId: string;
let organizationId: string;
let groupId: string;

/** 2044-01-04, the Monday every window in this file is measured from. */
const WINDOW_ORIGIN = Date.UTC(2044, 0, 4);
let sequence = -1;

/**
 * Each fixture takes its own week, a fortnight apart — D-2 refuses overlapping
 * periods in one group, and the stride leaves a clear week between every pair so
 * an off-by-one cannot silently produce a touching one (lifecycle.test.ts's
 * lesson, restated because this file seeds far more periods than that one).
 */
function nextWindow(): { startDate: string; endDate: string } {
  sequence += 1;
  const start = new Date(WINDOW_ORIGIN + sequence * 14 * 86_400_000);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

async function openAdmin() {
  const client = adminClient();
  await client.connect();
  return client;
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 10 });
  worker = createRuntime('app_worker', { max: 4 });
  admin = await openAdmin();
  restoreSolverEnv = applySolverEnv();

  const alpha = multi().alpha;
  const catalogue = multi.catalogue('alpha');
  const type = catalogue.shiftTypeIds[1];
  if (type === undefined) throw new Error('the alpha catalogue seed produced no shift type');
  shiftTypeId = type;
  organizationId = alpha.organizationId;
  groupId = alpha.groupOne.id;
  schedulerUserId = alpha.users.scheduler.id;
  schedulerMembershipId = alpha.users.scheduler.membershipId;

  /* ── the capabilities the §3 arms legitimately hold ────────────────────────
   *
   * The guards on the constituent tables are DATABASE triggers and they fire for
   * every writer. Granting these four through the product's own SPEC-06 L4
   * mechanism, under an organization-scoped context, is how a scheduler would
   * actually come to hold them. Nothing is bypassed and no trigger is suspended:
   * §3's arms are written as a person with these capabilities.
   *
   * Granted BEFORE the seeders, so `seedLocationsForSweep` does not have to open
   * a temporary grant of its own — two grants of one capability to one
   * membership collide on `capability_grants_no_overlapping_window`, which is
   * the exclusion constraint doing its job. */
  /* Each capability, checked and then granted through the product's own SPEC-06
   * L4 path. Two details are the fixture meeting controls rather than working
   * around them:
   *
   *  * a live grant that is already `granted = true` is LEFT ALONE — regranting
   *    would collide with `capability_grants_no_overlapping_window`, an
   *    exclusion constraint doing exactly its job;
   *  * a live grant that is `granted = false` — the fixture's deliberate DENY
   *    rows — is CLOSED first, by the organization administrator, before the
   *    allow is written. Closing a window and opening a new one is the product's
   *    own way to change a grant; writing an overlapping row is not, and the
   *    constraint says so. This is disclosed rather than quiet: within THIS
   *    file's owned fixture the scheduler ends up holding four capabilities it
   *    does not hold elsewhere, which is the point.
   */
  const orgAdminMembershipId = alpha.users.organizationAdmin.membershipId;
  for (const capability of [
    'schedule.catalogue.administer',
    'staffing.qualification.administer',
    'staffing.qualification_holding.administer',
    'group.location.administer',
  ]) {
    const live = await admin.query<{ id: string; granted: boolean }>(
      `select id, granted from capability_grants
        where organization_id = $1 and membership_id = $2 and capability_key = $3
          and (valid_to is null or valid_to > now())`,
      [organizationId, schedulerMembershipId, capability],
    );
    if (live.rows.some((row) => row.granted)) continue;

    if (live.rows.length > 0) {
      await runtime.runner.run(
        {
          organizationId,
          groupId: null,
          membershipId: orgAdminMembershipId,
          correlationId: 'matrix-grant-close',
        },
        async (uow) => {
          await sql`
            update capability_grants set valid_to = now(), updated_at = now()
             where organization_id = ${organizationId}::uuid
               and membership_id = ${schedulerMembershipId}::uuid
               and capability_key = ${capability}
               and valid_to is null
          `.execute(uow.query);
        },
      );
    }

    await grantScheduleCapabilities(runtime.runner, multi(), {
      organizationId,
      groupId,
      membershipId: schedulerMembershipId,
      capabilities: [capability],
    });
  }

  /* ── the inputs the staleness arms move must EXIST ─────────────────────────
   *
   * §3 has one arm per input class, and an arm whose table is empty passes its
   * mutation vacuously — `bumpConstituent` throws on a zero-row update precisely
   * so that cannot happen silently, and the fixture is what stops it happening
   * at all. Both seeders go through the production write path under the
   * capability-holding context, exactly as the sweep fixtures do. */
  await seedRulesForSweep(runtime.runner, [
    { organizationId, groupId, membershipId: schedulerMembershipId, label: 'matrix' },
  ]);
  await seedLocationsForSweep(runtime.runner, [
    { organizationId, groupId, membershipId: schedulerMembershipId, label: 'matrix' },
  ]);
}, 240_000);

afterAll(async () => {
  restoreSolverEnv?.();
  await runtime?.destroy();
  await worker?.destroy();
  await admin?.end();
});

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers — every one of them drives the PRODUCTION path
 * ──────────────────────────────────────────────────────────────────────────── */

function contextFor(labelSuffix: string) {
  return {
    organizationId,
    groupId,
    membershipId: schedulerMembershipId,
    correlationId: `matrix-${labelSuffix}`,
  };
}

const actor = () => scheduleActor(schedulerUserId);

async function run<T>(fn: (uow: PgUnitOfWork) => Promise<T>, label = 'x'): Promise<T> {
  return runtime.runner.run(contextFor(label), fn);
}

interface SeededRun {
  readonly fixture: BuildFixture;
  readonly buildRunId: string;
  readonly startDate: string;
  readonly endDate: string;
}

/** A period, a requirement, a draft, a configuration, and a `draft_configuration` run. */
async function seedRun(label: string, options: { heartbeatTimeoutMs?: number } = {}): Promise<SeededRun> {
  const window = nextWindow();
  const fixture = await seedBuildFixture(runtime.runner, {
    organizationId,
    groupId,
    membershipId: schedulerMembershipId,
    userId: schedulerUserId,
    shiftTypeId,
    label,
    ...window,
  });
  if (options.heartbeatTimeoutMs !== undefined) {
    await run(async (uow) => {
      await uow.query
        .updateTable('build_configurations')
        .set({ heartbeat_timeout_ms: options.heartbeatTimeoutMs })
        .where('id', '=', fixture.configurationId)
        .execute();
    }, label);
  }
  const created = await run(
    async (uow) =>
      createRun(uow, actor(), {
        configurationId: fixture.configurationId,
        sourceVersionId: fixture.versionId,
        candidateLabel: `matrix-${label}`,
        idempotencyKey: `matrix.${label}.${randomUUID().slice(0, 8)}`,
      }),
    label,
  );
  return { fixture, buildRunId: created.buildRunId, ...window };
}

/** Submit through the production runner. Returns the state it settled in. */
async function submit(seeded: SeededRun, label: string): Promise<string> {
  const result = await submitBuild(
    runtime.runner,
    contextFor(label),
    actor(),
    seeded.buildRunId,
    'draft_configuration',
  );
  return result.state;
}

/** The three transitions to `queued` WITHOUT the assembly — for arms about the claim. */
async function queueDirectly(buildRunId: string, label: string): Promise<void> {
  await run(async (uow) => {
    const row = await loadRun(uow, buildRunId);
    if (row === null) throw new Error('the seeded run vanished');
    const validating = await transitionRun(uow, row, 'validating', { reason: 'submitted' });
    const checking = await transitionRun(uow, validating, 'readiness_check', {
      reason: 'configuration_consistent',
    });
    await transitionRun(uow, checking, 'queued', { reason: 'ready' });
  }, label);
}

const CLEAN_VERDICT = {
  usable: true,
  rejections: [],
  findings: [],
  hardViolations: 0,
} as const;

/** Claim, then write a clean synthetic result — the shape `persistOutcome` accepts. */
async function claimAndComplete(
  seeded: SeededRun,
  label: string,
  document: SolverInputSnapshotDocument,
): Promise<{ claimEpoch: number; state: string }> {
  return run(async (uow) => {
    const claim = await claimQueuedBuild(uow, seeded.buildRunId, workerToken('matrix'));
    if (claim === null) throw new Error('the seeded run could not be claimed');
    const configuration = await readConfiguration(uow, seeded.fixture.configurationId);
    if (configuration === null) throw new Error('the configuration vanished');
    const state = await persistOutcome(uow, {
      buildRunId: seeded.buildRunId,
      claimEpoch: claim.claimEpoch,
      document,
      outcome: syntheticOutcome(
        claim.run.canonical_input_hash ?? 'f'.repeat(64),
        schedulerMembershipId,
        seeded.fixture.periodId === '' ? '2044-01-04' : documentFirstDate(document),
        shiftTypeId,
      ),
      verdict: CLEAN_VERDICT,
      configuration,
    });
    return { claimEpoch: claim.claimEpoch, state };
  }, label);
}

function documentFirstDate(document: SolverInputSnapshotDocument): string {
  return document.startDate;
}

/** Submit → claim → complete → reviewed → approved, entirely through production code. */
async function buildToApproved(label: string): Promise<SeededRun> {
  const seeded = await seedRun(label);
  const state = await submit(seeded, label);
  expect(state, `${label}: the fixture did not queue`).toBe('queued');

  const document = await run(async (uow) => {
    const row = await loadRun(uow, seeded.buildRunId);
    if (row?.snapshot_id == null) throw new Error('the queued run pinned no snapshot');
    const assembled = await assembleCanonicalInput(uow, {
      periodId: row.period_id,
      versionId: row.source_version_id,
      at: new Date(),
    });
    return assembled.document;
  }, label);

  await claimAndComplete(seeded, label, document);

  await run(async (uow) => {
    const row = await loadRun(uow, seeded.buildRunId);
    if (row === null) throw new Error('the run vanished');
    await markReviewed(uow, actor(), seeded.buildRunId, row.state);
    await approveRun(uow, actor(), seeded.buildRunId, 'reviewed');
  }, label);

  const approved = await run(async (uow) => loadRun(uow, seeded.buildRunId), label);
  expect(approved?.state, `${label}: the fixture did not reach approved`).toBe('approved');
  return seeded;
}

async function stateOf(buildRunId: string): Promise<BuildRunRow | null> {
  return run(async (uow) => loadRun(uow, buildRunId), 'read');
}

async function eventKinds(buildRunId: string): Promise<string[]> {
  return run(async (uow) => {
    const rows = await uow.query
      .selectFrom('build_run_events')
      .select(['kind', 'reason'])
      .where('build_run_id', '=', buildRunId)
      .orderBy('occurred_at')
      .execute();
    return rows.map((r) => `${r.kind}:${r.reason ?? ''}`);
  }, 'events');
}

/**
 * Move a constituent's revision, **under the capability-holding context**.
 *
 * Not as the owner, and not with a trigger suspended. Every one of these tables
 * carries a `app_require_capability` guard that fires for every writer, and the
 * arms below are written as a scheduler who legitimately holds the four
 * capabilities `beforeAll` grants through SPEC-06 L4 — which is how a person
 * would actually move these rows.
 *
 * The edit is `updated_at`, and that is not a shortcut — it is the only honest
 * one available. The revision counters are DATABASE-OWNED: no application role
 * holds an `UPDATE` grant on `version`, which is precisely what makes citing one
 * meaningful rather than advisory (0016's header). They move through
 * `app_maintain_catalogue_version`, whose own comment says "unconditional — a
 * no-op UPDATE still bumps, because a writer that read version N and wrote
 * nothing still has to lose to a writer that read N and wrote something". So an
 * ordinary granted write is exactly how a revision moves in production, and it
 * is what these arms perform.
 *
 * A zero-row update THROWS. An arm whose mutation matched nothing would go on to
 * assert staleness against a world that had not changed, and would fail for the
 * right-looking reason — or, worse, pass if the comparison were broken in the
 * other direction.
 */
async function bumpConstituent(
  label: string,
  statement: (uow: PgUnitOfWork) => Promise<number>,
): Promise<void> {
  const affected = await runtime.runner.run(contextFor(label), statement);
  if (affected === 0) {
    throw new Error(`${label}: the staleness mutation matched no row — the arm would be vacuous`);
  }
}

/** `numAffectedRows` as a plain number, for the arms above. */
function affected(result: { numAffectedRows?: bigint }): number {
  return Number(result.numAffectedRows ?? 0n);
}

/**
 * Set a membership's status through an ORGANIZATION-scoped context.
 *
 * `organization.membership.administer` is an organization capability held by the
 * `org_admin` role, and the guard on `memberships` is a database trigger. So the
 * change is made by the organization administrator under an organization-scoped
 * unit of work — which is who would make it — rather than by suspending a guard.
 */
async function setMembershipStatus(membershipId: string, status: string): Promise<void> {
  const admins = multi().alpha.users.organizationAdmin;
  const changed = await runtime.runner.run(
    {
      organizationId,
      groupId: null,
      membershipId: admins.membershipId,
      correlationId: 'matrix-membership',
    },
    async (uow) =>
      Number(
        (
          await sql`
            update memberships set status = ${status}, updated_at = now()
             where organization_id = ${organizationId}::uuid and id = ${membershipId}::uuid
          `.execute(uow.query)
        ).numAffectedRows ?? 0n,
      ),
  );
  if (changed === 0) throw new Error('the membership status change matched no row');
}

/** Jobs the queue is holding for one build, by task name. */
async function solveJobsFor(buildRunId: string): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    `select count(*)::text as n
       from graphile_worker._private_jobs j
       join graphile_worker._private_tasks t on t.id = j.task_id
      where t.identifier = $1
        and j.payload->>'buildRunId' = $2`,
    [BUILD_SOLVE_TASK, buildRunId],
  );
  return Number(rows[0]?.n ?? '-1');
}

/* ════════════════════════════════════════════════════════════════════════════
 * 1. SUBMISSION AND IDEMPOTENCY
 * ════════════════════════════════════════════════════════════════════════════ */

describe('M-01 simultaneous submission', () => {
  it('two schedulers submitting ONE build produce exactly one queued run and one job', async () => {
    const seeded = await seedRun('m01');

    /* Both attempts declare the same `expectedState`, which is what a pair of
     * open tabs actually does. Released together on independent pooled
     * connections; asserted on the OUTCOME SET, never on which one won. */
    const attempt = (n: number) =>
      submitBuild(
        runtime.runner,
        contextFor(`m01-${String(n)}`),
        actor(),
        seeded.buildRunId,
        'draft_configuration',
      );
    const outcomes = await Promise.allSettled([attempt(1), attempt(2)]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BuildStateMovedError);

    const row = await stateOf(seeded.buildRunId);
    expect(row?.state).toBe('queued');
    /* The DB assertion that matters: the loser did not also enqueue. A second
     * job would mean a second claim attempt and a second solve of one problem —
     * the cost D-4a exists to prevent, arriving through a different door. */
    expect(await solveJobsFor(seeded.buildRunId)).toBe(1);
  });
});

describe('M-02 idempotent retry', () => {
  it('twelve concurrent creations with ONE key produce exactly one row (D-17)', async () => {
    const window = nextWindow();
    const fixture = await seedBuildFixture(runtime.runner, {
      organizationId,
      groupId,
      membershipId: schedulerMembershipId,
      userId: schedulerUserId,
      shiftTypeId,
      label: 'm02',
      ...window,
    });
    const key = `matrix.m02.${randomUUID().slice(0, 8)}`;
    const attempt = () =>
      runtime.runner.run(contextFor('m02'), async (uow) =>
        createRun(uow, actor(), {
          configurationId: fixture.configurationId,
          sourceVersionId: fixture.versionId,
          candidateLabel: 'matrix-m02',
          idempotencyKey: key,
        }),
      );

    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, attempt));
    const ids = new Set(
      outcomes.flatMap((o) => (o.status === 'fulfilled' ? [o.value.buildRunId] : [])),
    );
    expect(ids.size, 'one key must name one build run').toBe(1);

    const { rows } = await admin.query<{ n: string }>(
      'select count(*)::text as n from build_runs where idempotency_key = $1',
      [key],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('a re-delivered build.solve job for a settled run answers not-claimable, not a second solve', async () => {
    const seeded = await seedRun('m02b');
    await submit(seeded, 'm02b');

    const payload = {
      organizationId,
      groupId,
      buildRunId: seeded.buildRunId,
      correlationId: 'matrix-m02b',
    };
    const first = await runBuildSolveJob(worker.runner, payload, { stubBehaviour: 'candidate' });
    expect(first.kind).toBe('ran');

    /* C-4. At-least-once delivery is the queue's contract, so a second delivery
     * is normal rather than exceptional. The claim epoch is the idempotency: the
     * run is no longer `queued`, so the conditional UPDATE matches no row. */
    const second = await runBuildSolveJob(worker.runner, payload, { stubBehaviour: 'candidate' });
    expect(second.kind).toBe('not-claimable');

    const results = await run(async (uow) => {
      const rows = await uow.query
        .selectFrom('build_run_results')
        .select('id')
        .where('build_run_id', '=', seeded.buildRunId)
        .execute();
      return rows.length;
    }, 'm02b');
    expect(results, 'a re-delivery must not write a second result').toBe(1);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2. THE QUEUED PATH RE-PROVES M4-003's CONTROLS
 * ════════════════════════════════════════════════════════════════════════════ */

describe('M-03/M-04 duplicate and stale worker results, through the QUEUED path', () => {
  it('a duplicate result at the CURRENT epoch is refused by the database, service bypassed', async () => {
    const seeded = await seedRun('m03');
    await submit(seeded, 'm03');
    const ran = await runBuildSolveJob(
      worker.runner,
      { organizationId, groupId, buildRunId: seeded.buildRunId, correlationId: 'matrix-m03' },
      { stubBehaviour: 'candidate' },
    );
    expect(ran.kind).toBe('ran');

    const row = await stateOf(seeded.buildRunId);
    /* Raw SQL as the OWNER, past every grant and past the service entirely. The
     * settled-run clause of `app_guard_build_result_fencing` is the only thing
     * left, and it is what must refuse. */
    await expect(
      admin.query(
        `insert into build_run_results
           (organization_id, group_id, build_run_id, claim_epoch, solver_status,
            termination_reason, reported_input_hash, usable, hard_violations,
            assignment_count, candidate_returned, elapsed_ms)
         values ($1,$2,$3,$4,'FEASIBLE','completed',$5,false,0,0,false,1)`,
        [organizationId, groupId, seeded.buildRunId, row?.claim_epoch ?? 0, 'f'.repeat(64)],
      ),
    ).rejects.toThrow(/BUILD_RESULT/);

    const results = await run(async (uow) => {
      const rows = await uow.query
        .selectFrom('build_run_results')
        .select('id')
        .where('build_run_id', '=', seeded.buildRunId)
        .execute();
      return rows.length;
    }, 'm03');
    expect(results).toBe(1);
  });

  it('a result at a SUPERSEDED epoch is refused AND recorded, on the queued path', async () => {
    const seeded = await seedRun('m04', { heartbeatTimeoutMs: 1000 });
    await queueDirectly(seeded.buildRunId, 'm04');

    const claim = await run(
      async (uow) => claimQueuedBuild(uow, seeded.buildRunId, workerToken('m04')),
      'm04',
    );
    if (claim === null) throw new Error('the run could not be claimed');

    /* The worker goes quiet. The reaper advances the epoch, which is the fence.
     * `heartbeat_at` is pushed back rather than waiting a real second: the
     * subject is the fence, not the clock. */
    await run(async (uow) => {
      await uow.query
        .updateTable('build_runs')
        .set({ heartbeat_at: new Date(Date.now() - 60_000) })
        .where('id', '=', seeded.buildRunId)
        .execute();
    }, 'm04');
    const reaped = await run(async (uow) => reapStaleBuilds(uow), 'm04');
    expect(reaped.map((r) => r.buildRunId)).toContain(seeded.buildRunId);

    const document = await run(
      async (uow) =>
        (
          await assembleCanonicalInput(uow, {
            periodId: seeded.fixture.periodId,
            versionId: seeded.fixture.versionId,
            at: new Date(),
          })
        ).document,
      'm04',
    );
    const configuration = await run(
      async (uow) => readConfiguration(uow, seeded.fixture.configurationId),
      'm04',
    );
    if (configuration === null) throw new Error('configuration vanished');

    await expect(
      recordSolveOutcome(runtime.runner, contextFor('m04'), {
        buildRunId: seeded.buildRunId,
        claimEpoch: claim.claimEpoch,
        document,
        outcome: syntheticOutcome('f'.repeat(64), schedulerMembershipId, '2044-01-04', shiftTypeId),
        verdict: CLEAN_VERDICT,
        configuration,
      }),
    ).rejects.toBeInstanceOf(BuildResultFencedError);

    /* The refusal is a ROW, not an absence. A denial that leaves no trace makes
     * a fenced worker look like a worker that never ran — and the record has to
     * survive the rollback of the transaction that refused it, which is the
     * whole reason `recordFencedResult` runs in a second transaction. */
    expect(await eventKinds(seeded.buildRunId)).toContain('result_refused:stale_claim_epoch');

    const settled = await stateOf(seeded.buildRunId);
    expect(settled?.state).toBe('failed');
    expect(settled?.termination_reason).toBe('crashed');
  });
});

describe('M-05 worker crash', () => {
  it('a dead heartbeat settles the build as failed/crashed — never deadline, never killed', async () => {
    const seeded = await seedRun('m05', { heartbeatTimeoutMs: 1000 });
    await queueDirectly(seeded.buildRunId, 'm05');
    const claim = await run(
      async (uow) => claimQueuedBuild(uow, seeded.buildRunId, workerToken('m05')),
      'm05',
    );
    if (claim === null) throw new Error('the run could not be claimed');

    await run(async (uow) => {
      await uow.query
        .updateTable('build_runs')
        .set({ heartbeat_at: new Date(Date.now() - 60_000) })
        .where('id', '=', seeded.buildRunId)
        .execute();
    }, 'm05');
    await run(async (uow) => reapStaleBuilds(uow), 'm05');

    const row = await stateOf(seeded.buildRunId);
    /* FAD-34(2). A terminated worker writes nothing, so the parent ATTRIBUTES
     * the reason, and it attributes the only one the evidence supports:
     * `deadline` would claim a wall clock was reached and `killed` would claim
     * somebody signalled it. Both would be invented evidence. */
    expect(row?.state).toBe('failed');
    expect(row?.termination_reason).toBe('crashed');
    expect(row?.claimed_by).toBeNull();
    expect(row?.claim_epoch).toBe(claim.claimEpoch + 1);
    expect(await eventKinds(seeded.buildRunId)).toContain('heartbeat_reaped:heartbeat_expired');
  });
});

describe('M-06 API/worker restart with claimed builds', () => {
  it('a pool that dies holding a lease is reclaimed by its successor (SP-D C-2)', async () => {
    /* The registry, driven directly: register a pool, stop heartbeating, and let
     * a SECOND registry sweep. `force_unlock_workers` is graphile-worker's own
     * function, so the unlock uses the library's semantics rather than an UPDATE
     * of our own against its tables. */
    const deadPoolId = `matrix-dead-${randomUUID().slice(0, 8)}`;
    const dead = await openQueuePoolRegistry({ poolId: deadPoolId, label: 'matrix-dead' });
    try {
      await dead.register();
      await admin.query(
        "update queue_pools set heartbeat_at = now() - interval '10 minutes' where pool_id = $1",
        [deadPoolId],
      );
    } finally {
      await dead.close();
    }

    const survivor = await openQueuePoolRegistry({
      poolId: `matrix-live-${randomUUID().slice(0, 8)}`,
      label: 'matrix-live',
      staleAfterMs: 1000,
    });
    try {
      const result = await survivor.reclaimStalePools();
      expect(result.reclaimedPoolIds).toContain(deadPoolId);
    } finally {
      await survivor.close();
    }

    const { rows } = await admin.query<{ released_at: Date | null }>(
      'select released_at from queue_pools where pool_id = $1',
      [deadPoolId],
    );
    expect(rows[0]?.released_at, 'a reclaimed pool is marked released').not.toBeNull();
  });

  it('a QUEUED build whose job is gone is re-delivered rather than failed', async () => {
    const seeded = await seedRun('m06b');
    await submit(seeded, 'm06b');
    expect(await solveJobsFor(seeded.buildRunId)).toBe(1);

    /* The shape a saturated organization reaches when its job exhausts its
     * attempts: the build is correct and the DELIVERY is missing. Simulated by
     * removing the job the way an operator or a queue-schema loss would. */
    await admin.query(
      `delete from graphile_worker._private_jobs j
        using graphile_worker._private_tasks t
        where t.id = j.task_id and t.identifier = $1 and j.payload->>'buildRunId' = $2`,
      [BUILD_SOLVE_TASK, seeded.buildRunId],
    );
    expect(await solveJobsFor(seeded.buildRunId)).toBe(0);

    const requeued = await run(async (uow) => requeueOrphanedQueuedBuilds(uow, 0), 'm06b');
    expect(requeued).toContain(seeded.buildRunId);
    expect(await solveJobsFor(seeded.buildRunId)).toBe(1);

    /* And the build itself is untouched. A queue problem reported as a build
     * outcome would be a system fault wearing a scheduling verdict (FAD-34). */
    const row = await stateOf(seeded.buildRunId);
    expect(row?.state).toBe('queued');
    expect(row?.termination_reason).toBeNull();
  });
});

describe('M-07/M-08/M-09 cancellation, timeout, and a result that arrives afterwards', () => {
  it('M-07: a cancel during a RUNNING solve is requested, not asserted — and lands as CANCELLED', async () => {
    const seeded = await seedRun('m07');
    await submit(seeded, 'm07');

    /* The real subprocess, dwelling, with the cancellation delivered through the
     * shipped file channel (SPEC-04 §2 mechanism 2 — the watcher thread, never a
     * signal). The dispatch and the cancel run CONCURRENTLY on independent
     * connections; a sequential version of this test cannot distinguish
     * "cancellation worked" from "the solve had already finished". */
    const solving = runQueuedBuild(runtime.runner, contextFor('m07'), seeded.buildRunId, {
      stubBehaviour: 'dwell',
      stubDwellMs: 4000,
      timeoutMs: 30_000,
    });

    // Wait for the claim to be visible before cancelling: cancelling a build
    // that has not been claimed is M-07's sibling, not M-07.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const row = await stateOf(seeded.buildRunId);
      if (row?.state === 'running') break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const cancel = await run(
      async (uow) => requestCancellation(uow, actor(), seeded.buildRunId, 'running'),
      'm07',
    );
    /* The state does NOT move here, and that is the honesty: moving it now would
     * be a claim the system has not earned, and a solve that then completed
     * normally would look cancelled. */
    expect(cancel.immediate).toBe(false);
    expect(cancel.state).toBe('running');

    const dispatch = await solving;
    expect(dispatch.kind).toBe('ran');

    const row = await stateOf(seeded.buildRunId);
    expect(row?.state).toBe('cancelled');
    expect(row?.termination_reason).toBe('user_cancelled');
    expect(row?.solver_status).toBe('CANCELLED');
    expect(await eventKinds(seeded.buildRunId)).toContain('cancel_requested:scheduler_cancelled');
  }, 90_000);

  it('M-08: a solve that outruns its wall clock is TERMINATED and says so — never a completion', async () => {
    const seeded = await seedRun('m08');
    await submit(seeded, 'm08');

    const dispatch = await runQueuedBuild(runtime.runner, contextFor('m08'), seeded.buildRunId, {
      stubBehaviour: 'wedged',
      timeoutMs: 1200,
    });
    expect(dispatch.kind).toBe('ran');

    const row = await stateOf(seeded.buildRunId);
    expect(row?.state).toBe('failed');
    /* `killed`, and the word is the finding rather than a detail. SPEC-04 §2
     * layers three mechanisms and they report DIFFERENT reasons: mechanism 1 is
     * the solver's own deadline and reports `deadline`; mechanism 3 is the
     * parent terminating a subprocess that did not return, and reports `killed`.
     * A wedged solve never reaches its own deadline — that is what wedged means
     * — so `deadline` here would be the parent claiming the solver did something
     * it did not do. FAD-34's whole point is that the four words stay four.
     * Mechanism 1's `deadline` has its own proof in
     * `apps/api/test/solver/worker-lifecycle.test.ts`. */
    expect(row?.termination_reason).toBe('killed');
    expect(row?.state).not.toBe('completed');
    expect(row?.solver_status).not.toBe('FEASIBLE');
  }, 90_000);

  it('M-09: a result arriving AFTER a cancellation is refused and recorded', async () => {
    const seeded = await seedRun('m09');
    await queueDirectly(seeded.buildRunId, 'm09');
    const claim = await run(
      async (uow) => claimQueuedBuild(uow, seeded.buildRunId, workerToken('m09')),
      'm09',
    );
    if (claim === null) throw new Error('the run could not be claimed');

    /* The build is cancelled through the reaper's fence rather than by hand: the
     * point is a run that has SETTLED while a worker was still solving. */
    await run(async (uow) => {
      await uow.query
        .updateTable('build_runs')
        .set({ heartbeat_at: new Date(Date.now() - 60_000) })
        .where('id', '=', seeded.buildRunId)
        .execute();
    }, 'm09');
    await run(async (uow) => reapStaleBuilds(uow), 'm09');

    const document = await run(
      async (uow) =>
        (
          await assembleCanonicalInput(uow, {
            periodId: seeded.fixture.periodId,
            versionId: seeded.fixture.versionId,
            at: new Date(),
          })
        ).document,
      'm09',
    );
    const configuration = await run(
      async (uow) => readConfiguration(uow, seeded.fixture.configurationId),
      'm09',
    );
    if (configuration === null) throw new Error('configuration vanished');

    await expect(
      recordSolveOutcome(runtime.runner, contextFor('m09'), {
        buildRunId: seeded.buildRunId,
        claimEpoch: claim.claimEpoch,
        document,
        outcome: syntheticOutcome('f'.repeat(64), schedulerMembershipId, '2044-01-04', shiftTypeId),
        verdict: CLEAN_VERDICT,
        configuration,
      }),
    ).rejects.toBeInstanceOf(BuildResultFencedError);

    const candidates = await run(async (uow) => {
      const rows = await uow.query
        .selectFrom('build_run_candidate_assignments')
        .select('id')
        .where('build_run_id', '=', seeded.buildRunId)
        .execute();
      return rows.length;
    }, 'm09');
    expect(candidates, 'a settled build must not acquire a candidate afterwards').toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. STALENESS — doc 35 §6g ruling 4, one arm per input class
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Move one input, then require BOTH halves: the verdict names the kind that
 * moved, and the selection refuses. Asserting only the verdict would prove a
 * reporter; asserting only the refusal would not say WHICH input class it can
 * see.
 */
async function expectStaleAfter(
  label: string,
  kind: string,
  mutate: (seeded: SeededRun) => Promise<void>,
): Promise<void> {
  const seeded = await buildToApproved(label);

  const before = await run(async (uow) => {
    const row = await loadRun(uow, seeded.buildRunId);
    if (row === null) throw new Error('run vanished');
    return buildStaleness(uow, row);
  }, label);
  expect(before.stale, `${label}: the build was already stale before the change`).toBe(false);

  await mutate(seeded);

  const after = await run(async (uow) => {
    const row = await loadRun(uow, seeded.buildRunId);
    if (row === null) throw new Error('run vanished');
    return buildStaleness(uow, row);
  }, label);
  expect(after.stale, `${label}: moving a ${kind} did not register as staleness`).toBe(true);
  if (after.assemblyRefusals.length === 0) {
    expect(
      after.changes.map((c) => c.kind),
      `${label}: the change list does not name a ${kind}`,
    ).toContain(kind);
  }

  const digest = await run(async (uow) => {
    const row = await loadRun(uow, seeded.buildRunId);
    if (row === null) throw new Error('run vanished');
    return sourceDigestOf(uow, row);
  }, label);

  await expect(
    run(
      async (uow) =>
        applyCandidateToNewDraft(uow, actor(), seeded.buildRunId, 'approved', digest),
      label,
    ),
  ).rejects.toBeInstanceOf(BuildInputsMovedError);

  /* Never SILENTLY current: the run is still `approved`, no draft was created,
   * and `applied_to_version_id` is untouched. A refusal that had already written
   * the draft would satisfy a naive "it threw" assertion. */
  const row = await stateOf(seeded.buildRunId);
  expect(row?.state).toBe('approved');
  expect(row?.applied_to_version_id).toBeNull();
}

describe('M-10..M-17 every input-revision-changed-after-assembly class', () => {
  it('MUTATION CONTROL: with NOTHING changed, the identical flow reaches a new draft', async () => {
    /* Without this arm the eight below prove only that something refuses. This
     * is the same fixture, the same helper, the same selection call — and it
     * succeeds. It is what makes each refusal attributable to the change. */
    const seeded = await buildToApproved('m10-control');
    const digest = await run(async (uow) => {
      const row = await loadRun(uow, seeded.buildRunId);
      if (row === null) throw new Error('run vanished');
      return sourceDigestOf(uow, row);
    }, 'm10-control');

    const applied = await run(
      async (uow) =>
        applyCandidateToNewDraft(uow, actor(), seeded.buildRunId, 'approved', digest),
      'm10-control',
    );
    expect(applied.draftVersionId).toBeTruthy();

    const row = await stateOf(seeded.buildRunId);
    expect(row?.state).toBe('applied_to_draft_schedule');
  }, 60_000);

  it('M-10 rules', async () => {
    await expectStaleAfter('m10', 'rule', async () => {
      await bumpConstituent('m10', async (uow) =>
        affected(
          await sql`
            update rules set updated_at = now()
             where organization_id = ${organizationId}::uuid and group_id = ${groupId}::uuid
          `.execute(uow.query),
        ),
      );
    });
  }, 60_000);

  it('M-11 catalogue (shift type)', async () => {
    await expectStaleAfter('m11', 'shiftType', async () => {
      await bumpConstituent('m11', async (uow) =>
        affected(
          await sql`
            update shift_types set updated_at = now()
             where organization_id = ${organizationId}::uuid and id = ${shiftTypeId}::uuid
          `.execute(uow.query),
        ),
      );
    });
  }, 60_000);

  it('M-12 locations', async () => {
    await expectStaleAfter('m12', 'location', async () => {
      await bumpConstituent('m12', async (uow) =>
        affected(
          await sql`
            update locations set updated_at = now()
             where organization_id = ${organizationId}::uuid and group_id = ${groupId}::uuid
          `.execute(uow.query),
        ),
      );
    });
  }, 60_000);

  it('M-13 qualifications', async () => {
    await expectStaleAfter('m13', 'qualification', async () => {
      await bumpConstituent('m13', async (uow) =>
        affected(
          await sql`
            update qualifications set updated_at = now()
             where organization_id = ${organizationId}::uuid
          `.execute(uow.query),
        ),
      );
    });
  }, 60_000);

  it('M-14 qualification holdings (profiles)', async () => {
    await expectStaleAfter('m14', 'qualificationHolding', async () => {
      /* `updated_at = now()` alone is REFUSED here — 0004's holding guard rejects
       * `valid -> valid` — so the move is a real lifecycle step a person takes:
       * a live credential entering its expiry window. That the guard refused the
       * lazy version is the control working, and it is why this arm is spelled
       * differently from its six siblings. */
      await bumpConstituent('m14', async (uow) =>
        affected(
          await sql`
            update qualification_holdings set status = 'expiring', updated_at = now()
             where organization_id = ${organizationId}::uuid and status = 'valid'
          `.execute(uow.query),
        ),
      );
    });
  }, 60_000);

  it('M-15 demand (period requirements)', async () => {
    await expectStaleAfter('m15', 'requirement', async (seeded) => {
      /* Through the production editor, never a hand-written counter bump. The
       * requirement version is an aggregate counter `acquireStaffingSet` owns,
       * and an arm that moved it by hand would prove the comparison notices a
       * number no code path can produce. */
      await run(async (uow) => {
        await setRequirement(uow, actor(), {
          periodId: seeded.fixture.periodId,
          date: seeded.startDate,
          shiftTypeId,
          requiredCount: 2,
        });
      }, 'm15');
    });
  }, 60_000);

  it('M-16 timezone basis', async () => {
    await expectStaleAfter('m16', 'timezoneBasis', async (seeded) => {
      /* The group's interpretation of local time changes. Every instant in the
       * period was derived under the old zone, so a candidate applied afterwards
       * carries times nobody authored — 0014's basis columns exist for exactly
       * this, and `timezone-basis-stale-gate`'s red case is its publication-side
       * sibling. */
      await bumpConstituent('m16', async (uow) =>
        affected(
          await sql`
            update schedule_versions set timezone_basis = 'America/Toronto'
             where organization_id = ${organizationId}::uuid
               and group_id = ${groupId}::uuid
               and id = ${seeded.fixture.versionId}::uuid
          `.execute(uow.query),
        ),
      );
    });
  }, 60_000);

  it('M-17 participants (staff group membership)', async () => {
    await expectStaleAfter('m17', 'staffGroup', async () => {
      await bumpConstituent('m17', async (uow) =>
        affected(
          await sql`
            update staff_groups set updated_at = now()
             where organization_id = ${organizationId}::uuid and group_id = ${groupId}::uuid
          `.execute(uow.query),
        ),
      );
    });
  }, 60_000);
});

describe('M-18 participant inactivation before acceptance', () => {
  it('an inactivated participant makes the inputs UNASSEMBLABLE, and selection refuses', async () => {
    const seeded = await buildToApproved('m18');
    const spare = multi().alpha.users.member.membershipId;

    await setMembershipStatus(spare, 'suspended');

    try {
      const verdict = await run(async (uow) => {
        const row = await loadRun(uow, seeded.buildRunId);
        if (row === null) throw new Error('run vanished');
        return buildStaleness(uow, row);
      }, 'm18');
      expect(verdict.stale).toBe(true);

      const digest = await run(async (uow) => {
        const row = await loadRun(uow, seeded.buildRunId);
        if (row === null) throw new Error('run vanished');
        return sourceDigestOf(uow, row);
      }, 'm18');
      await expect(
        run(
          async (uow) =>
            applyCandidateToNewDraft(uow, actor(), seeded.buildRunId, 'approved', digest),
          'm18',
        ),
      ).rejects.toBeInstanceOf(BuildInputsMovedError);
    } finally {
      /* Restored, because every later arm in this file assembles the same
       * group's inputs and a suspended member would make all of them refuse for
       * a reason that has nothing to do with what they are proving. */
      await setMembershipStatus(spare, 'active');
    }
  }, 60_000);
});

describe('the staleness comparison itself', () => {
  it('sees all THREE directions, including the added one a naive check misses', () => {
    const pinned = [
      { kind: 'rule' as const, key: 'r.one', revision: '3' },
      { kind: 'rule' as const, key: 'r.gone', revision: '1' },
    ];
    const current = [
      { kind: 'rule' as const, key: 'r.one', revision: '4' },
      { kind: 'requirement' as const, key: 'q.new', revision: '9' },
    ];
    const { changes, changeCount } = compareConstituents(pinned, current);
    expect(changeCount).toBe(3);
    expect(changes.map((c) => `${c.kind}:${c.key}:${c.direction}`).sort()).toEqual([
      'requirement:q.new:added',
      'rule:r.gone:removed',
      'rule:r.one:moved',
    ]);
  });

  it('MUTATION CONTROL: identical lists produce no change at all', () => {
    const list = [{ kind: 'rule' as const, key: 'r.one', revision: '3' }];
    expect(compareConstituents(list, list).changeCount).toBe(0);
  });

  /**
   * **FAD-50 C-4 — the WIRE carries the class, never the row.**
   *
   * The computation above is sanctioned and unchanged: an enforcement gate reads
   * the truth rather than the caller's visibility (FAD-29), or a build would be
   * declared fresh because the reader cannot see the thing that moved.
   *
   * What was wrong was the DISCLOSURE. `constituents` stores `(kind, key,
   * revision)`, and for the `qualificationHolding` class the key is the holding
   * row's surrogate id — a `SENSITIVE-PII` record behind the grant-only
   * `staffing.qualification_holding.read`. The detail GET put that list on the
   * wire for anyone who could read the build, and the selection refusal did the
   * same. `stalenessWire` is the projection; these arms are what stop it being
   * quietly widened again.
   */
  describe('C-4: the staleness projection discloses class, direction and count', () => {
    const pinned = [
      { kind: 'qualificationHolding' as const, key: 'holding-aaa', revision: '1' },
      { kind: 'qualificationHolding' as const, key: 'holding-bbb', revision: '1' },
      { kind: 'rule' as const, key: 'r.one', revision: '3' },
    ];
    const current = [
      { kind: 'qualificationHolding' as const, key: 'holding-aaa', revision: '2' },
      { kind: 'qualificationHolding' as const, key: 'holding-ccc', revision: '1' },
      { kind: 'rule' as const, key: 'r.one', revision: '3' },
    ];

    it('aggregates to (class, direction, count) and keeps the true total', () => {
      const verdict = { ...compareConstituents(pinned, current), stale: true, assemblyRefusals: [] };
      const wire = stalenessWire(verdict);

      expect(wire.stale).toBe(true);
      expect(wire.changeCount).toBe(3);
      expect(wire.changes).toEqual([
        { kind: 'qualificationHolding', direction: 'added', count: 1 },
        { kind: 'qualificationHolding', direction: 'moved', count: 1 },
        { kind: 'qualificationHolding', direction: 'removed', count: 1 },
      ]);
    });

    it('NO holding identifier and NO revision survives the projection', () => {
      /* The deny direction, stated as an absence over the whole serialized
       * payload rather than field by field — a field-by-field assertion passes
       * the day somebody adds a sixth field carrying the same thing. */
      const verdict = { ...compareConstituents(pinned, current), stale: true, assemblyRefusals: [] };
      const serialized = JSON.stringify(stalenessWire(verdict));

      for (const identifier of ['holding-aaa', 'holding-bbb', 'holding-ccc']) {
        expect(serialized, `the wire leaked ${identifier}`).not.toContain(identifier);
      }
      /* and the revisions with them — nothing anywhere consumed those */
      expect(serialized).not.toContain('pinnedRevision');
      expect(serialized).not.toContain('currentRevision');
      expect(serialized).not.toContain('"key"');
    });

    it('the CLASS still reaches the caller — this is a narrowing, not a silencing', () => {
      /* Without this, the arm above would pass against a projection that
       * reported nothing at all, and a scheduler would lose the one fact they
       * can act on: WHICH KIND of input moved under their build. */
      const wire = stalenessWire({
        ...compareConstituents(pinned, current),
        stale: true,
        assemblyRefusals: [],
      });
      expect(wire.changes.map((c) => c.kind)).toContain('qualificationHolding');
      expect(wire.changes.every((c) => c.count >= 1)).toBe(true);
    });

    it('a fresh verdict projects to a fresh wire', () => {
      const wire = stalenessWire(FRESH);
      expect(wire).toEqual({ stale: false, changes: [], changeCount: 0, assemblyRefusals: [] });
    });

    it('the aggregate is COMPLETE even when the itemised list was truncated', () => {
      /* **This arm's title was a claim its body did not make** (FAD-51 D-2). It
       * asserted `changeCount === 40` — which passed through untouched and was
       * never the field at risk — and said nothing about the per-class counts,
       * which were aggregated from the ALREADY-TRUNCATED list and so reported
       * 20. Measured before the repair: 25 changes → `changeCount: 25`, class
       * sum 20.
       *
       * The assertion that matters is the INVARIANT: the class counts sum to the
       * true total. It is stated over an over-limit fixture, because at or below
       * `CHANGE_LIMIT` the old code and the new agree and the arm would have
       * passed either way. */
      const many = Array.from({ length: 40 }, (_, i) => ({
        kind: 'qualificationHolding' as const,
        key: `holding-${String(i)}`,
        revision: '1',
      }));
      const verdict = { ...compareConstituents(many, []), stale: true, assemblyRefusals: [] };
      const wire = stalenessWire(verdict);

      /* the fixture really is over the limit, or this proves nothing */
      expect(verdict.changes.length).toBe(CHANGE_LIMIT);
      expect(wire.changeCount).toBe(40);

      /* THE INVARIANT. */
      const classSum = wire.changes.reduce((total, entry) => total + entry.count, 0);
      expect(classSum, 'the per-class counts inherited the CHANGE_LIMIT bound').toBe(
        wire.changeCount,
      );
      expect(wire.changes).toEqual([
        { kind: 'qualificationHolding', direction: 'removed', count: 40 },
      ]);
    });

    it('the invariant holds across MANY classes over the limit, not just one', () => {
      /* A single class could be satisfied by a projection that simply echoed
       * `changeCount` into one bucket. Three classes, 45 changes, all beyond the
       * bound: the sum must still reconcile and each class must carry its own
       * true count. */
      const many = [
        ...Array.from({ length: 25 }, (_, i) => ({
          kind: 'qualificationHolding' as const,
          key: `h-${String(i)}`,
          revision: '1',
        })),
        ...Array.from({ length: 15 }, (_, i) => ({
          kind: 'rule' as const,
          key: `r-${String(i)}`,
          revision: '1',
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          kind: 'requirement' as const,
          key: `q-${String(i)}`,
          revision: '1',
        })),
      ];
      const wire = stalenessWire({
        ...compareConstituents(many, []),
        stale: true,
        assemblyRefusals: [],
      });
      expect(wire.changeCount).toBe(45);
      expect(wire.changes.reduce((total, entry) => total + entry.count, 0)).toBe(45);
      expect(wire.changes).toEqual([
        { kind: 'qualificationHolding', direction: 'removed', count: 25 },
        { kind: 'requirement', direction: 'removed', count: 5 },
        { kind: 'rule', direction: 'removed', count: 15 },
      ]);
    });
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4. SELECTION, D-4a/D-4d, AND THE COMPARE-AND-SET
 * ════════════════════════════════════════════════════════════════════════════ */

describe('M-19 two candidate-selection attempts', () => {
  it('two concurrent selections of ONE build produce one draft and one refusal', async () => {
    const seeded = await buildToApproved('m19');
    const digest = await run(async (uow) => {
      const row = await loadRun(uow, seeded.buildRunId);
      if (row === null) throw new Error('run vanished');
      return sourceDigestOf(uow, row);
    }, 'm19');

    const attempt = (n: number) =>
      runtime.runner.run(contextFor(`m19-${String(n)}`), async (uow) =>
        applyCandidateToNewDraft(uow, actor(), seeded.buildRunId, 'approved', digest),
      );
    const outcomes = await Promise.allSettled([attempt(1), attempt(2)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);

    const row = await stateOf(seeded.buildRunId);
    expect(row?.state).toBe('applied_to_draft_schedule');
    /* D-4d, in the database: one build result per version, and one version per
     * build. Two drafts would mean the loser wrote one and then failed. */
    const { rows } = await admin.query<{ n: string }>(
      'select count(*)::text as n from build_runs where applied_to_version_id is not null and id = $1',
      [seeded.buildRunId],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  }, 60_000);
});

describe('M-20 two builds per period', () => {
  it('D-4a refuses a second in-flight build of the SAME configuration', async () => {
    const seeded = await seedRun('m20a');
    await queueDirectly(seeded.buildRunId, 'm20a');

    await expect(
      run(
        async (uow) =>
          createRun(uow, actor(), {
            configurationId: seeded.fixture.configurationId,
            sourceVersionId: seeded.fixture.versionId,
            candidateLabel: 'matrix-m20a-second',
            idempotencyKey: `matrix.m20a.${randomUUID().slice(0, 8)}`,
          }),
        'm20a',
      ),
    ).rejects.toThrow();
  });

  it('D-4b admits two DIFFERENT configurations of one period concurrently', async () => {
    const seeded = await seedRun('m20b');
    await queueDirectly(seeded.buildRunId, 'm20b');

    /* The half D-4a does NOT forbid, and the half that makes D-4c's candidate
     * comparison possible at all: two configurations, one period, both in
     * flight. A cap implementation that counted per PERIOD rather than per
     * organization would refuse this and nothing else in the suite would notice. */
    const secondConfiguration = await run(async (uow) => {
      const { createConfiguration } = await import('../../src/builds/service.js');
      return createConfiguration(uow, actor(), {
        periodId: seeded.fixture.periodId,
        name: 'matrix-m20b-second',
        maxTimeSeconds: 5,
      });
    }, 'm20b');

    const second = await run(
      async (uow) =>
        createRun(uow, actor(), {
          configurationId: secondConfiguration,
          sourceVersionId: seeded.fixture.versionId,
          candidateLabel: 'matrix-m20b-second',
          idempotencyKey: `matrix.m20b2.${randomUUID().slice(0, 8)}`,
        }),
      'm20b',
    );
    await queueDirectly(second.buildRunId, 'm20b');

    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from build_runs
        where period_id = $1 and state = 'queued'`,
      [seeded.fixture.periodId],
    );
    expect(Number(rows[0]?.n)).toBe(2);
  });
});

describe('M-21 stale expected-current-version', () => {
  it('a selection quoting a stale source digest is refused, and nothing is written', async () => {
    const seeded = await buildToApproved('m21');

    await expect(
      run(
        async (uow) =>
          applyCandidateToNewDraft(uow, actor(), seeded.buildRunId, 'approved', 'b'.repeat(64)),
        'm21',
      ),
    ).rejects.toBeInstanceOf(BuildSourceMovedError);

    const row = await stateOf(seeded.buildRunId);
    expect(row?.state).toBe('approved');
    expect(row?.applied_to_version_id).toBeNull();
  }, 60_000);

  it('and the refusal is about the DRAFT moving, not merely a wrong string', async () => {
    /* The CAS has to notice a real edit, not only a fabricated digest. An
     * assignment is added to the source draft AFTER the build; the digest the
     * caller holds is now genuinely out of date. */
    const seeded = await buildToApproved('m21b');
    const digest = await run(async (uow) => {
      const row = await loadRun(uow, seeded.buildRunId);
      if (row === null) throw new Error('run vanished');
      return sourceDigestOf(uow, row);
    }, 'm21b');

    const { addManualAssignment } = await import('../../src/schedule/service.js');
    await run(async (uow) => {
      await addManualAssignment(uow, actor(), {
        versionId: seeded.fixture.versionId,
        membershipId: schedulerMembershipId,
        shiftTypeId,
        date: seeded.startDate,
        startsAt: fixtureInstant(seeded.startDate, 8),
        endsAt: fixtureInstant(seeded.startDate, 16),
      });
    }, 'm21b');

    const now = await run(async (uow) => {
      const row = await loadRun(uow, seeded.buildRunId);
      if (row === null) throw new Error('run vanished');
      return sourceDigestOf(uow, row);
    }, 'm21b');

    if (now === digest) {
      throw new Error('the source edit did not land — this arm would be vacuous');
    }
    await expect(
      run(
        async (uow) =>
          applyCandidateToNewDraft(uow, actor(), seeded.buildRunId, 'approved', digest),
        'm21b',
      ),
    ).rejects.toBeInstanceOf(BuildSourceMovedError);
  }, 60_000);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 5. WORKER OUTPUT AND EXPLANATIONS
 * ════════════════════════════════════════════════════════════════════════════ */

describe('M-23 invalid worker output', () => {
  it('a hostile worker response is REJECTED and settles failed/rejected, never completed', async () => {
    const seeded = await seedRun('m23');
    await submit(seeded, 'm23');

    const { applyHostileWorkerEnv } = await import('../support/solver.js');
    const restore = applyHostileWorkerEnv('garbage');
    try {
      const dispatch = await runQueuedBuild(runtime.runner, contextFor('m23'), seeded.buildRunId, {
        timeoutMs: 15_000,
      });
      expect(dispatch.kind).toBe('ran');
    } finally {
      restore();
    }

    const row = await stateOf(seeded.buildRunId);
    expect(row?.state).toBe('failed');
    expect(row?.state).not.toBe('completed');
    expect(row?.state).not.toBe('infeasible');

    const { rows } = await admin.query<{ usable: boolean }>(
      'select usable from build_run_results where build_run_id = $1',
      [seeded.buildRunId],
    );
    expect(rows[0]?.usable, 'an unparsable answer can never be usable').toBe(false);
  }, 90_000);
});

describe('M-24 infeasible-explanation timeout', () => {
  it('a degraded explanation leaves the build INFEASIBLE — an explanation failure is not a verdict', async () => {
    const seeded = await seedRun('m24');
    await queueDirectly(seeded.buildRunId, 'm24');

    const document = await run(
      async (uow) =>
        (
          await assembleCanonicalInput(uow, {
            periodId: seeded.fixture.periodId,
            versionId: seeded.fixture.versionId,
            at: new Date(),
          })
        ).document,
      'm24',
    );

    await run(async (uow) => {
      const claim = await claimQueuedBuild(uow, seeded.buildRunId, workerToken('m24'));
      if (claim === null) throw new Error('the run could not be claimed');
      const configuration = await readConfiguration(uow, seeded.fixture.configurationId);
      if (configuration === null) throw new Error('configuration vanished');

      const base = syntheticOutcome('f'.repeat(64), schedulerMembershipId, '2044-01-04', shiftTypeId);
      await persistOutcome(uow, {
        buildRunId: seeded.buildRunId,
        claimEpoch: claim.claimEpoch,
        document,
        outcome: {
          ...base,
          status: 'INFEASIBLE',
          terminationReason: 'completed',
          assignments: null,
          /* SPEC-04 §5's honest degraded state. The budget ran out while
           * isolating the cause — which says nothing further about the problem,
           * and must NOT read as an extra reason the period is infeasible. */
          explanation: {
            state: 'EXPLANATION_BUDGET_EXCEEDED',
            structural: [],
            conflictingRuleKeys: [],
            tier2: null,
            solveCount: 3,
            elapsedSeconds: 5,
          },
        },
        verdict: null,
        configuration,
      });
    }, 'm24');

    const row = await stateOf(seeded.buildRunId);
    /* `infeasible` is a statement about the PROBLEM and `failed` about the
     * SYSTEM (report 21 §4). An explanation budget is a system fact, and if it
     * could move the state, an engine that ran out of time explaining would
     * start reporting problems as faults. */
    expect(row?.state).toBe('infeasible');
    expect(row?.state).not.toBe('failed');

    const { rows } = await admin.query<{ explanation_state: string | null }>(
      'select explanation_state from build_run_results where build_run_id = $1',
      [seeded.buildRunId],
    );
    expect(rows[0]?.explanation_state).toBe('EXPLANATION_BUDGET_EXCEEDED');
  }, 60_000);
});

describe('M-25 progressive pin conflict', () => {
  it('a protected identity that names no assignment on the source is REFUSED, not ignored', async () => {
    const seeded = await seedRun('m25');

    /* report 21 §5's protected inputs. "I protected it" and "there was nothing
     * there" must not be the same outcome: a progressive stage whose protection
     * silently matched nothing would produce a candidate that moved an
     * assignment the scheduler had frozen. */
    await run(async (uow) => {
      await uow.query
        .updateTable('build_runs')
        .set({ protected_assignment_identities: [randomUUID()] })
        .where('id', '=', seeded.buildRunId)
        .execute();
    }, 'm25');

    const state = await submit(seeded, 'm25');
    expect(state, 'an unresolvable protection must bounce the submission').toBe(
      'draft_configuration',
    );

    const row = await stateOf(seeded.buildRunId);
    const findings = (row?.validation_findings ?? []) as { code?: string }[];
    expect(findings.length, 'the bounce must be ITEMISED, never unexplained').toBeGreaterThan(0);
  }, 60_000);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 6. D-4b — THE CAP, THE QUEUE, AND S-16t
 * ════════════════════════════════════════════════════════════════════════════ */

describe('D-4b: the capacity read', () => {
  it('the counter REFUSES an organization that is not the caller’s own', async () => {
    /* 0003's R-05 lesson. With the policy alone a foreign id matches no row and
     * the count comes back 0 — which is not an error, it is a confident
     * statement that the tenant has nothing running, and it would silently
     * disable the cap for whoever asked. */
    const foreign = multi().beta.organizationId;
    await expect(
      run(
        async (uow) =>
          sql`select app_build_running_count(${foreign}::uuid) as n`.execute(uow.query),
        'cap',
      ),
    ).rejects.toThrow(/BUILD_CAPACITY_CONTEXT_MISMATCH/);
  });

  it('the capacity POLICY is reachable by NO application role directly', async () => {
    /* The third pin promised in `roles-and-schema.test.ts`. The policy is
     * `TO app_migrator`, so `app_runtime` and `app_worker` must still see only
     * their own group — the definer function is the ONLY route across the group
     * boundary, and it returns a counter and refuses a foreign argument. */
    const other = multi().alpha.groupTwo.id;
    for (const client of [runtime, worker]) {
      const visible = await client.runner.run(
        {
          organizationId,
          groupId: other,
          membershipId: schedulerMembershipId,
          correlationId: 'cap-policy',
        },
        async (uow) => {
          const rows = await uow.query
            .selectFrom('build_runs')
            .select('id')
            .where('group_id', '=', groupId)
            .execute();
          return rows.length;
        },
      );
      expect(visible, `${client.role} saw another group's build rows directly`).toBe(0);
    }
  });

  it('the advisory-lock derivation agrees with the staffing one on a fixed vector', () => {
    /* Two implementations of the same sha-256/readBigInt64BE derivation exist,
     * for the reason `staffing-set-version.ts` records (a service must not
     * import a route). A fixed vector is what stops them drifting silently. */
    const vector = 'sp.fixed.vector|matrix';
    expect(capacityAdvisoryLockKey(vector)).toBe(staffingAdvisoryLockKey(vector));
  });

  it('the configured cap refuses a value that is not a positive integer', () => {
    expect(maxConcurrentBuildsPerOrganization({})).toBe(DEFAULT_MAX_CONCURRENT_BUILDS);
    expect(maxConcurrentBuildsPerOrganization({ [MAX_CONCURRENT_BUILDS_ENV]: '4' })).toBe(4);
    /* A fallback here would silently give a deployment that typed `four` the
     * default, with no way to discover it. */
    expect(() => maxConcurrentBuildsPerOrganization({ [MAX_CONCURRENT_BUILDS_ENV]: 'four' })).toThrow();
    expect(() => maxConcurrentBuildsPerOrganization({ [MAX_CONCURRENT_BUILDS_ENV]: '0' })).toThrow();
  });
});

describe('S-16t: a tenant at its cap QUEUES and never starves another', () => {
  it('alpha at cap defers; beta solves in the same window', async () => {
    /* The proof D-4b's ruling names. Alpha is put at a cap of ZERO occupied
     * slots by construction — one `running` build and a cap of 1 — and then a
     * second alpha build and a beta build are dispatched. Alpha's must defer
     * WITHOUT changing anything about the build; beta's must run. */
    const occupier = await seedRun('s16t-occupier');
    await queueDirectly(occupier.buildRunId, 's16t');
    await run(async (uow) => {
      const claim = await claimQueuedBuild(uow, occupier.buildRunId, workerToken('s16t'));
      if (claim === null) throw new Error('the occupier could not be claimed');
    }, 's16t');

    const running = await run(async (uow) => runningBuildCount(uow), 's16t');
    expect(running, 'the occupier must actually occupy a slot').toBeGreaterThanOrEqual(1);

    const blocked = await seedRun('s16t-blocked');
    await submit(blocked, 's16t');

    const alpha = await runQueuedBuild(runtime.runner, contextFor('s16t'), blocked.buildRunId, {
      cap: 1,
      stubBehaviour: 'candidate',
    });
    expect(alpha.kind).toBe('deferred');

    /* NOTHING about the deferred build changed. Not the state, not the epoch,
     * not an event. A deferral that spent an epoch would fence a worker that had
     * done nothing wrong. */
    const blockedRow = await stateOf(blocked.buildRunId);
    expect(blockedRow?.state).toBe('queued');
    expect(blockedRow?.claim_epoch).toBe(0);
    expect(await eventKinds(blocked.buildRunId)).not.toContain('claim:claimed');

    /* And the task body turns the deferral into the queue's own retry rather
     * than a lost request. */
    await expect(
      runBuildSolveJob(
        worker.runner,
        {
          organizationId,
          groupId,
          buildRunId: blocked.buildRunId,
          correlationId: 'matrix-s16t',
        },
        { cap: 1 },
      ),
    ).rejects.toBeInstanceOf(BuildCapacitySaturatedError);

    /* ── the other tenant, in the same window ──────────────────────────────── */
    const beta = multi().beta;
    const betaCatalogue = multi.catalogue('beta');
    const betaShiftType = betaCatalogue.shiftTypeIds[1] ?? betaCatalogue.shiftTypeIds[0];
    if (betaShiftType === undefined) throw new Error('the beta catalogue seeded no shift type');

    await grantScheduleCapabilities(runtime.runner, multi(), {
      organizationId: beta.organizationId,
      groupId: beta.groupOne.id,
      membershipId: beta.users.scheduler.membershipId,
      capabilities: ['schedule.version.edit'],
    });

    const betaWindow = nextWindow();
    const betaFixture = await seedBuildFixture(runtime.runner, {
      organizationId: beta.organizationId,
      groupId: beta.groupOne.id,
      membershipId: beta.users.scheduler.membershipId,
      userId: beta.users.scheduler.id,
      shiftTypeId: betaShiftType,
      label: 's16t-beta',
      ...betaWindow,
    });
    const betaContext = {
      organizationId: beta.organizationId,
      groupId: beta.groupOne.id,
      membershipId: beta.users.scheduler.membershipId,
      correlationId: 'matrix-s16t-beta',
    };
    const betaRun = await runtime.runner.run(betaContext, async (uow) =>
      createRun(uow, scheduleActor(beta.users.scheduler.id), {
        configurationId: betaFixture.configurationId,
        sourceVersionId: betaFixture.versionId,
        candidateLabel: 'matrix-s16t-beta',
        idempotencyKey: `matrix.s16tb.${randomUUID().slice(0, 8)}`,
      }),
    );
    await runtime.runner.run(betaContext, async (uow) => {
      const row = await loadRun(uow, betaRun.buildRunId);
      if (row === null) throw new Error('the beta run vanished');
      const validating = await transitionRun(uow, row, 'validating', { reason: 'submitted' });
      const checking = await transitionRun(uow, validating, 'readiness_check', {
        reason: 'configuration_consistent',
      });
      await transitionRun(uow, checking, 'queued', { reason: 'ready' });
    });

    const betaCapacity = await runtime.runner.run(betaContext, async (uow) =>
      admitBuildUnderCap(uow, 1),
    );
    /* THE ASSERTION S-16t IS ABOUT: alpha's saturation is invisible to beta.
     * A cap counted globally — or one whose read crossed the tenant boundary —
     * would refuse beta here, and beta would be starved by a neighbour. */
    expect(betaCapacity.admitted, 'beta was starved by alpha').toBe(true);
    expect(betaCapacity.runningCount).toBe(0);

    const betaClaim = await runtime.runner.run(betaContext, async (uow) =>
      claimQueuedBuild(uow, betaRun.buildRunId, workerToken('s16t-beta')),
    );
    expect(betaClaim, 'beta could not claim while alpha was saturated').not.toBeNull();
  }, 120_000);
});

describe('the queue binding, end to end', () => {
  it('the enqueue is in the SAME transaction as the transition (SP-D E-1.1)', async () => {
    const seeded = await seedRun('queue-atomic');
    expect(await solveJobsFor(seeded.buildRunId)).toBe(0);
    await submit(seeded, 'queue-atomic');
    expect(await solveJobsFor(seeded.buildRunId)).toBe(1);

    const payload = await admin.query<{ payload: unknown }>(
      `select j.payload
         from graphile_worker._private_jobs j
         join graphile_worker._private_tasks t on t.id = j.task_id
        where t.identifier = $1 and j.payload->>'buildRunId' = $2`,
      [BUILD_SOLVE_TASK, seeded.buildRunId],
    );
    const parsed = parseBuildSolvePayload(payload.rows[0]?.payload);
    expect(parsed, 'the enqueued payload must parse as the task expects').not.toBeUndefined();
    /* I-07 / non-bypass rule 9: identifiers only. The queue tables are outside
     * our RLS, so this is the one place a tenant identifier travels without a
     * policy underneath it — and it carries nothing else. */
    expect(Object.keys(payload.rows[0]?.payload as object).sort()).toEqual([
      'buildRunId',
      'correlationId',
      'groupId',
      'organizationId',
    ]);
  });

  it('a rolled-back submission enqueues NOTHING', async () => {
    const seeded = await seedRun('queue-rollback');
    const marker = new Error('deliberate rollback');
    await expect(
      run(async (uow) => {
        await enqueueBuildSolve(uow, seeded.buildRunId);
        throw marker;
      }, 'queue-rollback'),
    ).rejects.toBe(marker);
    /* SP-D E-1.1: `SECURITY DEFINER` does not open a transaction of its own, so
     * the enqueue dies with the transaction that made it. Without this the
     * queue would hold jobs for builds that never queued. */
    expect(await solveJobsFor(seeded.buildRunId)).toBe(0);
  });

  it('a malformed payload is refused rather than guessed at', () => {
    expect(parseBuildSolvePayload(null)).toBeUndefined();
    expect(parseBuildSolvePayload({ organizationId, groupId, buildRunId: 'not-a-uuid', correlationId: 'c' })).toBeUndefined();
    expect(parseBuildSolvePayload({ organizationId, groupId, buildRunId: randomUUID(), correlationId: '' })).toBeUndefined();
    expect(
      parseBuildSolvePayload({
        organizationId,
        groupId,
        buildRunId: randomUUID(),
        correlationId: 'c',
      }),
    ).not.toBeUndefined();
  });

  it('the REGISTERED task runs a submitted build to a terminal state', async () => {
    /* The registration proof. `runBuildSolveJob` above is the task BODY; this
     * arm starts the real graphile-worker pool and requires it to pick the job
     * up on its own — a body that is written and never registered is the defect
     * `outbox/runner.ts` records ("a task that silently no-ops, which is how a
     * periodic control stops existing without anybody noticing").
     *
     * **This file is no longer the only producer of `build.solve` jobs.**
     * `apps/api/test/sbx/**` became a second one when SBX-015 and SBX-017
     * landed, and the claim is corrected here rather than left standing: a
     * comment that is wider than its coverage is the same defect class as a dead
     * path, and this one asserted an isolation property that had stopped being
     * true. What actually keeps this arm sound is the assertion below — the pool
     * must leave THIS build in a terminal state and must have claimed it, both
     * addressed by id — not the absence of other producers. The other producer
     * drains its own backlog through `drainBuildSolveQueue`, which is the
     * shared-resource half of the same lesson. */
    const seeded = await seedRun('queue-registered');
    await submit(seeded, 'queue-registered');

    const pool = await startBuildQueueRunner({
      worker: worker.runner,
      label: 'matrix-builds',
      pollIntervalMs: 50,
      staleAfterMs: 3_600_000,
      sweepIntervalMs: 3_600_000,
      runOptions: { stubBehaviour: 'candidate', timeoutMs: 30_000 },
    });
    try {
      const deadline = Date.now() + 60_000;
      let row = await stateOf(seeded.buildRunId);
      while (Date.now() < deadline && (row?.state === 'queued' || row?.state === 'running')) {
        await new Promise((r) => setTimeout(r, 100));
        row = await stateOf(seeded.buildRunId);
      }
      expect(
        ['completed', 'completed_with_unmet_preferences', 'infeasible', 'failed'],
        `the registered task left the build in ${String(row?.state)}`,
      ).toContain(row?.state);
      expect(row?.claimed_by, 'the pool must have claimed it').not.toBeNull();
    } finally {
      await pool.stop();
    }
  }, 120_000);
});
