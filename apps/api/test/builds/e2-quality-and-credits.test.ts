import { randomUUID } from 'node:crypto';

import {
  buildRunDetailSchema,
  resultReproducibilityVerdictSchema,
} from '@schedulepoint/contracts';

import type { SolverInputSnapshotDocument } from '@schedulepoint/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claimQueuedBuild } from '../../src/builds/claim.js';
import { persistOutcome } from '../../src/builds/runner.js';
import { applyCandidateToNewDraft } from '../../src/builds/selection.js';
import {
  approveRun,
  createRun,
  loadRun,
  markReviewed,
  readConfiguration,
  runResultReproducibility,
  sourceDigestOf,
  transitionRun,
} from '../../src/builds/service.js';
import { compareCandidates, findingsOf, readRunDetail, summaryOf } from '../../src/builds/views.js';
import { stalenessWire } from '../../src/builds/constituent-diff.js';
import { buildStaleness } from '../../src/builds/staleness.js';
import { moveCredit } from '../../src/schedule/service.js';
import { createBuildInput } from '../../src/solver/build-input.js';
import { OBJECTIVE_PROFILE_DIGEST } from '../../src/solver/objective-record.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { seedBuildFixture, syntheticOutcome, type BuildFixture } from '../support/builds.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { scheduleActor } from '../support/schedule.js';

/**
 * **NAMED PROOF — E2 quality persistence, the conflict taxonomy on real rows,
 * comparability enforcement, and the credits ruling both ways** (OPUS-M4-004,
 * doc 35 §6f).
 *
 * Everything here goes through the production write path — `createRun`,
 * `transitionRun`, `claimQueuedBuild`, `persistOutcome`, `applyCandidateToNewDraft`
 * — for the reason the builds fixture already states: a row a fixture could write
 * directly is a row the application could forge, and the whole value of the
 * controls is that it cannot.
 */

const multi = ownedMulti('builds-e2-quality', {
  profile: 'full',
  seed: { catalogue: ['alpha'], schedule: true, scheduleCredentials: true },
});

let runtime: Runtime;
let shiftTypeId: string;
let schedulerUserId: string;
let schedulerMembershipId: string;
let organizationId: string;
let groupId: string;

/** 2044-02-01, and a fortnight per fixture: D-2 refuses overlapping periods. */
const WINDOW_ORIGIN = Date.UTC(2044, 1, 1);
let sequence = -1;

