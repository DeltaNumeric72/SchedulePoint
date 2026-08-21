import type { BuildViolation } from '@schedulepoint/contracts';
import {
  EVALUATED_HARD_RULE_KINDS,
  compileRule,
  evaluateHardRules,
  type CheckedVersion,
  type HardRuleFinding,
  type Rule,
  type SolverInputSnapshotDocument,
} from '@schedulepoint/domain';

import { conflictsOf } from '../../src/builds/conflicts.js';
import { validateCandidate } from '../../src/solver/candidate-validation.js';
import { ProbeFalsified, type SbxScenario } from './contract.js';
import {
  HARD_KIND_INJECTIONS,
  PINNED_WEEKDAYS,
  M_A,
  uninjectedKinds,
  weekdayOfDate,
  type HardKindInjection,
} from './injections-016.js';

/**
 * **SBX-016 — conflict detection: 100% of injected hard violations detected and
 * explained.**
 *
 * Report 21 §11 names the test; report 24 §3.4 is the gate it feeds:
 *
 * > **Requires:** 100% of injected hard violations detected, each with severity,
 * > explanation, and remediation; sign-off blocked while unresolved hard
 * > violations remain.
 * > **Evidence:** SBX-016 against a fixture with deliberately injected defects.
 *
 * ## Two boundaries, and the distinction is load-bearing
 *
 * **The checker boundary** — `evaluateHardRules(compiled, version)` — is where a
 * violation is *detected*. Every one of the 22 M4-evaluable HARD kinds is
 * injected there, because that is the only boundary at which all 22 are
 * reachable: a solver-produced candidate carries no pick position by
 * construction (RK-RULING-04), so `PickPositionRestriction` cannot be breached
 * through the candidate path at all. That is NAMED below rather than narrated,
 * per doc 35 §6g's escalation rule.
 *
 * **The build boundary** — `validateCandidate` then `conflictsOf` — is where a
 * detected violation becomes something a scheduler sees: a classified,
 * severity-ordered conflict that blocks approval. One injection is carried the
 * whole way through it, so the scenario proves a chain rather than a function.
 *
 * ## What is NOT claimed
 *
 * Report 24 §3.4 asks for three things per conflict and this system produces two
 * and a half: severity (`severityRank`), explanation (`detail`, in domain terms)
 * and the blocking decision (`blocksApproval`) — and **no remediation text**.
 * There is no remediation field in `BuildConflict`. That is recorded as a named
 * `EVIDENCE_BLOCKED` sub-scenario rather than absorbed into a pass.
 */

/** One kind's measured outcome. The oracle reads these and nothing else. */
export interface DetectionReading {
  readonly kind: string;
  readonly ruleKey: string;
  /** Breach findings the checker produced for THIS rule on the breached world. */
  readonly breachFindings: readonly HardRuleFinding[];
  /** Every finding the checker produced for THIS rule on the satisfied twin. */
  readonly satisfiedFindings: readonly HardRuleFinding[];
  readonly expectedTerms: readonly string[];
}

/**
 * **The oracle.** Extracted so the probe re-executes exactly what ships.
 *
 * Four conjuncts, all counted rather than judged:
 *
 *  1. **totality** — every kind in `EVALUATED_HARD_RULE_KINDS` has a reading;
 *  2. **detection** — each reading carries at least one `breach` finding whose
 *     `nodeKind` is that kind and whose `ruleKey` is the injected key. A finding
 *     of the wrong kind is not a detection of this one;
 *  3. **explanation in domain terms** — the breach explanation names every
 *     domain identifier the injection declared. A detector answering "rule 7 was
 *     violated" passes (2) and fails here, which is the distinction report 24
 *     §3.4 draws by writing "and explained";
 *  4. **non-vacuity** — the satisfied twin produces ZERO findings for that rule.
 *     Without this a checker that breached on everything would score 100%.
 */
