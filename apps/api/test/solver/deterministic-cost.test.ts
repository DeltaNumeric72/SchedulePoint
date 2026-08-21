import { randomUUID } from 'node:crypto';

import type { SolverInputSnapshotDocument } from '@schedulepoint/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canonicalInputHash } from '../../src/solver/snapshot-store.js';
import { solveOnWorker, type SolveOutcomeDetail } from '../../src/solver/solver-client.js';
import { log } from '../support/harness.js';
import {
  applySolverEnv,
  BEST_EFFORT_PARAMETERS,
  DETERMINISTIC_PARAMETERS,
} from '../support/solver.js';
import { generatedCorpus } from './corpus/generators.js';

/**
 * **The deterministic-mode COST MEASUREMENT** (OPUS-M4-004; doc 35 §6f ruling 3,
 * SPEC-04 §4 as amended).
 *
 * > its COST is measured on the E1 corpus and RECORDED (per-class wall-clock
 * > ratio vs the default portfolio) — bands are still NOT set (PO-DEC-23
 * > pending; **measurement ≠ band**).
 *
 * (That quotation is the packet's own wording, left exactly as written.
 * PO-DEC-23 has since been RESOLVED — report 21 §8.3's targets are adopted and
 * the benchmark bands are set at M6, ≤ those targets. The operative half is
 * unchanged, and is why this file still asserts no threshold: resolved is not
 * banded, and no band exists until that M6 benchmark runs.)
 *
 * ## This produces evidence, and it asserts almost nothing
 *
 * That is deliberate and it is the honest shape. EV-M0-SPC H-7 measured the
 * deterministic portfolio at roughly **12× slower on a toy instance and *faster*
 * on a hard one**; OPUS-M4-004 measured ≈1× on the thirteen startup-dominated
 * classes and **10.05×** on `B-fairness-shaped`, the one class large enough to
 * search, and did NOT reproduce H-7's faster half at all. A spread that wide
 * across two measurement campaigns is why any threshold this file asserted would
 * be an invented performance band, and no band exists until the M6 benchmark
 * sets one.
 *
 * **The 10.05× is HISTORY, not a current measurement (FAD-50 N-3).** It was
 * taken when `DETERMINISTIC_PARAMETERS` carried `maxTimeInSeconds: 10`, so the
 * deterministic arm was being stopped by a WALL CLOCK at ten seconds while
 * best-effort finished in about one — the ratio was largely that clock, and the
 * `FEASIBLE`-vs-`OPTIMAL` split beside it had the same cause (EV-M4-005 §20a,
 * §21f). Under the repaired 900-second net the same class runs to a proven
 * optimum in ~33s and this file **would not produce 10.05× again**. It is left
 * here as the recorded M4-004 figure with its conditions stated, because
 * deleting a measurement is worse than dating it; re-run this file to get a
 * current one. So it measures, it records, and the only thing it
 * asserts is that both modes produced the SAME OUTCOME CLASS: a cost measurement
 * over two runs that answered differently would be measuring two problems.
 *
 * ## Why it is opt-in
 *
 * Two solves per corpus class, on a machine whose timings are the point, is
 * minutes of wall clock that would be spent on every unrelated battery — and a
 * timing measured under a loaded machine running the rest of a test suite is a
 * timing nobody should record. `SP_MEASURE_DETERMINISTIC_COST=1` runs it; the
 * transcript is captured once, deliberately, on a quiet machine, and lives in
 * `docs/evidence/EV-M4-004/`.
 *
 * It is **not** a gate and does not claim to be one. Nothing here can fail
 * because a solve was slow, because nothing here knows what slow is.
 */

const ENABLED = process.env['SP_MEASURE_DETERMINISTIC_COST'] === '1';

interface Measurement {
  readonly name: string;
  readonly corpusClass: string;
  readonly deterministicMs: number;
  readonly bestEffortMs: number;
  readonly ratio: number | null;
  readonly deterministicStatus: string;
  readonly bestEffortStatus: string;
}

/**
 * The three answers a solve can give ABOUT THE PROBLEM: it found a schedule,
 * there is none, or the worker refused to model it.
 *
 * `OPTIMAL` and `FEASIBLE` are the same class and stay two different STATUSES
 * (SPEC-04 §2/§7 — they are never collapsed anywhere a scheduler reads them).
 * The distinction is whether optimality was proven, which is a fact about the
 * budget the search was given, not about the period.
 */
function outcomeClassOf(status: string): 'solved' | 'infeasible' | 'other' {
  if (status === 'OPTIMAL' || status === 'FEASIBLE') return 'solved';
  if (status === 'INFEASIBLE') return 'infeasible';
  return 'other';
}

