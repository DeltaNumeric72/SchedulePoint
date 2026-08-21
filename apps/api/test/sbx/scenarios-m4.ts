import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import type pg from 'pg';

import { runQueuedBuild, submitBuild } from '../../src/builds/runner.js';
import { applyCandidateToNewDraft } from '../../src/builds/selection.js';
import {
  approveRun,
  createRun,
  loadRun,
  markProgressivelyExtended,
  markReviewed,
  markStageComplete,
  sourceDigestOf,
  transitionRun,
  type BuildRunRow,
} from '../../src/builds/service.js';
import { isLegalTransition } from '../../src/builds/states.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { calendarDate } from '../../src/schedule/render.js';
import { setPin, transitionVersion } from '../../src/schedule/service.js';
import { readSnapshot } from '../../src/solver/snapshot-store.js';
import { seedBuildFixture, type BuildFixture } from '../support/builds.js';
import type { Runtime } from '../support/harness.js';
import { hardRule, seedRuleRow } from '../support/rules.js';
import { drainBuildSolveQueue } from '../support/queue.js';
import { scheduleActor } from '../support/schedule.js';
import { SOLVED_STATUSES, applyHostileWorkerEnv, applySolverEnv } from '../support/solver.js';
import { ProbeFalsified, type SbxRunContext, type SbxScenario } from './contract.js';
import { buildScenario016 } from './scenario-016.js';
import type { ScenarioDependencies } from './scenarios.js';

/**
 * **SBX-015 and SBX-017** — the two M4 sandbox scenarios that need the real
 * stack, and the composer that registers all three M4 scenarios.
 *
 * SBX-016 lives in `scenario-016.ts` because it is entirely pure and its 22
 * injected defects are a table of their own; this module owns the two that need
 * a cluster, a real CP-SAT subprocess and the production build services.
 *
 * Semantics are doc 35 §6g ruling (1), verbatim from report 21 §11:
 *
 *  * **SBX-015** — execution end-to-end, the `infeasible` vs `failed`
 *    distinction, regeneration (a retry is a NEW run), retained history;
 *  * **SBX-017** — progressive builds with protected assignments preserved
 *    EXACTLY, and partial circulation through the EXISTING M3 review path.
 *
 * Everything below drives the production services — `submitBuild`,
 * `runQueuedBuild`, `markReviewed`, `approveRun`, `applyCandidateToNewDraft`,
 * `transitionVersion`. Nothing inserts a build row, a snapshot or an assignment
 * directly, for the reason `test/support/builds.ts` gives: a row the fixture can
 * write is a row the application could forge, and the whole value of the
 * transition guard, the fencing trigger and the validation gate is that they
 * cannot be.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Shared fixture plumbing
 * ──────────────────────────────────────────────────────────────────────────── */

interface M4Tenant {
  readonly organizationId: string;
  readonly groupId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly shiftTypeId: string;
  readonly runtime: Runtime;
  /** `app_worker`, for the production consumer that drains this scenario's jobs. */
  readonly worker: Runtime;
  readonly admin: pg.Client;
}

function tenantOf(deps: () => ScenarioDependencies): M4Tenant {
  const { fixture, runtimes, admin } = deps();
  const runtime = runtimes.get('app_runtime');
  if (runtime === undefined) throw new Error('no app_runtime runtime');
  const worker = runtimes.get('app_worker');
  if (worker === undefined) throw new Error('no app_worker runtime');
  const alpha = fixture.alpha;
  const catalogue = fixture.catalogue?.alpha;
  if (catalogue === undefined) throw new Error('the M4 scenarios need seed.catalogue: [alpha]');
  /* Index 1 deliberately: `shiftTypeIds[0]` carries a qualification requirement
   * (OPUS-M4-000A), and these scenarios are about execution and progression
   * rather than about credentials. SBX-019 owns the credential path. */
  const shiftTypeId = catalogue.shiftTypeIds[1];
  if (shiftTypeId === undefined) throw new Error('the alpha catalogue seeded no shift type');
  return {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    userId: alpha.users.scheduler.id,
    shiftTypeId,
    runtime,
    worker,
    admin,
  };
}

/**
 * Leave the SHARED queue as this scenario found it (FAD-15 Layer 3).
 *
 * Every `submitBuild` above enqueues a `build.solve` job in the same transaction
 * as the `queued` transition (D-4b), and every dispatch above is direct — so the
 * jobs are still there, settled and un-consumed. `drainQueue` cannot take them:
 * it starts an OUTBOX runner, which has no handler for `build.solve`, so its
 * wait-for-zero loop would spin until it times out.
 *
 * That is not hypothetical. The first `pnpm check` after these scenarios landed
 * failed three unrelated files — `outbox-dispatch`, `crash-restart`, `periodic` —
 * with "the queue still holds 5 job(s) after 45000 ms". Five submissions here,
 * five orphaned jobs, three files broken, and not one of the messages mentioned a
 * build. Recorded rather than quietly fixed, because the failure mode is the
 * interesting part: a shared resource does not respect the tenancy that keeps
 * everything else in this suite apart.
 */
async function releaseQueue(tenant: M4Tenant, context: SbxRunContext, label: string): Promise<void> {
  const drained = await drainBuildSolveQueue({
    worker: tenant.worker.runner,
    admin: tenant.admin,
    label,
  });
  context.observe(
    'queue-released',
    `${String(drained)} build.solve job(s) consumed by the PRODUCTION queue runner, each ` +
      'answering not-claimable because its build had already settled; the shared queue is left ' +
      'as this scenario found it (FAD-15 Layer 3)',
  );
}

function contextFor(tenant: M4Tenant, label: string) {
  return {
    organizationId: tenant.organizationId,
    groupId: tenant.groupId,
    membershipId: tenant.membershipId,
    correlationId: `sbx-${label}`,
  };
}

async function inUow<T>(
  tenant: M4Tenant,
  label: string,
  fn: (uow: PgUnitOfWork) => Promise<T>,
): Promise<T> {
  return tenant.runtime.runner.run(contextFor(tenant, label), fn);
}

interface SeededRun {
  readonly fixture: BuildFixture;
  readonly buildRunId: string;
  readonly startDate: string;
  readonly endDate: string;
}

