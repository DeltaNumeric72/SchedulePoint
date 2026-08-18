import { createHash } from 'node:crypto';

import {
  OBJECTIVE_SCALE,
  objectiveProfileCanonicalString,
  type ObjectiveTierRecordShape,
} from '@schedulepoint/domain';

/**
 * **The objective the platform believes in, and the check that the worker used
 * it** (OPUS-M4-004; doc 08 §3.4, SPEC-04 §4).
 *
 * ## Why a digest and not a version number
 *
 * A version number is a promise somebody has to remember to keep. The two
 * implementations of the objective profile — `packages/domain/src/rules/objective.ts`
 * and `solver/schedulepoint_solver/model.py` — cannot import each other, so the
 * agreement between them is made **mechanical**: both render the profile in the
 * one canonical form, both hash it, and the worker echoes its hash on every
 * response. Change a tier weight on one side only and the very first solve
 * refuses, naming both digests.
 *
 * That is the property doc 35 §6f's scaling-constant red arm falsifies: change
 * the factor in one place, and the recorded factor mismatch is caught. It is not
 * a claim about discipline; it is a comparison of two strings.
 *
 * ## Deliberately NOT a provider module
 *
 * No `@provider-port` marker, nothing here reaches anything, and nothing here
 * needs the boundary guard — the same split `config.ts` records. Keeping the
 * error class and the digest out of `solver-client.ts` is what lets that file
 * hold the property the static gate checks (every export opens with the guard)
 * without the gate growing an exemption for a constructor.
 */

/** The canonical rendering the digest is taken over. Exported for the parity proof. */
export const OBJECTIVE_PROFILE_CANONICAL = objectiveProfileCanonicalString();

/**
 * SHA-256 of the canonical rendering.
 *
 * Computed at module load rather than per call: it is a constant of the build,
 * and recomputing it per solve would invite somebody to pass an argument.
 */
export const OBJECTIVE_PROFILE_DIGEST = createHash('sha256')
  .update(OBJECTIVE_PROFILE_CANONICAL, 'utf8')
  .digest('hex');

/** What the worker says it ran under. */
export interface ObjectiveProfileRecord {
  readonly profileId: string;
  readonly scale: number;
  readonly digest: string;
}

/**
 * A response produced under a different objective than the one this platform
 * knows about.
 *
 * Refused rather than recorded-and-continued. The numbers in such a response —
 * the objective value, the tier weights, every comparison that would later be
 * drawn between it and another candidate — are measurements of a different
 * question, and a mismatch that presented as a slightly odd objective value
 * would be the hardest possible defect to find.
 */
export class SolverObjectiveMismatchError extends Error {
  readonly expectedDigest: string;
  readonly reportedDigest: string | null;
  readonly reportedProfileId: string | null;

  constructor(input: { reportedDigest: string | null; reportedProfileId: string | null }) {
    super(
      'The solver worker reported a different objective profile than this platform ' +
        'compiles. A result computed under a different objective is a result for a ' +
        'different question, so it is refused rather than recorded.',
    );
    this.name = 'SolverObjectiveMismatchError';
    this.expectedDigest = OBJECTIVE_PROFILE_DIGEST;
    this.reportedDigest = input.reportedDigest;
    this.reportedProfileId = input.reportedProfileId;
  }
}

/**
 * Read the worker's objective record, defensively, and REFUSE a mismatch.
 *
 * `null` is returned only for a response that carries no objective record at
 * all, which is what a stub or a pre-E2 worker produces. That case is a stated
 * absence the caller records; it is **not** silently treated as agreement,
 * because the callers that need agreement ask for it by name
 * ({@link requireObjectiveAgreement}).
 */
export function readObjectiveProfile(value: unknown): ObjectiveProfileRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const profileId = row['profileId'];
  const digest = row['digest'];
  const scale = row['scale'];
  if (typeof profileId !== 'string' || profileId === '' || profileId.length > 64) return null;
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return null;
  if (typeof scale !== 'number' || !Number.isInteger(scale) || scale <= 0) return null;
  return { profileId, scale, digest };
}