async function solveOnce(
  document: SolverInputSnapshotDocument,
  parameters: typeof DETERMINISTIC_PARAMETERS,
): Promise<{ outcome: SolveOutcomeDetail; elapsedMs: number }> {
  const started = Date.now();
  const outcome = await solveOnWorker({
    protocolVersion: 1,
    organizationId: document.organizationId,
    groupId: document.groupId,
    buildRunId: randomUUID(),
    correlationId: 'deterministic-cost',
    snapshotId: randomUUID(),
    canonicalInputHash: canonicalInputHash(document),
    snapshotPayload: document,
    parameters,
  });
  return { outcome, elapsedMs: Date.now() - started };
}

describe.skipIf(!ENABLED)('deterministic mode, measured per corpus class', () => {
  let restore: () => void;
  const measurements: Measurement[] = [];

  beforeAll(() => {
    restore = applySolverEnv();
  });

  afterAll(() => {
    restore();
    const width = Math.max(...measurements.map((row) => row.name.length), 4);
    const lines = [
      '',
      `${'CLASS'.padEnd(width)}  DETERMINISTIC  BEST-EFFORT  RATIO   DET STATUS  BE STATUS`,
      `${'-'.repeat(width)}  -------------  -----------  ------  ----------  ----------`,
      ...measurements.map(
        (row) =>
          `${row.name.padEnd(width)}  ${`${String(row.deterministicMs)} ms`.padStart(13)}  ` +
          `${`${String(row.bestEffortMs)} ms`.padStart(11)}  ` +
          `${(row.ratio === null ? 'n/a' : `${row.ratio.toFixed(2)}×`).padStart(6)}  ` +
          `${row.deterministicStatus.padEnd(10)}  ${row.bestEffortStatus}`,
      ),
      `${'-'.repeat(width)}  -------------  -----------  ------  ----------  ----------`,
      '',
      'RATIO = deterministic wall clock / best-effort wall clock, on THIS machine.',
      'It is a MEASUREMENT, not a band. no benchmark band exists until M6 and no performance',
      'target is set by this run or by any surface that displays it.',
      '',
      'Where the two STATUS columns differ, the deterministic budget stopped the',
      'search before optimality was PROVEN. Both answers are true and both are',
      'about the same problem; the difference is part of the cost being measured.',
      '',
    ];
    for (const line of lines) log(line);
  });

  const corpus = generatedCorpus();

  for (const fixture of corpus) {
    it(`measures ${fixture.name}`, async () => {
      /* Deterministic FIRST, then best-effort. The order is fixed rather than
       * alternated so that a warm/cold effect, if there is one, biases every
       * class the same way and the ratios stay comparable with each other. */
      const deterministic = await solveOnce(fixture.document, DETERMINISTIC_PARAMETERS);
      const bestEffort = await solveOnce(fixture.document, BEST_EFFORT_PARAMETERS);

      /* The only assertion: the two modes answered the same QUESTION. A ratio
       * across two different outcome classes would be a number about two
       * different problems. Deterministic mode changes the search, never the
       * feasibility of the problem.
       *
       * **It compares the CLASS, not the status, and that is a measured
       * finding rather than a loosened assertion.** The first run of this file
       * asserted status equality and `B-fairness-shaped` failed it:
       * best-effort proved `OPTIMAL`, deterministic returned `FEASIBLE`. Both
       * are true and neither is a disagreement about the problem. Asserting
       * status equality would have been asserting that a budget change cannot
       * cost a proof, and it can. The per-class row records both statuses so
       * the fact is visible rather than smoothed away.
       *
       * **ATTRIBUTION CORRECTED (FAD-49(5); EV-M4-005 §20a/§20d).** This comment
       * used to say "the deterministic budget stopped the search before
       * optimality was PROVEN". It did not. The **WALL CLOCK** did: measured on
       * this class, the deterministic run stopped at 9.497948s of its 10s
       * `maxTimeInSeconds` having consumed only **12–22 of the 100** pinned
       * deterministic units, and with the clock raised out of the way the same
       * problem proves `OPTIMAL` at 76.702882 units. The 10.05× ratio quoted in
       * this file's header is that 10-second wall clock against a best-effort
       * run finishing in about a second — a real measurement whose CAUSE was
       * misread. The cost this file measures is real; the sentence naming which
       * limit imposed it was wrong, and is now right. */
      expect(
        outcomeClassOf(bestEffort.outcome.status),
        `${fixture.name}: the modes disagreed`,
      ).toBe(outcomeClassOf(deterministic.outcome.status));
      expect(deterministic.outcome.runtime.reproducibilityMode).toBe('deterministic');
      expect(bestEffort.outcome.runtime.reproducibilityMode).toBe('best-effort');

      measurements.push({
        name: fixture.name,
        corpusClass: fixture.corpusClass,
        deterministicMs: deterministic.elapsedMs,
        bestEffortMs: bestEffort.elapsedMs,
        ratio: bestEffort.elapsedMs === 0 ? null : deterministic.elapsedMs / bestEffort.elapsedMs,
        deterministicStatus: deterministic.outcome.status,
        bestEffortStatus: bestEffort.outcome.status,
      });
    }, 600_000);
  }
});