function nextWindow(): { startDate: string; endDate: string } {
  sequence += 1;
  const start = new Date(WINDOW_ORIGIN + sequence * 14 * 86_400_000);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

beforeAll(() => {
  runtime = createRuntime('app_runtime', { max: 8 });
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
  await runtime.destroy();
});

const run = async <T>(
  context: BuildFixture['context'],
  fn: (uow: PgUnitOfWork) => Promise<T>,
): Promise<T> => runtime.runner.run(context, fn);

async function fixture(label: string): Promise<{ seeded: BuildFixture; window: ReturnType<typeof nextWindow> }> {
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
  return { seeded, window };
}

/**
 * Drive one build to a recorded, usable result. Production path throughout, and
 * the snapshot is really PINNED — selection refuses a build without one, and a
 * fixture that skipped it would be proving that refusal instead of the property
 * under test.
 */
async function completedBuild(label: string): Promise<{
  seeded: BuildFixture;
  buildRunId: string;
  document: SolverInputSnapshotDocument;
  window: { startDate: string; endDate: string };
}> {
  const { seeded, window } = await fixture(label);

  const created = await run(seeded.context, async (uow) =>
    createRun(uow, scheduleActor(schedulerUserId), {
      configurationId: seeded.configurationId,
      sourceVersionId: seeded.versionId,
      candidateLabel: label,
      idempotencyKey: `${label}.${randomUUID().slice(0, 12)}`,
    }),
  );

  const persisted = await createBuildInput(runtime.runner, seeded.context, {
    periodId: seeded.periodId,
    versionId: seeded.versionId,
    at: new Date(`${window.startDate}T12:00:00.000Z`),
    idempotencyKey: `e2.${created.buildRunId}`,
  });
  const document = persisted.document;

  await run(seeded.context, async (uow) => {
    const row = await loadRun(uow, created.buildRunId);
    if (row === null) throw new Error('the seeded run vanished');
    const validating = await transitionRun(uow, row, 'validating', { reason: 'submitted' });
    const checking = await transitionRun(uow, validating, 'readiness_check', {
      reason: 'configuration_consistent',
    });
    await uow.query
      .updateTable('build_runs')
      .set({
        snapshot_id: persisted.snapshotId,
        canonical_input_hash: persisted.canonicalInputHash,
      })
      .where('id', '=', created.buildRunId)
      .execute();
    await transitionRun(uow, checking, 'queued', { reason: 'ready' });
  });

  await recordUsableOutcome(seeded, created.buildRunId, document, window.startDate);
  return { seeded, buildRunId: created.buildRunId, document, window };
}

async function recordUsableOutcome(
  seeded: BuildFixture,
  buildRunId: string,
  document: SolverInputSnapshotDocument,
  date: string,
): Promise<void> {
  await run(seeded.context, async (uow) => {
    const claim = await claimQueuedBuild(uow, buildRunId, 'e2.proof.worker');
    if (claim === null) throw new Error('the run could not be claimed');
    const configuration = await readConfiguration(uow, seeded.configurationId);
    if (configuration === null) throw new Error('the configuration vanished');

    await persistOutcome(uow, {
      buildRunId,
      claimEpoch: claim.claimEpoch,
      document,
      outcome: syntheticOutcome(
        claim.run.canonical_input_hash ?? 'a'.repeat(64),
        schedulerMembershipId,
        date,
        shiftTypeId,
      ),
      verdict: { usable: true, rejections: [], findings: [], hardViolations: 0 },
      configuration,
    });
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. The SPEC-04 §4 reproduction record, finally written
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the reproducibility record is recorded on the run (SPEC-04 §4)', () => {
  it('writes the provenance columns 0018 created and nothing had ever filled', async () => {
    /* The defect this closes: migration 0018 declared `solver_version`,
     * `solver_image_digest`, `compiler_version`, `platform_arch` and
     * `reproducibility_mode`, and NOTHING wrote any of them. Every build carried
     * five NULLs and the detail route rendered the absence as a blank. A
     * reproducibility record that is never written is a promise the schema makes
     * and the code does not keep. */
    const { seeded, buildRunId } = await completedBuild('provenance');
    const row = await run(seeded.context, async (uow) => loadRun(uow, buildRunId));

    expect(row?.solver_version).not.toBeNull();
    expect(row?.solver_image_digest).not.toBeNull();
    expect(row?.compiler_version).not.toBeNull();
    expect(row?.platform_arch).not.toBeNull();
    expect(row?.reproducibility_mode).not.toBeNull();
    expect(['deterministic', 'best-effort']).toContain(row?.reproducibility_mode);
    log(
      `      · provenance: ${String(row?.solver_version)} · ${String(row?.platform_arch)} · ` +
        String(row?.reproducibility_mode),
    );
  }, 240_000);

  /**
   * **FAD-49 — the RESULT-side verdict is DERIVED from rows that already exist.**
   *
   * The ruling turned on a factual claim: that the facts needed to tell a
   * reproducible run from a wall-clock-truncated one are *already persisted*, so
   * the repair is a derivation and not a migration. This arm is that claim,
   * checked against a real row written through the production path rather than
   * asserted in a document.
   *
   * Two inputs, two different tables:
   *
   *   * `build_runs.solver_parameters` — written at CLAIM time so a build that
   *     then crashes still says what it ran under;
   *   * `build_run_results.quality_metrics.solverStatistics.wallTimeSeconds` —
   *     written with the result.
   *
   * **What this arm MEASURED, and the limit it found.** The statistics half is
   * there and readable. The parameters half is written in exactly ONE place —
   * `runQueuedBuild` (`runner.ts`), the real dispatch path — and this fixture
   * reaches a persisted result through the lower-level `claimQueuedBuild` +
   * `persistOutcome` pair instead, so it produces a row shape production cannot:
   * `reproducibility_mode` set, `solver_parameters` empty.
   *
   * That is not a defect in the fixture and it is not smoothed over. It is the
   * case the derivation has to survive, and this arm is where it is proven to:
   * **a row whose parameters were never recorded never claims reproducibility.**
   * The derivation-with-parameters direction is proven over explicit row shapes
   * in `result-reproducibility-wiring.test.ts`, and the predicate itself in
   * `packages/domain/test/ports/result-reproducibility.test.ts`.
   */
  it('the statistics the verdict reads are persisted, and an unrecorded parameter set never claims reproducibility', async () => {
    const { seeded, buildRunId } = await completedBuild('result-repro');
    const row = await run(seeded.context, async (uow) => loadRun(uow, buildRunId));
    if (row === null) throw new Error('the seeded run vanished');
    const detail = await run(seeded.context, async (uow) => readRunDetail(uow, buildRunId));

    /* 1. The statistics really are persisted, and really do round-trip through
     *    `qualityOf` — this is the field the verdict reads, and FAD-49(1)'s
     *    "no schema change" rests on it being here. */
    const statistics = detail.result?.quality.solverStatistics ?? {};
    expect(Object.keys(statistics)).toContain('wallTimeSeconds');

    /* 2. A run recorded through this path carries no parameter set… */
    const parameters = (row.solver_parameters ?? {}) as Record<string, unknown>;
    expect(parameters['maxTimeInSeconds']).toBeUndefined();

    /* 3. …so every verdict over it is `unrecorded`, whatever search time is
     *    offered. Fail-closed, and it is the ONLY safe answer: a row that
     *    cannot say what it ran under cannot promise to run the same way. */
    for (const wall of [null, 0.001, 9.5, 10_000]) {
      /* Both clocks offered, and generously — FAD-52 added the second, and a row
       * with no parameter set must still refuse whatever either of them says. */
      for (const units of [null, 0.0, 8.076904, 100]) {
        const verdict = runResultReproducibility(row, {
          wallTimeSeconds: wall,
          deterministicTimeUnits: units,
        });
        expect(verdict?.verdict, `wall ${String(wall)}, units ${String(units)}`).toBe('unrecorded');
        expect(verdict?.reproducible).toBe(false);
      }
    }

    /* 4. And a run with NO runtime record at all reports nothing rather than
     *    reporting a refusal — there is no result to be honest about yet. */
    expect(
      runResultReproducibility(
        { ...row, reproducibility_mode: null },
        { wallTimeSeconds: 1, deterministicTimeUnits: 1 },
      ),
    ).toBeNull();

    log(
      `      · persisted solverStatistics carry wallTimeSeconds; this fixture path ` +
        `records no solver_parameters, and the verdict fails closed as 'unrecorded'`,
    );
  }, 240_000);

  /**
   * **RP-2 — the whole detail payload, as the route builds it** (FAD-50 B-1/C-4).
   *
   * The reviewer's second probe read a production-path run back through the
   * shipped route and found the reproducibility claim there, on the wire. This
   * is that shape as a permanent proof: a run created and completed through the
   * production write path, composed EXACTLY as `builds.route.ts` composes its
   * response, and then parsed by the route's OWN contract.
   *
   * The contract parse is the load-bearing half. `buildRunDetailSchema` is
   * `.strict()`, so a field the projection was supposed to remove — a
   * constituent `key`, a `pinnedRevision` — makes this throw rather than pass
   * quietly, and a verdict outside the six-value enum does the same. Two
   * separate disclosure repairs, guarded by one parse.
   *
   * HTTP itself is not stood up here: the request/response layer is proven over
   * this same route by `builds-http.test.ts` and end to end in
   * `apps/web/e2e/critical-path.spec.ts`. What only this arm can prove is that
   * the composed payload for a REAL persisted run satisfies the contract.
   */
  it('RP-2: the composed detail payload for a real run satisfies the route’s contract', async () => {
    const { seeded, buildRunId } = await completedBuild('rp2-route');
    const row = await run(seeded.context, async (uow) => loadRun(uow, buildRunId));
    if (row === null) throw new Error('the seeded run vanished');

    const payload = await run(seeded.context, async (uow) => {
      const detail = await readRunDetail(uow, buildRunId);
      /* The route's own expression, kept in step with it deliberately: if the
       * route starts composing this differently, this arm stops testing the
       * route and that is a change a reader can see here. */
      return {
        /* `summaryFor` is private to the route; this is its body, which is the
           only part of the composition that cannot simply be imported. */
        run: summaryOf(
          row,
          (await readConfiguration(uow, row.build_configuration_id))?.name ?? '',
          (await readConfiguration(uow, row.build_configuration_id))?.retry_limit ?? 0,
        ),
        validationFindings: findingsOf(row.validation_findings),
        readinessFindings: findingsOf(row.readiness_findings),
        result: detail.result,
        violations: detail.violations,
        conflicts: detail.conflicts,
        events: detail.events,
        sourceDigest: await sourceDigestOf(uow, row),
        reproducibility: row.reproducibility_mode,
        resultReproducibility: runResultReproducibility(row, {
          wallTimeSeconds: detail.result?.quality.solverStatistics['wallTimeSeconds'] ?? null,
          deterministicTimeUnits:
            detail.result?.quality.solverStatistics['deterministicTimeUnits'] ?? null,
        }),
        staleness: stalenessWire(await buildStaleness(uow, row)),
        correlationId: 'rp2',
      };
    });

    /* THE PARSE. `.strict()`, so this is where a leaked field lands. */
    const parsed = buildRunDetailSchema.parse(payload);

    /* B-1: the verdict is on the wire, and it is one the enum admits (FAD-52).
     *
     * **The list is the SCHEMA's own, since OPUS-M5-H (FU-13, R-7's C-4).** It
     * used to be six string literals typed out here, under a comment conceding
     * the hazard in as many words — "an assertion that lagged the enum would fail
     * on an honest value". A seventh verdict added to the contract would have
     * turned this arm red for a value that was perfectly correct, and the repair
     * anybody makes under that pressure is to add the literal, which is the
     * transcription this file exists to avoid. `schema.options` is the same list
     * with one author. */
    expect(parsed.resultReproducibility).not.toBeUndefined();
    if (parsed.resultReproducibility !== null) {
      /* Non-vacuity: an empty options array would make `toContain` fail rather
         than pass, but a one-member one would pass for the wrong reason. */
      expect(resultReproducibilityVerdictSchema.options.length).toBeGreaterThan(1);
      expect([...resultReproducibilityVerdictSchema.options]).toContain(
        parsed.resultReproducibility.verdict,
      );
      expect(parsed.resultReproducibility.detail.length).toBeGreaterThan(0);
      /* and a verdict that refuses never carries the promise sentence */
      if (!parsed.resultReproducibility.reproducible) {
        expect(parsed.resultReproducibility.detail).not.toContain('produces the same schedule');
      }
    }

    /* C-4: the staleness on the wire is class-level, with no identifiers. */
    const serialized = JSON.stringify(parsed.staleness);
    expect(serialized).not.toContain('"key"');
    expect(serialized).not.toContain('pinnedRevision');
    for (const change of parsed.staleness.changes) {
      expect(Object.keys(change).sort()).toEqual(['count', 'direction', 'kind']);
    }

    log(
      `      · RP-2: the composed detail parses; verdict ` +
        `'${String(parsed.resultReproducibility?.verdict)}', staleness ` +
        `${String(parsed.staleness.changes.length)} class(es), ` +
        `${String(parsed.staleness.changeCount)} change(s)`,
    );
  }, 240_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. The metric set, and the taxonomy over real rows
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the quality record and PO-DEC-13 taxonomy, over persisted rows', () => {
  it('persists the objective digest, the scale and the fairness basis', async () => {
    const { seeded, buildRunId } = await completedBuild('quality');
    const detail = await run(seeded.context, async (uow) => readRunDetail(uow, buildRunId));

    expect(detail.result).not.toBeNull();
    expect(detail.result?.quality.objectiveWeightsDigest).toBe(OBJECTIVE_PROFILE_DIGEST);
    expect(detail.result?.quality.objectiveScale).toBeGreaterThan(0);
    expect(detail.result?.quality.fairnessNormalisation).toBe('fte-work-percentage');
    /* SPEC-04 §7's two unmeasurable rates stay NULL through persistence and
     * re-read. A `0` surviving the round trip would be the claim, not the gap. */
    expect(detail.result?.quality.requestHonourRate).toBeNull();
    expect(detail.result?.quality.templateAdherenceRate).toBeNull();
    expect(Object.keys(detail.result?.quality.solverStatistics ?? {}).length).toBeGreaterThan(0);
  }, 240_000);

  it('classifies a shortfall as unmet demand, and orders it below a hard breach', async () => {
    const { seeded, window } = await fixture('taxonomy');
    const created = await run(seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: seeded.configurationId,
        sourceVersionId: seeded.versionId,
        candidateLabel: 'taxonomy',
        idempotencyKey: `taxonomy.${randomUUID().slice(0, 12)}`,
      }),
    );
    const persisted = await createBuildInput(runtime.runner, seeded.context, {
      periodId: seeded.periodId,
      versionId: seeded.versionId,
      at: new Date(`${window.startDate}T12:00:00.000Z`),
      idempotencyKey: `e2.taxonomy.${created.buildRunId}`,
    });
    const document = persisted.document;

    await run(seeded.context, async (uow) => {
      const row = await loadRun(uow, created.buildRunId);
      if (row === null) throw new Error('vanished');
      const validating = await transitionRun(uow, row, 'validating', { reason: 'submitted' });
      const checking = await transitionRun(uow, validating, 'readiness_check', {
        reason: 'configuration_consistent',
      });
      await uow.query
        .updateTable('build_runs')
        .set({
          snapshot_id: persisted.snapshotId,
          canonical_input_hash: persisted.canonicalInputHash,
        })
        .where('id', '=', created.buildRunId)
        .execute();
      await transitionRun(uow, checking, 'queued', { reason: 'ready' });
    });

    /* A candidate the checker refused, with a HARD finding and NO assignments —
     * so the projection carries a hard breach AND a demand shortfall, which is
     * exactly the case where the ordering matters. */
    await run(seeded.context, async (uow) => {
      const claim = await claimQueuedBuild(uow, created.buildRunId, 'e2.tax.worker');
      if (claim === null) throw new Error('unclaimable');
      const configuration = await readConfiguration(uow, seeded.configurationId);
      if (configuration === null) throw new Error('vanished');
      const outcome = syntheticOutcome(
        claim.run.canonical_input_hash ?? 'a'.repeat(64),
        schedulerMembershipId,
        document.startDate,
        shiftTypeId,
      );
      await persistOutcome(uow, {
        buildRunId: created.buildRunId,
        claimEpoch: claim.claimEpoch,
        document,
        outcome: { ...outcome, assignments: [] },
        verdict: {
          usable: false,
          rejections: [
            {
              reason: 'hard-violation',
              findings: [
                {
                  finding: 'breach',
                  ruleKey: 'e2.taxonomy.rest',
                  nodeKind: 'MinimumRestBetween',
                  field: 'candidate#0',
                  explanation: 'a synthetic rest breach, so the taxonomy has a hard breach to file',
                },
              ],
            },
          ],
          findings: [
            {
              finding: 'breach',
              ruleKey: 'e2.taxonomy.rest',
              nodeKind: 'MinimumRestBetween',
              field: 'candidate#0',
              explanation: 'a synthetic rest breach, so the taxonomy has a hard breach to file',
            },
          ],
          hardViolations: 1,
        },
        configuration,
      });
    });

    const detail = await run(seeded.context, async (uow) =>
      readRunDetail(uow, created.buildRunId),
    );
    const classes = detail.conflicts.map((conflict) => conflict.conflictClass);
    expect(classes).toContain('hard-breach');
    expect(classes).toContain('unmet-demand');
    /* Severity order, not arrival order and not alphabetical. */
    expect(classes.indexOf('hard-breach')).toBeLessThan(classes.indexOf('unmet-demand'));
    for (const conflict of detail.conflicts) {
      if (conflict.conflictClass === 'fairness-outlier') {
        expect(conflict.blocksApproval).toBe(false);
        expect(conflict.banded).toBe(false);
      } else {
        expect(conflict.blocksApproval).toBe(true);
      }
    }
    log(`      · conflicts, in severity order: ${classes.join(' → ')}`);
  }, 240_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Comparability — same snapshot AND same weights, enforced
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the comparison service enforces comparability', () => {
  it('refuses two candidates built from DIFFERENT problems', async () => {
    /* Two builds in two periods: different canonical inputs by construction.
     * Their placement differences would be differences of INPUT, not of choice. */
    const first = await completedBuild('compare-a');
    const second = await completedBuild('compare-b');

    const projection = await run(first.seeded.context, async (uow) =>
      compareCandidates(uow, [first.buildRunId, second.buildRunId]),
    );
    expect(projection.comparability.comparable).toBe(false);
    expect(
      projection.comparability.comparable ? null : projection.comparability.reason,
    ).toBe('cross-snapshot');
    /* And the projection is EMPTY. A difference list across two problems sitting
     * in a response is one careless read away from a column. */
    expect(projection.differences).toEqual([]);
    expect(projection.sharedAssignmentCount).toBe(0);
  }, 300_000);

  it('accepts two candidates of ONE problem — the arm that makes the refusal mean something', async () => {
    /* The control. Without it the refusal above could be a comparison that never
     * succeeds. Two runs of the same configuration cannot be in flight at once
     * (D-4a), so the second is created after the first has settled, against the
     * same source version and therefore the same pinned input. */
    const first = await completedBuild('compare-same');

    const second = await run(first.seeded.context, async (uow) =>
      createRun(uow, scheduleActor(schedulerUserId), {
        configurationId: first.seeded.configurationId,
        sourceVersionId: first.seeded.versionId,
        candidateLabel: 'compare-same-2',
        idempotencyKey: `compare-same-2.${randomUUID().slice(0, 12)}`,
      }),
    );
    const persisted = await createBuildInput(runtime.runner, first.seeded.context, {
      periodId: first.seeded.periodId,
      versionId: first.seeded.versionId,
      at: new Date(`${first.window.startDate}T12:00:00.000Z`),
      /* The SAME idempotency key as the first run, so the assembly REPLAYS the
       * one pinned snapshot rather than making a second one. Two candidates of
       * one problem is exactly what D-4c compares. */
      idempotencyKey: `e2.${first.buildRunId}`,
    });
    expect(persisted.canonicalInputHash).toBe(
      (await run(first.seeded.context, async (uow) => loadRun(uow, first.buildRunId)))
        ?.canonical_input_hash,
    );

    await run(first.seeded.context, async (uow) => {
      const row = await loadRun(uow, second.buildRunId);
      if (row === null) throw new Error('vanished');
      const validating = await transitionRun(uow, row, 'validating', { reason: 'submitted' });
      const checking = await transitionRun(uow, validating, 'readiness_check', {
        reason: 'configuration_consistent',
      });
      await uow.query
        .updateTable('build_runs')
        .set({
          snapshot_id: persisted.snapshotId,
          canonical_input_hash: persisted.canonicalInputHash,
        })
        .where('id', '=', second.buildRunId)
        .execute();
      await transitionRun(uow, checking, 'queued', { reason: 'ready' });
    });
    await recordUsableOutcome(
      first.seeded,
      second.buildRunId,
      first.document,
      first.window.startDate,
    );

    const projection = await run(first.seeded.context, async (uow) =>
      compareCandidates(uow, [first.buildRunId, second.buildRunId]),
    );
    expect(projection.comparability.comparable).toBe(true);
    log('      · same problem, same weights: comparable; different problems: refused');
  }, 300_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. The credits ruling — doc 35 §6f (1), pinned BOTH ways
 * ──────────────────────────────────────────────────────────────────────────── */

describe('a build-produced draft starts WITHOUT credits (doc 35 §6f ruling 1)', () => {
  it('apply-selection writes ZERO credit rows', async () => {
    /* A credit records human adjudication of burden (doc 07). A schedule
     * produced by optimization has not been adjudicated by anyone, and
     * manufacturing credits from it would launder an objective value into a
     * human record — which the next build would then read back as history
     * through the fairness terms' prior-credit input. */
    const { seeded, buildRunId } = await completedBuild('credits-none');
    await run(seeded.context, async (uow) => {
      await markReviewed(uow, scheduleActor(schedulerUserId), buildRunId, 'completed');
      await approveRun(uow, scheduleActor(schedulerUserId), buildRunId, 'reviewed');
      return null;
    });

    const digest = await run(seeded.context, async (uow) => {
      const row = await loadRun(uow, buildRunId);
      if (row === null) throw new Error('vanished');
      return sourceDigestOf(uow, row);
    });

    const applied = await run(seeded.context, async (uow) =>
      applyCandidateToNewDraft(uow, scheduleActor(schedulerUserId), buildRunId, 'approved', digest),
    );
    expect(applied.assignmentsWritten).toBeGreaterThan(0);

    const credits = await run(seeded.context, async ({ query }) =>
      sql<{ n: string }>`SELECT count(*)::text AS n FROM credits
                         WHERE source_version_id = ${applied.draftVersionId}::uuid`.execute(query),
    );
    expect(credits.rows[0]?.n).toBe('0');
    log('      · the build-produced draft carries zero credits');
  }, 300_000);

  it('and the M3 credit surface then works ON that draft — the other direction', async () => {
    /* The half that makes the first one a ruling rather than a gap. The
     * scheduler assigns credits on the new draft through the existing surface;
     * nothing about the build path removed that. */
    const { seeded, buildRunId } = await completedBuild('credits-then');
    await run(seeded.context, async (uow) => {
      await markReviewed(uow, scheduleActor(schedulerUserId), buildRunId, 'completed');
      await approveRun(uow, scheduleActor(schedulerUserId), buildRunId, 'reviewed');
      return null;
    });
    const digest = await run(seeded.context, async (uow) => {
      const row = await loadRun(uow, buildRunId);
      if (row === null) throw new Error('vanished');
      return sourceDigestOf(uow, row);
    });
    const applied = await run(seeded.context, async (uow) =>
      applyCandidateToNewDraft(uow, scheduleActor(schedulerUserId), buildRunId, 'approved', digest),
    );

    const written = await run(seeded.context, async (uow) =>
      uow.query
        .selectFrom('assignment_snapshots')
        .select(['id', 'assignment_identity_id', 'membership_id'])
        .where('version_id', '=', applied.draftVersionId)
        .where('status', '=', 'active')
        .execute(),
    );
    const row = written[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    const creditId = await run(seeded.context, async (uow) =>
      moveCredit(uow, scheduleActor(schedulerUserId), {
        versionId: applied.draftVersionId,
        assignmentIdentityId: row.assignment_identity_id,
        snapshotId: row.id,
        creditedMembershipId: row.membership_id,
      }),
    );
    expect(creditId).toMatch(/^[0-9a-f-]{36}$/);

    const after = await run(seeded.context, async ({ query }) =>
      sql<{ n: string }>`SELECT count(*)::text AS n FROM credits
                         WHERE source_version_id = ${applied.draftVersionId}::uuid`.execute(query),
    );
    expect(after.rows[0]?.n).toBe('1');
    log('      · a credit was then assigned on the draft through the M3 surface');
  }, 300_000);
});