/** Throw unless the worker ran the objective this platform compiled. */
export function requireObjectiveAgreement(record: ObjectiveProfileRecord | null): void {
  if (record === null) {
    throw new SolverObjectiveMismatchError({ reportedDigest: null, reportedProfileId: null });
  }
  if (record.digest !== OBJECTIVE_PROFILE_DIGEST || record.scale !== OBJECTIVE_SCALE) {
    throw new SolverObjectiveMismatchError({
      reportedDigest: record.digest,
      reportedProfileId: record.profileId,
    });
  }
}

/**
 * SPEC-04 §4's search statistics, read defensively.
 *
 * Every field is nullable and every one is a NUMBER. A statistic is either a
 * measurement or an absence; a string here would be a channel from the least
 * trusted process this platform runs into a record an auditor reads.
 */
export interface SolverStatisticsRecord {
  readonly branches: number | null;
  readonly conflicts: number | null;
  readonly wallTimeSeconds: number | null;
  readonly userTimeSeconds: number | null;
  /** The machine-independent measure of how much search was done (SPEC-04 §4). */
  readonly deterministicTimeUnits: number | null;
  readonly bestObjectiveBound: number | null;
  readonly booleanVariables: number | null;
  readonly hardRuleCount: number | null;
  readonly explanationSolves: number | null;
  readonly explanationSeconds: number | null;
}

const STATISTIC_KEYS = [
  'branches',
  'conflicts',
  'wallTimeSeconds',
  'userTimeSeconds',
  'deterministicTimeUnits',
  'bestObjectiveBound',
  'booleanVariables',
  'hardRuleCount',
  'explanationSolves',
  'explanationSeconds',
] as const;

export function readStatistics(value: unknown): SolverStatisticsRecord {
  const row =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const out: Record<string, number | null> = {};
  for (const key of STATISTIC_KEYS) {
    const raw = row[key];
    out[key] = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  }
  return out as unknown as SolverStatisticsRecord;
}

/** The recorded tier list, read defensively and bounded. */
export function readObjectiveTiers(value: unknown): readonly ObjectiveTierRecordShape[] {
  if (!Array.isArray(value)) return [];
  const tiers: ObjectiveTierRecordShape[] = [];
  for (const entry of value.slice(0, 32)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row['tier'] !== 'number' || typeof row['name'] !== 'string') continue;
    const strings = (name: string): readonly string[] =>
      Array.isArray(row[name])
        ? (row[name] as unknown[])
            .filter((item): item is string => typeof item === 'string')
            .slice(0, 500)
        : [];
    const components: { ruleKey: string; scaledWeight: number }[] = [];
    if (Array.isArray(row['components'])) {
      for (const raw of (row['components'] as unknown[]).slice(0, 500)) {
        if (typeof raw !== 'object' || raw === null) continue;
        const component = raw as Record<string, unknown>;
        const ruleKey = component['ruleKey'];
        const scaledWeight = component['scaledWeight'];
        if (typeof ruleKey !== 'string' || ruleKey === '') continue;
        if (typeof scaledWeight !== 'number' || !Number.isFinite(scaledWeight)) continue;
        components.push({ ruleKey, scaledWeight });
      }
    }
    tiers.push({
      tier: row['tier'],
      name: row['name'],
      weightScale: typeof row['weightScale'] === 'number' ? row['weightScale'] : 0,
      scale: typeof row['scale'] === 'number' ? row['scale'] : OBJECTIVE_SCALE,
      ruleKeys: strings('ruleKeys'),
      components,
      unmappedRuleKeys: strings('unmappedRuleKeys'),
      termCount: typeof row['termCount'] === 'number' ? row['termCount'] : 0,
    });
  }
  return tiers;
}