/** A period, a dated requirement, a draft, a configuration, and a created run. */
async function seedRun(
  tenant: M4Tenant,
  label: string,
  window: { startDate: string; endDate: string },
  options: { requiredCount?: number } = {},
): Promise<SeededRun> {
  const fixture = await seedBuildFixture(tenant.runtime.runner, {
    organizationId: tenant.organizationId,
    groupId: tenant.groupId,
    membershipId: tenant.membershipId,
    userId: tenant.userId,
    shiftTypeId: tenant.shiftTypeId,
    label,
    startDate: window.startDate,
    endDate: window.endDate,
    ...(options.requiredCount === undefined ? {} : { requiredCount: options.requiredCount }),
  });
  const created = await inUow(tenant, label, async (uow) =>
    createRun(uow, scheduleActor(tenant.userId), {
      configurationId: fixture.configurationId,
      sourceVersionId: fixture.versionId,
      candidateLabel: `sbx-${label}`,
      idempotencyKey: `sbx.${label}.${randomUUID().slice(0, 8)}`,
    }),
  );
  return { fixture, buildRunId: created.buildRunId, ...window };
}

interface ResultRow {
  readonly usable: boolean;
  readonly candidate_returned: boolean;
  readonly assignment_count: number;
  readonly solver_status: string;
  readonly termination_reason: string;
  readonly explanation_state: string | null;
  readonly explanation: unknown;
}

async function resultOf(tenant: M4Tenant, buildRunId: string): Promise<ResultRow | undefined> {
  return inUow(tenant, 'result', async (uow) => {
    const rows = (await uow.query
      .selectFrom('build_run_results')
      .select([
        'usable',
        'candidate_returned',
        'assignment_count',
        'solver_status',
        'termination_reason',
        'explanation_state',
        'explanation',
      ])
      .where('build_run_id', '=', buildRunId)
      .execute()) as unknown as ResultRow[];
    return rows[0];
  });
}

async function stateOf(tenant: M4Tenant, buildRunId: string): Promise<BuildRunRow> {
  const row = await inUow(tenant, 'read', async (uow) => loadRun(uow, buildRunId));
  if (row === null) throw new Error(`build run ${buildRunId} vanished`);
  return row;
}

/* ════════════════════════════════════════════════════════════════════════════
 * SBX-015
 * ════════════════════════════════════════════════════════════════════════════ */

/** One settled build, reduced to the three facts the honesty oracle reads. */
export interface SettledOutcome {
  readonly arm: string;
  readonly state: string;
  readonly terminationReason: string | null;
  readonly solverStatus: string | null;
  readonly usable: boolean | null;
}

/**
 * **SBX-015's oracle.** Whether the three settled builds are reported honestly.
 *
 * SPEC-04 §2 and report 21 §4 draw one distinction this scenario exists to
 * measure: **`infeasible` is a statement about the PROBLEM and `failed` is a
 * statement about the SYSTEM**, and collapsing them is a plausible-looking lie —
 * a scheduler told "the build failed" retries it, and a scheduler told "no
 * schedule exists under these constraints" changes the constraints.
 */
export function outcomeHonestyOracle(
  observed: readonly SettledOutcome[],
): readonly string[] {
  const problems: string[] = [];
  const byArm = new Map(observed.map((outcome) => [outcome.arm, outcome]));

  const execution = byArm.get('execution');
  if (execution === undefined) problems.push('no execution arm was observed');
  else {
    if (!SOLVED_STATUSES.includes(execution.solverStatus ?? '')) {
      problems.push(
        `execution: solver status ${String(execution.solverStatus)} is not a solved status`,
      );
    }
    if (execution.usable !== true) problems.push('execution: the checker did not admit the candidate');
    if (execution.state === 'infeasible' || execution.state === 'failed') {
      problems.push(`execution: a solved run was reported as ${execution.state}`);
    }
  }

  const infeasible = byArm.get('infeasible');
  if (infeasible === undefined) problems.push('no infeasible arm was observed');
  else {
    if (infeasible.state !== 'infeasible') {
      problems.push(
        `infeasible: a proven-infeasible problem was reported as ${infeasible.state} — ` +
          'a statement about the problem was turned into one about the system',
      );
    }
    if (infeasible.solverStatus !== 'INFEASIBLE') {
      problems.push(`infeasible: solver status ${String(infeasible.solverStatus)}`);
    }
    if (infeasible.terminationReason !== 'completed') {
      problems.push(
        `infeasible: termination reason ${String(infeasible.terminationReason)} — an infeasible ` +
          'proof is a COMPLETED solve, not a fault',
      );
    }
  }

  const failed = byArm.get('failed');
  if (failed === undefined) problems.push('no failed arm was observed');
  else {
    if (failed.state !== 'failed') {
      problems.push(`failed: an unusable answer was reported as ${failed.state}`);
    }
    if (failed.state === 'infeasible') {
      problems.push('failed: a system fault was reported as a proof that no schedule exists');
    }
    if (failed.usable === true) problems.push('failed: an unusable answer was recorded as usable');
  }

  if (infeasible !== undefined && failed !== undefined && infeasible.state === failed.state) {
    problems.push(
      `infeasible and failed settled in the SAME state (${infeasible.state}) — the ` +
        'distinction report 24 §3.2 requires does not exist',
    );
  }

  return problems;
}

