import type { SolverInputSnapshotDocument } from '@schedulepoint/domain';
import { describe, expect, it } from 'vitest';

import { configurationFindings, readinessFindings } from '../../src/builds/readiness.js';
import { classifyOutcome } from '../../src/builds/states.js';

/**
 * The two pure decisions the lifecycle turns on (OPUS-M4-003).
 *
 * Pure over their arguments, so a reviewer can drive every honesty rule without
 * a cluster and without a subprocess — the same property M4-001 built
 * `validateCandidate` to have, and for the same reason: the arms that matter
 * here are the ones where a plausible-looking lie would otherwise be produced.
 */

function outcome(
  status: Parameters<typeof classifyOutcome>[0]['outcome']['status'],
  overrides: Partial<Parameters<typeof classifyOutcome>[0]['outcome']> = {},
): Parameters<typeof classifyOutcome>[0]['outcome'] {
  return {
    status,
    terminationReason: 'completed',
    assignments: null,
    objectiveValue: null,
    ...overrides,
  };
}

const ONE = [{ membershipId: 'm', date: '2043-01-05', shiftTypeId: 's', locationId: null }];

describe('classifyOutcome — the four honesty rules', () => {
  it('INFEASIBLE is `infeasible`, never `failed`', () => {
    /* report 21 §4: a statement about the PROBLEM, not about the system. */
    const result = classifyOutcome({ outcome: outcome('INFEASIBLE'), usable: null });
    expect(result.state).toBe('infeasible');
    expect(result.terminationReason).toBe('completed');
  });

  it('TIMEOUT is `failed` with reason `deadline`, never `infeasible`', () => {
    /* SPEC-04 §2: "a timed-out run must not be reported as a completed one".
     * Nor as an infeasible one — a solve that ran out of time has said NOTHING
     * about whether a schedule exists. */
    const result = classifyOutcome({ outcome: outcome('TIMEOUT'), usable: null });
    expect(result.state).toBe('failed');
    expect(result.terminationReason).toBe('deadline');
  });

  it('CANCELLED is `cancelled` with reason `user_cancelled`', () => {
    /* EV-M0-SPC H-6, carried the whole way up: a cancelled solve is CANCELLED
     * and is never a misreported timeout or failure. */
    const result = classifyOutcome({ outcome: outcome('CANCELLED'), usable: null });
    expect(result.state).toBe('cancelled');
    expect(result.terminationReason).toBe('user_cancelled');
  });

  it('a killed or crashed worker keeps the reason the PARENT attributed', () => {
    /* FAD-34(2): `signal !== null` ⇒ killed; spawn failure or exit-without-
     * response ⇒ crashed. Neither is self-reported, and neither may be
     * flattened into `rejected` on the way through. */
    expect(
      classifyOutcome({
        outcome: outcome('FAILED', { terminationReason: 'killed' }),
        usable: null,
      }).terminationReason,
    ).toBe('killed');
    expect(
      classifyOutcome({
        outcome: outcome('FAILED', { terminationReason: 'crashed' }),
        usable: null,
      }).terminationReason,
    ).toBe('crashed');
  });

  it('a candidate the checker refused is `failed`/`rejected`, whatever the worker said', () => {
    /* SPEC-04 §3.3: the checker wins over the worker. `OPTIMAL` beside a refused
     * candidate is not a contradiction to resolve in the worker's favour — it is
     * precisely the translation defect the redundancy exists to catch. */
    const result = classifyOutcome({
      outcome: outcome('OPTIMAL', { assignments: ONE }),
      usable: false,
    });
    expect(result.state).toBe('failed');
    expect(result.terminationReason).toBe('rejected');
    /* The solver's own status is PRESERVED beside the state rather than
     * overwritten, so "the worker said OPTIMAL and we refused it" stays legible. */
    expect(result.solverStatus).toBe('OPTIMAL');
  });

  it('a solved status with NO candidate is `failed`, never `completed`', () => {
    const result = classifyOutcome({
      outcome: outcome('FEASIBLE', { assignments: null }),
      usable: null,
    });
    expect(result.state).toBe('failed');
  });

  it('`completed` requires all preferences met; a penalty means unmet ones', () => {
    /* Measured, not assumed: a zero (or absent) objective means no soft penalty
     * was incurred. Optimality is a SEPARATE question and is deliberately not
     * consulted — SPEC-04 §7 forbids an optimality claim for a feasible result,
     * and folding it in here would manufacture one. */
    expect(
      classifyOutcome({
        outcome: outcome('FEASIBLE', { assignments: ONE, objectiveValue: 0 }),
        usable: true,
      }).state,
    ).toBe('completed');
    expect(
      classifyOutcome({
        outcome: outcome('OPTIMAL', { assignments: ONE, objectiveValue: 12 }),
        usable: true,
      }).state,
    ).toBe('completed_with_unmet_preferences');
    expect(
      classifyOutcome({
        outcome: outcome('OPTIMAL', { assignments: ONE, objectiveValue: null }),
        usable: true,
      }).state,
    ).toBe('completed');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Readiness — SPEC-04 §5's T0, before a solve is spent
 * ──────────────────────────────────────────────────────────────────────────── */

function document(
  overrides: Partial<SolverInputSnapshotDocument> = {},
): SolverInputSnapshotDocument {
  return {
    snapshotSchemaVersion: 2,
    compilerVersion: 1,
    ruleSchemaVersion: 1,
    organizationId: 'o',
    groupId: 'g',
    periodId: 'p',
    versionId: 'v',
    periodName: 'proof',
    periodStatus: 'planning',
    startDate: '2043-01-05',
    endDate: '2043-01-11',
    dayCount: 7,
    timezone: { basis: 'UTC', tzdbVersion: 'unknown', source: 'version-snapshot' },
    locations: [],
    shiftTypes: [
      {
        shiftTypeId: 'st-1',
        code: 'D',
        startTime: '09:00:00',
        endTime: '17:00:00',
        crossesMidnight: false,
        isManualOnly: false,
        isOnCall: false,
        requiredQualificationIds: [],
      },
    ],
    demand: [
      { source: 'period-requirement', shiftTypeId: 'st-1', on: '2043-01-05', requiredCount: 1 },
    ],
    participants: [
      {
        membershipId: 'm-1',
        accountType: 'staff',
        participantType: 'permanent',
        effectiveFrom: '2020-01-01',
        effectiveUntil: null,
        workProfile: null,
        holdings: [],
        eligibility: [{ shiftTypeId: 'st-1', eligible: true, reasons: [] }],
      },
    ],
    fixedAssignments: [],
    ruleRevisions: [],
    staffGroups: [],
    validGroups: [],
    qualifications: [],
    constituents: [],
    ...overrides,
  } as unknown as SolverInputSnapshotDocument;
}

describe('readinessFindings — T0, and the codes are the worker’s own', () => {
  it('a ready period produces no findings at all', () => {
    expect(readinessFindings(document())).toEqual([]);
  });

  it('names a required slot with NO eligible participant', () => {
    const findings = readinessFindings(
      document({
        participants: [
          {
            membershipId: 'm-1',
            accountType: 'staff',
            participantType: 'permanent',
            effectiveFrom: '2020-01-01',
            effectiveUntil: null,
            workProfile: null,
            holdings: [],
            eligibility: [{ shiftTypeId: 'st-1', eligible: false, reasons: ['not-qualified'] }],
          },
        ],
      } as unknown as Partial<SolverInputSnapshotDocument>),
    );
    /* The worker's own token, so a scheduler who sees `no_eligible_member` at
     * readiness and `no_eligible_member` in an explanation is looking at one
     * fact rather than two. */
    expect(findings.map((finding) => finding.code)).toContain('no_eligible_member');
    expect(findings[0]?.tier).toBe('T0');
    expect(findings[0]?.date).toBe('2043-01-05');
  });

  it('names capacity below demand, and the day-level version of it', () => {
    const findings = readinessFindings(
      document({
        demand: [
          { source: 'period-requirement', shiftTypeId: 'st-1', on: '2043-01-05', requiredCount: 4 },
        ],
      } as unknown as Partial<SolverInputSnapshotDocument>),
    );
    const codes = findings.map((finding) => finding.code);
    expect(codes).toContain('eligible_capacity_below_demand');
    expect(codes).toContain('day_demand_exceeds_participants');
  });

  it('counts PERIOD REQUIREMENTS only — a weekday default is a template, not demand', () => {
    /* The model reads it the same way, and reading it differently here would
     * make readiness refuse periods the solver would happily solve. */
    const findings = readinessFindings(
      document({
        demand: [
          { source: 'weekday-default', shiftTypeId: 'st-1', on: 'mon', requiredCount: 99 },
        ],
      } as unknown as Partial<SolverInputSnapshotDocument>),
    );
    expect(findings).toEqual([]);
  });

  it('names contradictory fixed inputs', () => {
    const findings = readinessFindings(
      document({
        shiftTypes: [
          {
            shiftTypeId: 'st-1',
            code: 'D',
            startTime: '09:00:00',
            endTime: '17:00:00',
            crossesMidnight: false,
            isManualOnly: false,
            isOnCall: false,
            requiredQualificationIds: [],
          },
          {
            shiftTypeId: 'st-2',
            code: 'N',
            startTime: '21:00:00',
            endTime: '07:00:00',
            crossesMidnight: true,
            isManualOnly: false,
            isOnCall: true,
            requiredQualificationIds: [],
          },
        ],
        fixedAssignments: [
          {
            assignmentIdentityId: 'a-1',
            membershipId: 'm-1',
            date: '2043-01-05',
            shiftTypeId: 'st-1',
            locationId: null,
            isPinned: true,
            origin: 'manual',
            creditedMembershipId: null,
            creditWeight: null,
          },
          {
            assignmentIdentityId: 'a-2',
            membershipId: 'm-1',
            date: '2043-01-05',
            shiftTypeId: 'st-2',
            locationId: null,
            isPinned: true,
            origin: 'manual',
            creditedMembershipId: null,
            creditWeight: null,
          },
        ],
      } as unknown as Partial<SolverInputSnapshotDocument>),
    );
    expect(findings.map((finding) => finding.code)).toContain('conflicting_fixed_assignments');
  });

  it('is deterministic — the same snapshot produces byte-identical findings', () => {
    /* Which is what makes an itemised list comparable across a retry. */
    const snapshot = document({
      demand: [
        { source: 'period-requirement', shiftTypeId: 'st-1', on: '2043-01-06', requiredCount: 3 },
        { source: 'period-requirement', shiftTypeId: 'st-1', on: '2043-01-05', requiredCount: 3 },
      ],
    } as unknown as Partial<SolverInputSnapshotDocument>);
    expect(JSON.stringify(readinessFindings(snapshot))).toBe(
      JSON.stringify(readinessFindings(snapshot)),
    );
  });
});

describe('configurationFindings — report 21’s "scope non-empty"', () => {
  it('accepts a period with shift types, participants and demand', () => {
    expect(configurationFindings(document())).toEqual([]);
  });

  it('names which of the three is missing, rather than refusing generically', () => {
    expect(
      configurationFindings(
        document({ shiftTypes: [] } as unknown as Partial<SolverInputSnapshotDocument>),
      ).map((finding) => finding.code),
    ).toContain('no_shift_types');
    expect(
      configurationFindings(
        document({ participants: [] } as unknown as Partial<SolverInputSnapshotDocument>),
      ).map((finding) => finding.code),
    ).toContain('no_participants');
    expect(
      configurationFindings(
        document({ demand: [] } as unknown as Partial<SolverInputSnapshotDocument>),
      ).map((finding) => finding.code),
    ).toContain('no_demand');
  });

  it('refuses to build into a CLOSED period', () => {
    expect(
      configurationFindings(
        document({ periodStatus: 'closed' } as unknown as Partial<SolverInputSnapshotDocument>),
      ).map((finding) => finding.code),
    ).toContain('period_closed');
  });
});
