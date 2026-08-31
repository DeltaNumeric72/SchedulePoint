import { randomUUID } from 'node:crypto';

import {
  COMPILER_VERSION,
  RULE_SCHEMA_VERSION,
  SOLVER_SNAPSHOT_SCHEMA_VERSION,
  type SolverInputSnapshotDocument,
} from '@schedulepoint/domain';

/**
 * A synthetic canonical input, built without a database.
 *
 * The worker proofs are about **the boundary**: does the request authenticate,
 * is the protocol version enforced, does a cancel stop the solve, does a wedged
 * process die, is a killed run reported as killed. None of those depends on
 * where the document came from, and building it from a fixture would make every
 * one of them wait on a schedule seed and fail for reasons that have nothing to
 * do with the property under test.
 *
 * The *assembly* proofs are the opposite and go through the real database
 * (`canonical-input.test.ts`), because there the question is precisely whether
 * the reads produce the right document.
 *
 * Wholly synthetic: uuids minted here, 2027 dates, no name of any kind.
 */
export interface SyntheticProblemOptions {
  readonly participants?: number;
  readonly days?: number;
  readonly requiredCount?: number;
  /**
   * Text to put in the snapshot's operator-authored fields.
   *
   * A parameter because **nothing in the snapshot restricts these fields to
   * ASCII, and nothing should** — a period is called what its group calls it.
   * The MAC used to be computed over one canonical rendering and verified over a
   * different one, which agreed for ASCII and disagreed for everything else, so
   * a period named "Février 2029" was rejected as forged. The non-ASCII
   * fixtures exist so that class cannot come back.
   */
  readonly periodName?: string;
  readonly shiftTypeCode?: string;
}

export function syntheticProblem(
  options: SyntheticProblemOptions = {},
): SolverInputSnapshotDocument {
  const participantCount = options.participants ?? 3;
  const dayCount = options.days ?? 2;
  const requiredCount = options.requiredCount ?? 2;

  const shiftTypeId = randomUUID();
  const organizationId = randomUUID();
  const groupId = randomUUID();
  const periodId = randomUUID();
  const versionId = randomUUID();

  const dates: string[] = [];
  for (let index = 0; index < dayCount; index += 1) {
    dates.push(`2027-03-${String(index + 1).padStart(2, '0')}`);
  }
  const startDate = dates[0] ?? '2027-03-01';
  const endDate = dates[dates.length - 1] ?? startDate;

  const participants = Array.from({ length: participantCount }, () => {
    const membershipId = randomUUID();
    return {
      membershipId,
      membershipKind: 'group' as const,
      staffingKind: 'staff' as const,
      status: 'active' as const,
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: null,
      workProfile: null,
      holdings: [],
      eligibility: [{ shiftTypeId, eligible: true, outcomes: [] }],
    };
  });

  return {
    /* v3 (OPUS-M5-004) — SPEC-08 §6's projection. EMPTY here, and the emptiness
     * is the fixture's statement rather than an omission: these problems carry
     * no requests at all, so "no absences" is the truth about them. R-14's
     * fixture builds a populated one on a real rebuild. */
    requestProjection: { hardOff: [], hardOn: [], softPreference: [], shiftGroupOff: [] },
    snapshotSchemaVersion: SOLVER_SNAPSHOT_SCHEMA_VERSION,
    compilerVersion: COMPILER_VERSION,
    ruleSchemaVersion: RULE_SCHEMA_VERSION,
    organizationId,
    groupId,
    periodId,
    versionId,
    periodName: options.periodName ?? 'Synthetic period',
    periodStatus: 'planning',
    startDate,
    endDate,
    dayCount,
    timezone: { basis: 'UTC', tzdbVersion: 'unknown', source: 'version-snapshot' },
    locations: [],
    shiftTypes: [
      {
        shiftTypeId,
        code: options.shiftTypeCode ?? 'SYN',
        startTime: '08:00:00',
        endTime: '16:00:00',
        crossesMidnight: false,
        isManualOnly: false,
        isOnCall: false,
        creditWeight: '1.00',
        status: 'active',
        requiredQualificationIds: [],
      },
    ],
    demand: dates.map((date) => ({
      source: 'period-requirement' as const,
      shiftTypeId,
      on: date,
      requiredCount,
    })),
    participants,
    fixedAssignments: [],
    ruleRevisions: [],
    /* Snapshot v2 (OPUS-M4-002, FAD-38). Empty is the RIGHT value for this
     * fixture and not a placeholder: these boundary proofs pose a problem with
     * no staff groups, no valid groups and no qualification requirements, so an
     * empty vocabulary is what the group genuinely has. The fields are present
     * because v2 requires them — an ABSENT vocabulary and an EMPTY one are
     * different claims, and the schema is what keeps them different.
     *
     * `apps/api/test/solver/corpus/` supplies the populated shapes; nothing here
     * moved, and no assertion in any boundary proof reads these fields. */
    staffGroups: [],
    validGroups: [],
    qualifications: [],
    constituents: [
      { kind: 'period', key: periodId, revision: '1' },
      { kind: 'shiftType', key: shiftTypeId, revision: '1' },
    ],
  };
}