function buildScenario015(deps: () => ScenarioDependencies): SbxScenario {
  return {
    id: 'SBX-015',
    title: 'Execution, the infeasible-vs-failed distinction, regeneration, and retained history',
    /* G-PROD depends on this evidence (report 24 §3.2, CAP-015..018). */
    gateRequired: true,
    contract: {
      owner: 'OPUS-M4-005 (implementer) / Fable (acceptance)',
      fixtureProvenance:
        'MULTI `full` profile with `seed.catalogue: [alpha]`, provisioned by ' +
        'apps/api/test/support/multi.ts from a slug — the single fixture owner. Each arm seeds ' +
        'its own period, dated requirement, draft version and build configuration through ' +
        '`seedBuildFixture`, i.e. through the PRODUCTION write path (createPeriod, ' +
        'setRequirement, createDraftVersion, createConfiguration). The infeasible arm adds one ' +
        'HARD `AvoidDate` rule through the production rule write path under the scheduler\'s ' +
        'own capability. Synthetic throughout; 2047 windows, far from every other fixture in ' +
        'this file.',
      deterministicSetup:
        'One embedded PostgreSQL cluster per run, initialised from empty; migrations up -> down ' +
        '-> up. Each arm takes its own period window (a fortnight apart, so D-2 cannot see an ' +
        'overlap) and its own build run, so no arm depends on another\'s ordering. The two real ' +
        'solves run under the venv CP-SAT worker with the configuration\'s own parameters; the ' +
        'assertions are over the SETTLED STATE and the recorded status, never over a duration ' +
        'or an objective value, so nothing here depends on how fast the machine is.',
      externalDependency:
        'The CP-SAT worker subprocess (`SP_SOLVER_WORKER_COMMAND`, the local venv interpreter). ' +
        'It holds no database credential and no network egress; the cancellation channel is a ' +
        'file. Nothing else is outside this process and its local cluster.',
      faultControls:
        'Three injected. (1) A HARD `AvoidDate` rule on the one date the period requires ' +
        'staffed, which makes the problem genuinely INFEASIBLE rather than merely refused — the ' +
        'readiness check does not evaluate rules, so the run reaches the solver and the solver ' +
        'proves it. (2) A hostile worker fixture (`garbage` mode) whose answer cannot be parsed, ' +
        'which must settle `failed`/`rejected` and never `infeasible`. (3) The falsifiability ' +
        'probe re-labels the infeasible outcome as `failed` and requires the oracle to reject ' +
        'it. No notification is sent to any destination.',
      objectiveOracle:
        'Four conjuncts: (1) EXECUTION — a real solve settles in the completed family with a ' +
        'solved solver status and a candidate the INDEPENDENT checker admitted; (2) ' +
        'DISTINCTION — the infeasible arm settles `infeasible`/`completed`/`INFEASIBLE` and the ' +
        'failed arm settles `failed` with `usable = false`, and the two states are DIFFERENT; ' +
        '(3) REGENERATION — a retry is a NEW `build_runs` row citing the original in ' +
        '`retry_of_build_run_id`, and the in-place edge `infeasible -> draft_configuration` is ' +
        'refused by the DATABASE as well as by the transition table; (4) RETAINED HISTORY — ' +
        'every earlier run is still readable in its settled state with its result row intact ' +
        'after the retry.',
      retainedArtifact: 'docs/evidence/EV-M4-005/sbx-015-execution.txt',
      environment: 'LIVE-SIM',
      earliestExecutionPoint: 'E1',
    },

    run: async (context) => {
      const tenant = tenantOf(deps);
      const actor = scheduleActor(tenant.userId);
      const observed: SettledOutcome[] = [];

      const restoreSolver = applySolverEnv();
      let infeasibleRunId = '';
      try {
        /* ── arm 1: execution, end to end, against the REAL solver ───────── */
        const execution = await seedRun(tenant, 'sbx015-exec', {
          startDate: '2047-01-07',
          endDate: '2047-01-13',
        });
        const submitted = await submitBuild(
          tenant.runtime.runner,
          contextFor(tenant, 'sbx015-exec'),
          actor,
          execution.buildRunId,
          'draft_configuration',
        );
        if (submitted.state !== 'queued') {
          throw new Error(
            `the execution fixture did not queue: ${submitted.state} ` +
              `(validation ${JSON.stringify(submitted.validationFindings)}, readiness ` +
              `${JSON.stringify(submitted.readinessFindings)})`,
          );
        }
        context.tableExercised('solver_input_snapshots');
        context.policyExercised('I-05 — the engine, not a manual placement, produced the content');

        const ran = await runQueuedBuild(
          tenant.runtime.runner,
          contextFor(tenant, 'sbx015-exec'),
          execution.buildRunId,
          { timeoutMs: 60_000 },
        );
        if (ran.kind !== 'ran') throw new Error(`the execution dispatch answered ${ran.kind}`);
        const executionRow = await stateOf(tenant, execution.buildRunId);
        const executionResult = await resultOf(tenant, execution.buildRunId);
        observed.push({
          arm: 'execution',
          state: executionRow.state,
          terminationReason: executionRow.termination_reason,
          solverStatus: executionRow.solver_status,
          usable: executionResult?.usable ?? null,
        });
        context.tableExercised('build_runs');
        context.tableExercised('build_run_results');
        context.tableExercised('build_run_candidate_assignments');
        context.observe(
          'arm-1-execution',
          `a real CP-SAT solve settled ${executionRow.state} / ${String(executionRow.solver_status)}; ` +
            `${String(executionResult?.assignment_count ?? 0)} candidate assignment(s), ` +
            `usable=${String(executionResult?.usable)}, reproducibility ` +
            `${String(executionRow.reproducibility_mode)}`,
        );

        /* ── arm 2: INFEASIBLE, proven by the solver ─────────────────────── */
        const infeasibleDate = '2047-02-04';
        await seedRuleRow(
          tenant.runtime.runner,
          {
            organizationId: tenant.organizationId,
            groupId: tenant.groupId,
            membershipId: tenant.membershipId,
            label: 'sbx015-infeasible',
          },
          hardRule(
            'sbx015_no_staffing_on_the_required_date',
            { kind: 'AvoidDate', date: infeasibleDate },
            { dateRange: { from: infeasibleDate, to: infeasibleDate } },
          ),
        );
        context.tableExercised('rules');
        const infeasible = await seedRun(tenant, 'sbx015-infeasible', {
          startDate: infeasibleDate,
          endDate: '2047-02-10',
        });
        infeasibleRunId = infeasible.buildRunId;
        const infeasibleSubmit = await submitBuild(
          tenant.runtime.runner,
          contextFor(tenant, 'sbx015-infeasible'),
          actor,
          infeasible.buildRunId,
          'draft_configuration',
        );
        if (infeasibleSubmit.state !== 'queued') {
          throw new Error(
            'the infeasible fixture was refused BEFORE the solve, so nothing proved ' +
              `infeasibility: ${infeasibleSubmit.state} (readiness ` +
              `${JSON.stringify(infeasibleSubmit.readinessFindings)})`,
          );
        }
        const infeasibleRan = await runQueuedBuild(
          tenant.runtime.runner,
          contextFor(tenant, 'sbx015-infeasible'),
          infeasible.buildRunId,
          { timeoutMs: 60_000 },
        );
        if (infeasibleRan.kind !== 'ran') {
          throw new Error(`the infeasible dispatch answered ${infeasibleRan.kind}`);
        }
        const infeasibleRow = await stateOf(tenant, infeasible.buildRunId);
        const infeasibleResult = await resultOf(tenant, infeasible.buildRunId);
        observed.push({
          arm: 'infeasible',
          state: infeasibleRow.state,
          terminationReason: infeasibleRow.termination_reason,
          solverStatus: infeasibleRow.solver_status,
          usable: infeasibleResult?.usable ?? null,
        });

        /* Report 24 §3.5: "every `infeasible` names the conflicting hard
         * constraints in domain terms". The explanation is READ rather than
         * assumed, and what it names is asserted against the rule that was
         * actually injected. */
        const explanation = (infeasibleResult?.explanation ?? {}) as {
          conflictingRuleKeys?: unknown;
          structural?: unknown;
        };
        const conflicting = Array.isArray(explanation.conflictingRuleKeys)
          ? (explanation.conflictingRuleKeys as string[])
          : [];
        const structural = Array.isArray(explanation.structural)
          ? (explanation.structural as { code?: string }[])
          : [];
        if (conflicting.length === 0 && structural.length === 0) {
          throw new Error(
            'an INFEASIBLE build named neither a conflicting hard rule nor a structural ' +
              'finding — an unexplained infeasibility is what report 24 §3.5 forbids',
          );
        }
        if (conflicting.length > 0 && !conflicting.includes('sbx015_no_staffing_on_the_required_date')) {
          throw new Error(
            `the conflicting set [${conflicting.join(', ')}] does not name the rule that was ` +
              'actually injected',
          );
        }
        context.observe(
          'arm-2-infeasible',
          `state=${infeasibleRow.state} reason=${String(infeasibleRow.termination_reason)} ` +
            `solverStatus=${String(infeasibleRow.solver_status)}; explanation state ` +
            `${String(infeasibleResult?.explanation_state)}; conflicting rule keys ` +
            `[${conflicting.join(', ')}]; ${String(structural.length)} structural finding(s)`,
        );
        context.policyExercised('SPEC-04 §2 — infeasible is a statement about the problem');

        /* ── arm 3: FAILED, and distinctly so ────────────────────────────── */
        const failing = await seedRun(tenant, 'sbx015-failed', {
          startDate: '2047-03-04',
          endDate: '2047-03-10',
        });
        const failingSubmit = await submitBuild(
          tenant.runtime.runner,
          contextFor(tenant, 'sbx015-failed'),
          actor,
          failing.buildRunId,
          'draft_configuration',
        );
        if (failingSubmit.state !== 'queued') {
          throw new Error(`the failing fixture did not queue: ${failingSubmit.state}`);
        }
        const restoreHostile = applyHostileWorkerEnv('garbage');
        try {
          const hostileRan = await runQueuedBuild(
            tenant.runtime.runner,
            contextFor(tenant, 'sbx015-failed'),
            failing.buildRunId,
            { timeoutMs: 30_000 },
          );
          if (hostileRan.kind !== 'ran') {
            throw new Error(`the hostile dispatch answered ${hostileRan.kind}`);
          }
        } finally {
          restoreHostile();
        }
        const failedRow = await stateOf(tenant, failing.buildRunId);
        const failedResult = await resultOf(tenant, failing.buildRunId);
        observed.push({
          arm: 'failed',
          state: failedRow.state,
          terminationReason: failedRow.termination_reason,
          solverStatus: failedRow.solver_status,
          usable: failedResult?.usable ?? null,
        });
        context.observe(
          'arm-3-failed',
          `state=${failedRow.state} reason=${String(failedRow.termination_reason)} ` +
            `usable=${String(failedResult?.usable)} — an unparsable answer, never a verdict ` +
            'about whether a schedule exists',
        );
      } finally {
        restoreSolver();
      }

      const problems = outcomeHonestyOracle(observed);
      if (problems.length > 0) {
        throw new Error(`the outcome-honesty oracle rejected: ${problems.join('; ')}`);
      }
      context.observe(
        'distinction',
        observed.map((o) => `${o.arm}=${o.state}/${String(o.terminationReason)}`).join(' · '),
      );

      /* ── arm 4: REGENERATION — a retry is a NEW run ───────────────────── */
      const original = await stateOf(tenant, infeasibleRunId);
      const originalEpoch = original.claim_epoch;

      /* The in-place retry is impossible, in the transition table AND in the
       * database. Both are asserted: the table is the readable half and the
       * trigger is the control (M4-003's mirror discipline). */
      if (isLegalTransition('infeasible', 'draft_configuration')) {
        throw new Error('the transition table admits an in-place retry (SPEC-04 §2 forbids it)');
      }
      let refusedInPlace = false;
      try {
        await inUow(tenant, 'sbx015-retry-inplace', async (uow) => {
          const row = await loadRun(uow, infeasibleRunId);
          if (row === null) throw new Error('the infeasible run vanished');
          await transitionRun(uow, row, 'draft_configuration', { reason: 'submitted' });
        });
      } catch {
        refusedInPlace = true;
      }
      if (!refusedInPlace) {
        throw new Error('an infeasible build was reopened IN PLACE — retries must be new runs');
      }

      const retry = await inUow(tenant, 'sbx015-retry', async (uow) =>
        createRun(uow, actor, {
          configurationId: (await stateOf(tenant, infeasibleRunId)).build_configuration_id,
          sourceVersionId: original.source_version_id,
          candidateLabel: 'sbx-sbx015-retry',
          idempotencyKey: `sbx.sbx015-retry.${randomUUID().slice(0, 8)}`,
          retryOfBuildRunId: infeasibleRunId,
        }),
      );
      if (retry.buildRunId === infeasibleRunId) {
        throw new Error('the retry reused the original run id');
      }
      const retryRow = await stateOf(tenant, retry.buildRunId);
      if (retryRow.retry_of_build_run_id !== infeasibleRunId) {
        throw new Error('the retry does not cite the run it retries');
      }
      if (retryRow.retry_attempt <= original.retry_attempt) {
        throw new Error('the retry did not advance the attempt counter');
      }
      context.observe(
        'arm-4-regeneration',
        `retry ${retryRow.id} cites ${infeasibleRunId} at attempt ` +
          `${String(retryRow.retry_attempt)}; the in-place edge infeasible -> ` +
          'draft_configuration is refused by the transition table AND by the database',
      );
      context.policyExercised('SPEC-04 §2 — a retry is a NEW build_run, never in place');

      /* ── arm 5: RETAINED HISTORY ──────────────────────────────────────── */
      const after = await stateOf(tenant, infeasibleRunId);
      if (after.state !== 'infeasible') {
        throw new Error(`the retry changed the original run's state to ${after.state}`);
      }
      if (after.claim_epoch !== originalEpoch) {
        throw new Error('the retry spent the original run\'s claim epoch');
      }
      const retainedResult = await resultOf(tenant, infeasibleRunId);
      if (retainedResult === undefined) {
        throw new Error('the original run\'s result row was destroyed by the retry');
      }
      const history = await inUow(tenant, 'sbx015-history', async (uow) => {
        const rows = (await sql<{ id: string; state: string }>`
          select r.id, r.state
            from build_runs r
           where r.candidate_label like 'sbx-sbx015-%'
           order by r.created_at
        `.execute(uow.query)) as unknown as { rows: { id: string; state: string }[] };
        return rows.rows;
      });
      if (history.length < 4) {
        throw new Error(
          `only ${String(history.length)} of the 4 runs this scenario created are still readable`,
        );
      }
      context.observe(
        'arm-5-retained-history',
        `${String(history.length)} runs retained: ` +
          history.map((r) => `${r.id.slice(0, 8)}=${r.state}`).join(', '),
      );
      context.tableExercised('build_run_events');

      await releaseQueue(tenant, context, 'sbx-015-release');
    },

    /**
     * The probe: the scenario's own honesty oracle, given the ONE conflation
     * SPEC-04 §2 forbids.
     *
     * A timed-out or infeasible solve reported as the other is the realistic
     * failure — both are "the build did not produce a schedule", and a state
     * machine that collapsed them would look perfectly reasonable in every
     * screenshot. So the probe relabels the infeasible outcome as `failed` and
     * requires the oracle to reject it, throwing `ProbeFalsified` only after
     * OBSERVING that rejection.
     */
    probe: async (context: SbxRunContext) => {
      const truthful: SettledOutcome[] = [
        {
          arm: 'execution',
          state: 'completed',
          terminationReason: 'completed',
          solverStatus: 'OPTIMAL',
          usable: true,
        },
        {
          arm: 'infeasible',
          state: 'infeasible',
          terminationReason: 'completed',
          solverStatus: 'INFEASIBLE',
          usable: false,
        },
        {
          arm: 'failed',
          state: 'failed',
          terminationReason: 'rejected',
          solverStatus: 'UNKNOWN',
          usable: false,
        },
      ];
      const accepted = outcomeHonestyOracle(truthful);
      if (accepted.length > 0) {
        throw new Error(
          `the oracle rejected an honest observation: ${accepted.join('; ')} — the probe has ` +
            'found the oracle broken rather than falsified the scenario',
        );
      }
      context.observe('probe-control', 'the oracle accepts the honest three-arm observation');

      const conflated = truthful.map((outcome) =>
        outcome.arm === 'infeasible'
          ? { ...outcome, state: 'failed', terminationReason: 'rejected' }
          : outcome,
      );
      const problems = outcomeHonestyOracle(conflated);
      if (problems.length === 0) return;

      throw new ProbeFalsified(
        `reporting a proven-infeasible problem as a system failure was rejected by the ` +
          `scenario's own oracle: ${problems.join('; ')}`,
      );
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * SBX-017
 * ════════════════════════════════════════════════════════════════════════════ */

/** One protected assignment, reduced to the facts "preserved exactly" is about. */
export interface ProtectedPlacement {
  readonly assignmentIdentityId: string;
  readonly membershipId: string;
  readonly date: string;
  readonly shiftTypeId: string;
  readonly isPinned: boolean;
}

/**
 * **SBX-017's oracle.** Whether a protected assignment survived a progressive
 * stage EXACTLY.
 *
 * Report 24 §2 item 6 is "protected assignments preserved exactly across
 * stages", and the word doing the work is *exactly*: an identity that survived
 * but moved to another person, or to another date, or lost its pin, is not a
 * preserved assignment — it is a silently re-decided one, which is precisely
 * what "explicit unlocking" (report 21 §5) exists to prevent.
 */
export function preservationOracle(
  before: ProtectedPlacement,
  after: readonly ProtectedPlacement[],
): readonly string[] {
  const problems: string[] = [];
  const match = after.find(
    (placement) => placement.assignmentIdentityId === before.assignmentIdentityId,
  );
  if (match === undefined) {
    problems.push(
      `the protected identity ${before.assignmentIdentityId} is ABSENT from the stage output`,
    );
    return problems;
  }
  if (match.membershipId !== before.membershipId) {
    problems.push(
      `the protected assignment MOVED from ${before.membershipId} to ${match.membershipId}`,
    );
  }
  if (match.date !== before.date) {
    problems.push(`the protected assignment moved from ${before.date} to ${match.date}`);
  }
  if (match.shiftTypeId !== before.shiftTypeId) {
    problems.push('the protected assignment changed shift type');
  }
  if (!match.isPinned) {
    problems.push(
      'the protected assignment lost its pin — the next stage would be free to re-decide it, ' +
        'which is unlocking by side effect',
    );
  }
  return problems;
}

function buildScenario017(deps: () => ScenarioDependencies): SbxScenario {
  return {
    id: 'SBX-017',
    title: 'Progressive builds — protected assignments preserved exactly, and partial circulation',
    /* G-PROD depends on this evidence (report 24 §2 item 6). */
    gateRequired: true,
    contract: {
      owner: 'OPUS-M4-005 (implementer) / Fable (acceptance)',
      fixtureProvenance:
        'MULTI `full` profile with `seed.catalogue: [alpha]`, provisioned by ' +
        'apps/api/test/support/multi.ts from a slug. The scenario builds its own two-stage ' +
        'history through the production services: stage 1 is a real solve whose candidate is ' +
        'reviewed, approved and written into a new draft; one of the resulting assignments is ' +
        'then PINNED through `setPin`, and stage 2 is a progressive build citing stage 1 in ' +
        '`parent_build_ids` and that identity in `protected_assignment_identities`. Synthetic ' +
        'throughout; a 2048 period window far from every other fixture.',
      deterministicSetup:
        'One embedded PostgreSQL cluster per run, initialised from empty; migrations up -> down ' +
        '-> up. The two stages are strictly sequential — stage 2 is created only after stage 1 ' +
        'has settled — so no result depends on interleaving. Both solves run under the venv ' +
        'CP-SAT worker; every assertion is over rows in the database, never over a duration.',
      externalDependency:
        'The CP-SAT worker subprocess (`SP_SOLVER_WORKER_COMMAND`). Nothing else.',
      faultControls:
        'One injected, plus the probe. The progressive stage is given a protected identity and ' +
        'the solver is free to place everything else, so the stage is a real re-decision of the ' +
        'period rather than a copy. The falsifiability probe hands the preservation oracle a ' +
        'stage output in which the protected assignment MOVED to another membership and ' +
        'requires the oracle to reject it. No notification is sent to any destination and ' +
        'nothing is published.',
      objectiveOracle:
        'Three conjuncts: (1) PROTECTION RECORDED — the stage-2 canonical input carries the ' +
        'protected identity as a fixed input with `isPinned: true`, so the protection is an ' +
        'INPUT rather than a hope; (2) PRESERVED EXACTLY — after the stage-2 candidate is ' +
        'selected into a new draft, the protected identity is present with the SAME membership, ' +
        'the SAME date, the SAME shift type and still pinned; (3) PARTIAL CIRCULATION — the ' +
        'partial draft reaches `in_review` through the EXISTING M3 path (`transitionVersion`) ' +
        'and is readable, while the period is still `planning`, holds no publication record and ' +
        'no current published assignment.',
      retainedArtifact: 'docs/evidence/EV-M4-005/sbx-017-progressive.txt',
      environment: 'LIVE-SIM',
      earliestExecutionPoint: 'E2',
    },

    run: async (context) => {
      const tenant = tenantOf(deps);
      const actor = scheduleActor(tenant.userId);
      const restoreSolver = applySolverEnv();

      try {
        /* ── stage 1: a real build, reviewed, approved, selected ─────────── */
        const stage1 = await seedRun(tenant, 'sbx017-stage1', {
          startDate: '2048-01-06',
          endDate: '2048-01-12',
        });
        const submitted = await submitBuild(
          tenant.runtime.runner,
          contextFor(tenant, 'sbx017-stage1'),
          actor,
          stage1.buildRunId,
          'draft_configuration',
        );
        if (submitted.state !== 'queued') {
          throw new Error(`stage 1 did not queue: ${submitted.state}`);
        }
        const ran = await runQueuedBuild(
          tenant.runtime.runner,
          contextFor(tenant, 'sbx017-stage1'),
          stage1.buildRunId,
          { timeoutMs: 60_000 },
        );
        if (ran.kind !== 'ran') throw new Error(`stage 1 dispatch answered ${ran.kind}`);
        const stage1Row = await stateOf(tenant, stage1.buildRunId);
        if (stage1Row.state !== 'completed' && stage1Row.state !== 'completed_with_unmet_preferences') {
          throw new Error(`stage 1 settled ${stage1Row.state}, so there is nothing to progress`);
        }

        const stage1Draft = await inUow(tenant, 'sbx017-select1', async (uow) => {
          const row = await loadRun(uow, stage1.buildRunId);
          if (row === null) throw new Error('stage 1 vanished');
          await markReviewed(uow, actor, stage1.buildRunId, row.state);
          await approveRun(uow, actor, stage1.buildRunId, 'reviewed');
          const approved = await loadRun(uow, stage1.buildRunId);
          if (approved === null) throw new Error('stage 1 vanished after approval');
          const digest = await sourceDigestOf(uow, approved);
          const applied = await applyCandidateToNewDraft(
            uow,
            actor,
            stage1.buildRunId,
            'approved',
            digest,
          );
          return applied.draftVersionId;
        });
        context.tableExercised('schedule_versions');
        context.tableExercised('assignment_identities');
        context.tableExercised('assignment_snapshots');
        context.observe(
          'stage-1',
          `a real solve was reviewed, approved and written into a NEW draft ${stage1Draft}; ` +
            'the source draft is untouched',
        );

        /* ── the protection: one assignment on the new draft, PINNED ─────── */
        const placements = await inUow(tenant, 'sbx017-read1', async (uow) => {
          const rows = (await uow.query
            .selectFrom('assignment_snapshots')
            .innerJoin('shifts', 'shifts.id', 'assignment_snapshots.shift_id')
            .select([
              'assignment_snapshots.assignment_identity_id as identity',
              'assignment_snapshots.membership_id as membership',
              'assignment_snapshots.date as date',
              'shifts.shift_type_id as shift_type_id',
              'assignment_snapshots.is_pinned as is_pinned',
            ])
            .where('assignment_snapshots.version_id', '=', stage1Draft)
            .where('assignment_snapshots.status', '=', 'active')
            .execute()) as unknown as {
            identity: string;
            membership: string;
            date: string | Date;
            shift_type_id: string;
            is_pinned: boolean;
          }[];
          return rows;
        });
        const first = placements[0];
        if (first === undefined) {
          throw new Error('the stage-1 draft carries no assignment to protect');
        }
        await inUow(tenant, 'sbx017-pin', async (uow) => {
          await setPin(uow, actor, stage1Draft, first.identity, true);
        });
        const protectedBefore: ProtectedPlacement = {
          assignmentIdentityId: first.identity,
          membershipId: first.membership,
          /* `assignment_snapshots.date` is a PostgreSQL `date` and the driver hands
           * it back as a `Date`. `calendarDate` is this repository's ONE
           * normalisation (apps/api/src/schedule/render.ts); `String(row.date)`
           * yields a locale string, and comparing two of those would agree for
           * the wrong reason. */
          date: calendarDate(first.date),
          shiftTypeId: first.shift_type_id,
          isPinned: true,
        };
        context.observe(
          'protection',
          `identity ${protectedBefore.assignmentIdentityId} pinned on the stage-1 draft ` +
            `(${protectedBefore.membershipId} on ${protectedBefore.date})`,
        );

        /* ── stage 2: the PROGRESSIVE build ─────────────────────────────── */
        const stage2Created = await inUow(tenant, 'sbx017-stage2', async (uow) =>
          createRun(uow, actor, {
            configurationId: stage1.fixture.configurationId,
            sourceVersionId: stage1Draft,
            candidateLabel: 'sbx-sbx017-stage2',
            idempotencyKey: `sbx.sbx017-stage2.${randomUUID().slice(0, 8)}`,
            parentBuildIds: [stage1.buildRunId],
            protectedAssignmentIdentities: [protectedBefore.assignmentIdentityId],
          }),
        );
        const stage2Submit = await submitBuild(
          tenant.runtime.runner,
          contextFor(tenant, 'sbx017-stage2'),
          actor,
          stage2Created.buildRunId,
          'draft_configuration',
        );
        if (stage2Submit.state !== 'queued') {
          throw new Error(
            `the progressive stage did not queue: ${stage2Submit.state} ` +
              `(${JSON.stringify(stage2Submit.readinessFindings)})`,
          );
        }

        /* The protection is an INPUT, and the snapshot is where that is true. */
        const stage2Row = await stateOf(tenant, stage2Created.buildRunId);
        if (stage2Row.snapshot_id === null) throw new Error('the progressive stage pinned nothing');
        const snapshotFixed = await inUow(tenant, 'sbx017-snapshot', async (uow) => {
          /* The PRODUCTION reader. `solver_input_snapshots` is deliberately
           * absent from the typed `Database` interface (it is append-only and a
           * typed `updateTable` would be a rewrite path that must not exist), so
           * the scenario reads it the way the runner does. */
          const stored = await readSnapshot(uow, stage2Row.snapshot_id as string);
          const payload = stored?.payload as
            | { fixedAssignments?: { assignmentIdentityId: string; isPinned: boolean }[] }
            | undefined;
          return payload?.fixedAssignments ?? [];
        });
        const carried = snapshotFixed.find(
          (fixed) => fixed.assignmentIdentityId === protectedBefore.assignmentIdentityId,
        );
        if (carried === undefined || !carried.isPinned) {
          throw new Error(
            'the progressive stage protected an identity the canonical input does not carry as ' +
              'a PINNED fixed input — the protection would be a hope rather than an input',
          );
        }
        if (stage2Row.parent_build_ids[0] !== stage1.buildRunId) {
          throw new Error('the progressive stage does not record its parent build');
        }
        context.observe(
          'stage-2-inputs',
          `the canonical input carries ${String(snapshotFixed.length)} fixed input(s); the ` +
            'protected identity is present and pinned; parent build recorded',
        );
        context.policyExercised('SPEC-04 §6 — fixed inputs are recorded, never inferred');

        const stage2Ran = await runQueuedBuild(
          tenant.runtime.runner,
          contextFor(tenant, 'sbx017-stage2'),
          stage2Created.buildRunId,
          { timeoutMs: 60_000 },
        );
        if (stage2Ran.kind !== 'ran') {
          throw new Error(`the progressive dispatch answered ${stage2Ran.kind}`);
        }
        const stage2Settled = await stateOf(tenant, stage2Created.buildRunId);
        if (
          stage2Settled.state !== 'completed' &&
          stage2Settled.state !== 'completed_with_unmet_preferences'
        ) {
          const result = await resultOf(tenant, stage2Created.buildRunId);
          throw new Error(
            `the progressive stage settled ${stage2Settled.state} ` +
              `(${String(stage2Settled.termination_reason)}, rejections ` +
              `${JSON.stringify(result?.explanation ?? null)}) — a candidate that dropped the ` +
              'protected assignment is refused by the checker, which is the M-25 half; this arm ' +
              'is about the candidate that KEEPS it',
          );
        }

        /* ── the progressive lifecycle, through the production services ──── */
        const stage2Draft = await inUow(tenant, 'sbx017-select2', async (uow) => {
          const row = await loadRun(uow, stage2Created.buildRunId);
          if (row === null) throw new Error('the progressive stage vanished');
          await markReviewed(uow, actor, stage2Created.buildRunId, row.state);
          await markProgressivelyExtended(uow, actor, stage2Created.buildRunId, 'reviewed');
          await markStageComplete(uow, actor, stage2Created.buildRunId, 'progressively_extended');
          await approveRun(uow, actor, stage2Created.buildRunId, 'reviewed');
          const approved = await loadRun(uow, stage2Created.buildRunId);
          if (approved === null) throw new Error('the progressive stage vanished after approval');
          const digest = await sourceDigestOf(uow, approved);
          const applied = await applyCandidateToNewDraft(
            uow,
            actor,
            stage2Created.buildRunId,
            'approved',
            digest,
          );
          return applied.draftVersionId;
        });
        context.observe(
          'stage-2-lifecycle',
          'completed -> reviewed -> progressively_extended -> reviewed -> approved -> ' +
            `applied_to_draft_schedule; new draft ${stage2Draft}`,
        );

        /* ── preserved EXACTLY ──────────────────────────────────────────── */
        const after = await inUow(tenant, 'sbx017-read2', async (uow) => {
          const rows = (await uow.query
            .selectFrom('assignment_snapshots')
            .innerJoin('shifts', 'shifts.id', 'assignment_snapshots.shift_id')
            .select([
              'assignment_snapshots.assignment_identity_id as identity',
              'assignment_snapshots.membership_id as membership',
              'assignment_snapshots.date as date',
              'shifts.shift_type_id as shift_type_id',
              'assignment_snapshots.is_pinned as is_pinned',
            ])
            .where('assignment_snapshots.version_id', '=', stage2Draft)
            .where('assignment_snapshots.status', '=', 'active')
            .execute()) as unknown as {
            identity: string;
            membership: string;
            date: string | Date;
            shift_type_id: string;
            is_pinned: boolean;
          }[];
          return rows.map((row) => ({
            assignmentIdentityId: row.identity,
            membershipId: row.membership,
            date: calendarDate(row.date),
            shiftTypeId: row.shift_type_id,
            isPinned: row.is_pinned,
          }));
        });
        const problems = preservationOracle(protectedBefore, after);
        if (problems.length > 0) {
          throw new Error(`the preservation oracle rejected: ${problems.join('; ')}`);
        }
        context.observe(
          'preserved-exactly',
          `identity ${protectedBefore.assignmentIdentityId} survived the progressive stage with ` +
            `the same membership, date and shift type, and is still pinned ` +
            `(${String(after.length)} assignment(s) on the new draft)`,
        );
        context.policyExercised('report 21 §5 — unlocking a protected assignment is explicit');

        /* ── partial circulation, through the EXISTING M3 review path ────── */
        await inUow(tenant, 'sbx017-review', async (uow) => {
          await transitionVersion(uow, actor, stage2Draft, 'in_review');
        });
        const circulation = await inUow(tenant, 'sbx017-circulation', async (uow) => {
          const version = (await uow.query
            .selectFrom('schedule_versions')
            .select(['state', 'is_current', 'period_id'])
            .where('id', '=', stage2Draft)
            .execute()) as unknown as {
            state: string;
            is_current: boolean;
            period_id: string;
          }[];
          const period = (await uow.query
            .selectFrom('schedule_periods')
            .select(['status', 'start_date', 'end_date'])
            .where('id', '=', stage1.fixture.periodId)
            .execute()) as unknown as {
            status: string;
            start_date: string | Date;
            end_date: string | Date;
          }[];
          /* `publication_records` is append-only and therefore absent from the
           * typed interface, on the same reasoning as the snapshot table. */
          const recordRows = await sql<{ id: string }>`
            SELECT id FROM publication_records WHERE period_id = ${stage1.fixture.periodId}
          `.execute(uow.query);
          const records = recordRows.rows;
          const published = (await uow.query
            .selectFrom('current_published_assignments')
            .select(['assignment_identity_id'])
            .where('period_id', '=', stage1.fixture.periodId)
            .execute()) as unknown as { assignment_identity_id: string }[];
          return {
            state: version[0]?.state,
            isCurrent: version[0]?.is_current,
            periodStatus: period[0]?.status,
            records: records.length,
            published: published.length,
          };
        });
        if (circulation.state !== 'in_review') {
          throw new Error(
            `the partial draft is ${String(circulation.state)}, not in_review — it was not ` +
              'circulated through the M3 review path',
          );
        }
        if (circulation.isCurrent === true) {
          throw new Error('circulating a partial draft made it the CURRENT version');
        }
        if (circulation.periodStatus !== 'planning') {
          throw new Error(
            `the period is ${String(circulation.periodStatus)} — circulation published it`,
          );
        }
        if (circulation.records !== 0 || circulation.published !== 0) {
          throw new Error(
            `circulation wrote ${String(circulation.records)} publication record(s) and ` +
              `${String(circulation.published)} published assignment(s); a review is not a ` +
              'publication',
          );
        }
        /* PARTIAL: the draft staffs fewer dates than the period spans. A draft
         * that happened to be complete would make "partial circulation" a claim
         * about nothing. */
        const staffedDates = new Set(after.map((placement) => placement.date));
        if (staffedDates.size >= 7) {
          throw new Error(
            `the circulated draft staffs ${String(staffedDates.size)} of the period's 7 dates — ` +
              'it is not partial, so this arm would be vacuous',
          );
        }
        context.tableExercised('publication_records');
        context.tableExercised('current_published_assignments');
        context.observe(
          'partial-circulation',
          `a draft staffing ${String(staffedDates.size)} of 7 dates reached in_review through ` +
            'the existing M3 path; the period is still planning, with 0 publication records and ' +
            '0 published assignments',
        );
        context.policyExercised('I-18 — nothing published, nothing mutated');

        await releaseQueue(tenant, context, 'sbx-017-release');
      } finally {
        restoreSolver();
      }
    },

    /**
     * The probe: the scenario's own preservation oracle, given a stage output in
     * which the protected assignment MOVED to another person.
     *
     * "It is still there, roughly" is the realistic failure — an identity that
     * survives but changes hands satisfies any presence-only check, and it is
     * exactly what report 24's word *exactly* forbids. The probe therefore feeds
     * the oracle that world and requires it to reject, throwing `ProbeFalsified`
     * only after OBSERVING the rejection.
     */
    probe: async (context: SbxRunContext) => {
      const before: ProtectedPlacement = {
        assignmentIdentityId: 'ai-probe',
        membershipId: 'm-probe-a',
        date: '2048-01-06',
        shiftTypeId: 'st-probe',
        isPinned: true,
      };
      const truthful = preservationOracle(before, [before]);
      if (truthful.length > 0) {
        throw new Error(
          `the oracle rejected an exactly-preserved assignment: ${truthful.join('; ')} — the ` +
            'probe has found the oracle broken rather than falsified the scenario',
        );
      }
      context.observe('probe-control', 'the oracle accepts an exactly-preserved assignment');

      const moved: ProtectedPlacement[] = [{ ...before, membershipId: 'm-probe-b' }];
      const problems = preservationOracle(before, moved);
      if (problems.length === 0) return;

      throw new ProbeFalsified(
        `a protected assignment that changed hands was rejected by the scenario's own oracle: ` +
          `${problems.join('; ')}`,
      );
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * The composer
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * The three M4 sandbox scenarios, in report 21 §11's own order.
 *
 * Registered at the END of `buildScenarios`' array deliberately: SBX-015 seeds
 * one HARD `AvoidDate` rule into Alpha Group One, scoped to a single 2047 date,
 * and appending keeps that write strictly after SBX-004's sweep and SBX-018's
 * publication. The rule is date-scoped so it is satisfied vacuously by every
 * other fixture in the harness — but the ordering removes the question rather
 * than answering it.
 */
export function buildM4Scenarios(deps: () => ScenarioDependencies): readonly SbxScenario[] {
  return [buildScenario015(deps), buildScenario016(), buildScenario017(deps)];
}