export function detectionOracle(readings: readonly DetectionReading[]): readonly string[] {
  const problems: string[] = [];

  const covered = new Set(readings.map((reading) => reading.kind));
  for (const kind of EVALUATED_HARD_RULE_KINDS) {
    if (!covered.has(kind)) problems.push(`no injection for evaluated kind ${kind}`);
  }

  for (const reading of readings) {
    const matched = reading.breachFindings.filter(
      (finding) =>
        finding.finding === 'breach' &&
        finding.nodeKind === reading.kind &&
        finding.ruleKey === reading.ruleKey,
    );
    if (matched.length === 0) {
      problems.push(
        `${reading.kind}: the injected violation was NOT detected ` +
          `(${String(reading.breachFindings.length)} finding(s), none a breach of ` +
          `${reading.ruleKey} as ${reading.kind})`,
      );
      continue;
    }

    const explained = matched.filter((finding) =>
      reading.expectedTerms.every((term) => finding.explanation.includes(term)),
    );
    if (explained.length === 0) {
      problems.push(
        `${reading.kind}: detected but NOT explained in domain terms — no breach explanation ` +
          `names all of [${reading.expectedTerms.join(', ')}]; got ` +
          `"${matched[0]?.explanation ?? ''}"`,
      );
    }

    if (reading.satisfiedFindings.length > 0) {
      problems.push(
        `${reading.kind}: the SATISFIED twin also produced ${String(
          reading.satisfiedFindings.length,
        )} finding(s) — this kind's detection is vacuous`,
      );
    }
  }

  return problems;
}

/** Run one injection through the production checker, both directions. */
function readInjection(injection: HardKindInjection): DetectionReading {
  const compiled = [compileRule(injection.rule)];
  const forRule = (version: CheckedVersion): readonly HardRuleFinding[] =>
    evaluateHardRules(compiled, version).filter(
      (finding) => finding.ruleKey === injection.rule.ruleKey,
    );
  return {
    kind: injection.kind,
    ruleKey: injection.rule.ruleKey,
    breachFindings: forRule(injection.breached),
    satisfiedFindings: forRule(injection.satisfied),
    expectedTerms: injection.expectedTerms,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The build boundary: one injection carried through validateCandidate ->
 * conflictsOf, so the scenario proves a chain rather than a pure function.
 * ──────────────────────────────────────────────────────────────────────────── */

const ANCHOR_ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const ANCHOR_GROUP = '22222222-2222-4222-8222-222222222222';
const ANCHOR_PERIOD = '33333333-3333-4333-8333-333333333333';
const ANCHOR_VERSION = '44444444-4444-4444-8444-444444444444';
const ANCHOR_SHIFT_TYPE = '55555555-5555-4555-8555-555555555555';
const ANCHOR_MEMBERSHIP = '66666666-6666-4666-8666-666666666666';
const ANCHOR_HASH = 'a'.repeat(64);
const ANCHOR_DATE = '2031-06-05';
const ANCHOR_RULE_KEY = 'inj_anchor_avoid_date';

/**
 * The smallest snapshot a HARD-rule breach can be injected into: one day, one
 * shift type, one eligible participant, one required slot the candidate fills —
 * and one HARD `AvoidDate` rule forbidding that exact date.
 *
 * Demand is satisfied EXACTLY, so the hard-rule breach is the only reason the
 * checker can refuse. A snapshot with unmet or over-filled demand would also
 * raise `demand-not-met`, and the assertion "the only rejection is the injected
 * one" would stop meaning anything.
 */
function anchorSnapshot(): SolverInputSnapshotDocument {
  const rule = {
    ruleKey: ANCHOR_RULE_KEY,
    revision: '1',
    ruleSchemaVersion: 1,
    classification: 'HARD' as const,
    category: 'general' as const,
    weight: null,
    status: 'active' as const,
    scope: {},
    predicate: { kind: 'AvoidDate', date: ANCHOR_DATE },
  };
  return {
    snapshotSchemaVersion: 2,
    compilerVersion: 1,
    ruleSchemaVersion: 1,
    organizationId: ANCHOR_ORGANIZATION,
    groupId: ANCHOR_GROUP,
    periodId: ANCHOR_PERIOD,
    versionId: ANCHOR_VERSION,
    periodName: 'SBX-016 anchor',
    periodStatus: 'planning',
    startDate: ANCHOR_DATE,
    endDate: ANCHOR_DATE,
    dayCount: 1,
    timezone: { basis: 'UTC', tzdbVersion: '2025a', source: 'version-snapshot' },
    locations: [],
    shiftTypes: [
      {
        shiftTypeId: ANCHOR_SHIFT_TYPE,
        code: 'DAY',
        startTime: '08:00:00',
        endTime: '16:00:00',
        crossesMidnight: false,
        isManualOnly: false,
        isOnCall: false,
        creditWeight: '1.0',
        status: 'active',
        requiredQualificationIds: [],
      },
    ],
    demand: [
      {
        source: 'period-requirement',
        shiftTypeId: ANCHOR_SHIFT_TYPE,
        on: ANCHOR_DATE,
        requiredCount: 1,
      },
    ],
    participants: [
      {
        membershipId: ANCHOR_MEMBERSHIP,
        membershipKind: 'group',
        staffingKind: 'staff',
        status: 'active',
        validFrom: '2031-01-01',
        validTo: null,
        workProfile: null,
        holdings: [],
        eligibility: [{ shiftTypeId: ANCHOR_SHIFT_TYPE, eligible: true, outcomes: [] }],
      },
    ],
    fixedAssignments: [],
    ruleRevisions: [rule],
    staffGroups: [],
    validGroups: [],
    qualifications: [],
    constituents: [],
  } as unknown as SolverInputSnapshotDocument;
}

export function buildScenario016(): SbxScenario {
  return {
    id: 'SBX-016',
    title: 'Conflict detection — 100% of injected hard violations detected and explained',
    /* G-PROD depends on this evidence (report 24 §3.4, CAP-059), so an
     * EVIDENCE_BLOCKED here would fail the run rather than rest acceptably. */
    gateRequired: true,
    blocked: [
      {
        subScenario:
          'per-conflict REMEDIATION guidance ("each with severity, explanation, and remediation")',
        dependency:
          'no remediation field exists on `BuildConflict` (packages/contracts/src/builds/' +
          'lifecycle.ts). Severity (`severityRank`), explanation (`detail`) and the blocking ' +
          'decision (`blocksApproval`) are all produced and asserted below; remediation text is ' +
          'not modelled anywhere at M4 and is not invented here',
      },
      {
        subScenario:
          'injecting PickPositionRestriction through the SOLVER CANDIDATE path (validateCandidate)',
        dependency:
          'RK-RULING-04: a solver-produced candidate row carries `pickPosition: null` by ' +
          'construction (apps/api/src/solver/candidate-validation.ts), which the ruling makes ' +
          'satisfy the restriction VACUOUSLY. The kind is injected and detected at the checker ' +
          'boundary below; it is unreachable at the candidate boundary by design, not by gap',
      },
    ],
    contract: {
      owner: 'OPUS-M4-005 (implementer) / Fable (acceptance)',
      fixtureProvenance:
        'apps/api/test/sbx/injections-016.ts — a table of 22 injected defects, one per kind in ' +
        '`EVALUATED_HARD_RULE_KINDS`, each carrying the world that violates the rule and the ' +
        'same world with one fact moved. Wholly synthetic: `m-sbx016-*` handles, June 2031 ' +
        'dates, DAY/NIGHT/CALL codes; no organization, site or person name of any kind, and no ' +
        'database. Reproducible from the module alone.',
      deterministicSetup:
        'Pure functions over in-memory fixtures: `compileRule` + `evaluateHardRules` for the ' +
        'checker boundary, `validateCandidate` + `conflictsOf` for the build boundary. No ' +
        'clock, no cluster, no concurrency, no ordering dependence — every reading is computed ' +
        'from its own fixture. The weekday facts three injections depend on are ASSERTED by ' +
        '`weekdayOfDate` in the run rather than assumed.',
      externalDependency: 'None. Nothing outside this process.',
      faultControls:
        '22 injected faults, one per evaluated HARD kind — the deliberately injected defects ' +
        'report 24 §3.4 requires. Each is paired with a SATISFIED twin (the mutation control) ' +
        'that must produce zero findings. The falsifiability probe injects a 23rd fault into ' +
        'the MEASUREMENT: it removes one kind\'s breach finding from the reading set and ' +
        'requires the oracle to reject the result as an undetected violation.',
      objectiveOracle:
        'Four conjuncts, all counted: (1) TOTALITY — every kind in EVALUATED_HARD_RULE_KINDS ' +
        'has an injection; (2) DETECTION — each injection produces at least one `breach` ' +
        'finding whose nodeKind is that kind and whose ruleKey is the injected key, so the ' +
        'detection rate is 22/22 = 100%; (3) EXPLANATION IN DOMAIN TERMS — that breach ' +
        "explanation names every domain identifier the injection declared (membership handle, " +
        'date, shift-type code, staff/valid-group id, pick position); (4) NON-VACUITY — the ' +
        'satisfied twin produces ZERO findings for the same rule. Plus the build boundary: the ' +
        'anchor injection makes `validateCandidate` return usable=false with exactly one ' +
        '`hard-violation` rejection carrying the breach, and `conflictsOf` classifies it ' +
        '`hard-breach` with severityRank 1 and blocksApproval true.',
      retainedArtifact: 'docs/evidence/EV-M4-005/sbx-016-conflict-detection.txt',
      environment: 'MULTI',
      earliestExecutionPoint: 'E2',
    },

    run: async (context) => {
      /* ── the weekday pins three injections rest on ─────────────────────── */
      for (const [date, weekday] of PINNED_WEEKDAYS) {
        const actual = weekdayOfDate(date);
        if (actual !== weekday) {
          throw new Error(`the fixture assumes ${date} is ${weekday}; it is ${actual}`);
        }
      }
      context.observe(
        'weekday-pins',
        `${String(PINNED_WEEKDAYS.length)} weekday facts asserted, not assumed`,
      );

      /* ── totality, before anything is measured ─────────────────────────── */
      const missing = uninjectedKinds();
      if (missing.length > 0) {
        throw new Error(
          `these evaluated HARD kinds have no injection: ${missing.join(', ')} — ` +
            'a detection rate over a subset is not a detection rate',
        );
      }
      if (HARD_KIND_INJECTIONS.length !== EVALUATED_HARD_RULE_KINDS.length) {
        throw new Error(
          `${String(HARD_KIND_INJECTIONS.length)} injections for ` +
            `${String(EVALUATED_HARD_RULE_KINDS.length)} evaluated kinds`,
        );
      }

      /* ── the sweep ─────────────────────────────────────────────────────── */
      const readings = HARD_KIND_INJECTIONS.map(readInjection);
      const problems = detectionOracle(readings);
      if (problems.length > 0) {
        throw new Error(`the detection oracle rejected: ${problems.join('; ')}`);
      }

      const detected = readings.filter((reading) =>
        reading.breachFindings.some(
          (finding) => finding.finding === 'breach' && finding.nodeKind === reading.kind,
        ),
      ).length;
      context.observe(
        'detection-rate',
        `${String(detected)}/${String(readings.length)} injected hard violations detected ` +
          `(${((detected / readings.length) * 100).toFixed(0)}%), every one explained in domain ` +
          'terms, every satisfied twin clean',
      );
      for (const injection of HARD_KIND_INJECTIONS) {
        const reading = readings.find((r) => r.kind === injection.kind);
        context.observe(
          `injected-${injection.kind}`,
          `${injection.defect} -> ${String(reading?.breachFindings.length ?? 0)} breach ` +
            `finding(s); satisfied twin ${String(reading?.satisfiedFindings.length ?? 0)}. ` +
            `explanation: ${reading?.breachFindings[0]?.explanation ?? '(none)'}`,
        );
      }
      context.policyExercised('FAD-27 (a HARD rule that cannot be evaluated blocks)');
      context.policyExercised('report 24 §3.4 — 100% of injected hard violations detected');

      /* ── the build boundary, end to end ────────────────────────────────── */
      const snapshot = anchorSnapshot();
      const verdict = validateCandidate({
        snapshot,
        assignments: [
          {
            membershipId: ANCHOR_MEMBERSHIP,
            date: ANCHOR_DATE,
            shiftTypeId: ANCHOR_SHIFT_TYPE,
            locationId: null,
          },
        ],
        expectedInputHash: ANCHOR_HASH,
        reportedInputHash: ANCHOR_HASH,
      });

      if (verdict.usable) {
        throw new Error('the independent checker admitted a candidate breaching a HARD rule');
      }
      const reasons = verdict.rejections.map((rejection) => rejection.reason).sort();
      if (reasons.join(',') !== 'hard-violation') {
        throw new Error(
          `the anchor was refused for [${reasons.join(', ')}] rather than for the injected hard ` +
            'violation alone — the fixture is not isolating the injection',
        );
      }
      const anchorBreach = verdict.findings.find(
        (finding) => finding.finding === 'breach' && finding.ruleKey === ANCHOR_RULE_KEY,
      );
      if (anchorBreach === undefined) {
        throw new Error('the checker refused the candidate without naming the breached rule');
      }
      if (
        !anchorBreach.explanation.includes(ANCHOR_MEMBERSHIP) ||
        !anchorBreach.explanation.includes(ANCHOR_DATE)
      ) {
        throw new Error(
          `the build-boundary explanation does not name the membership and the date: ` +
            `"${anchorBreach.explanation}"`,
        );
      }
      context.observe(
        'build-boundary-validation',
        `validateCandidate: usable=false, rejections=[${reasons.join(', ')}], ` +
          `hardViolations=${String(verdict.hardViolations)}; ${anchorBreach.explanation}`,
      );

      const violations: BuildViolation[] = verdict.findings.map((finding) => ({
        finding: finding.finding,
        ruleKey: finding.ruleKey,
        nodeKind: finding.nodeKind,
        field: finding.field,
        explanation: finding.explanation,
      }));
      const conflicts = conflictsOf({
        violations,
        rejections: [],
        explanation: null,
        quality: null,
        fairnessOutliers: [],
      });
      const hardBreach = conflicts.find((conflict) => conflict.subject === ANCHOR_RULE_KEY);
      if (hardBreach === undefined) {
        throw new Error('the conflict projection dropped the injected hard breach');
      }
      if (hardBreach.conflictClass !== 'hard-breach') {
        throw new Error(
          `the injected hard breach was classified ${hardBreach.conflictClass}, not hard-breach`,
        );
      }
      if (hardBreach.severityRank !== 1 || !hardBreach.blocksApproval) {
        throw new Error(
          `severity ${String(hardBreach.severityRank)} / blocksApproval ` +
            `${String(hardBreach.blocksApproval)} — an unresolved hard violation must block ` +
            'sign-off (report 24 §3.4)',
        );
      }
      if (hardBreach.detail !== anchorBreach.explanation) {
        throw new Error(
          'the conflict detail is not the checker explanation — the domain terms were lost ' +
            'between detection and display',
        );
      }
      context.observe(
        'build-boundary-conflict',
        `conflictsOf -> class=${hardBreach.conflictClass} severityRank=` +
          `${String(hardBreach.severityRank)} blocksApproval=${String(hardBreach.blocksApproval)} ` +
          `code=${hardBreach.code} subject=${hardBreach.subject ?? ''}; detail carried through ` +
          'byte-identically from the checker',
      );
      context.policyExercised('PO-DEC-13 conflict classes (hard-breach blocks approval)');
    },

    /**
     * The probe: the scenario's own detection oracle, given a measurement in
     * which one injected violation went UNDETECTED.
     *
     * That is the realistic failure — not "the checker crashed" but "the checker
     * quietly missed one kind and the percentage still read 100 because nobody
     * counted the kinds". So the probe removes one kind's breach findings from
     * the reading set and requires the oracle to reject it. It throws
     * `ProbeFalsified` only after OBSERVING that rejection.
     */
    probe: async (context) => {
      const readings = HARD_KIND_INJECTIONS.map(readInjection);

      // The control: the truthful measurement must be ACCEPTED.
      const truthful = detectionOracle(readings);
      if (truthful.length > 0) {
        throw new Error(
          `the oracle rejected the truthful measurement: ${truthful.join('; ')} — the probe has ` +
            'found the oracle broken, not falsified the scenario',
        );
      }
      context.observe('probe-control', 'the oracle accepts the truthful 22/22 measurement');

      const target = readings[0];
      if (target === undefined) throw new Error('no readings to falsify');

      /* The broken world: this kind's violation was injected and NOT detected. */
      const blinded = readings.map((reading) =>
        reading.kind === target.kind ? { ...reading, breachFindings: [] } : reading,
      );
      const problems = detectionOracle(blinded);
      if (problems.length === 0) {
        // The oracle accepted an undetected violation. Nothing here can fail for
        // the right reason, so the harness records VACUOUS.
        return;
      }

      throw new ProbeFalsified(
        `an UNDETECTED ${target.kind} violation was rejected by the scenario's own oracle: ` +
          `${problems.join('; ')}`,
      );
    },
  };
}

/** Re-exported so a reviewer's probe can build its own readings. */
export { readInjection, M_A as SBX016_MEMBERSHIP_A };
export type { Rule as SbxInjectedRule };
