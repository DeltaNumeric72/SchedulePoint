import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalStringify, type SolverInputSnapshotDocument } from '@schedulepoint/domain';

import type { CorpusFixture } from './generators.js';

/**
 * **The race-produced retired-holding fixture** — doc 35 §6d, binding
 * constraints.
 *
 * > the corpus includes a RACE-PRODUCED retired-holding fixture (produced by the
 * > shipped interleaving harness or a snapshot captured from it, **never
 * > hand-written**) that the validator rejects
 *
 * ## Why "never hand-written" is the whole clause
 *
 * A hand-written fixture would encode what somebody *believed* the
 * granted-while-retiring interleaving produces. The value of this case is
 * precisely that nobody chose the state: two real transactions on two real
 * connections raced through the shipped services, migration 0012's trigger read
 * the qualification as `active` because the retirement had not committed, and a
 * **conferring holding of a now-retired qualification** exists. FAD-35 ruled
 * that outcome authoritative; the safety property comes entirely from the READ
 * side, where the frozen verdict evaluates lifecycle first and answers
 * `retired`.
 *
 * A fixture written by hand would be a restatement of that belief and would keep
 * passing if the race ever started producing something else.
 *
 * ## So this is the CAPTURE, and it is guarded against drift
 *
 * `apps/api/test/profiles/granted-while-retiring-inertness.test.ts` runs the
 * interleaving, and its case (e) does two things with the snapshot it assembles:
 *
 *  - **verifies** the committed capture still describes the same state the live
 *    race just produced — the raced pair carried, retired, and ineligible; the
 *    control pair satisfied and eligible. The uuids differ run to run (they come
 *    from a real database), so the guard is structural rather than byte-for-byte,
 *    and it fails if the race's OUTCOME ever changes;
 *  - **rewrites** the capture when `SP_CAPTURE_RACE_FIXTURE` is set, which is the
 *    only way this file's bytes ever change. An ordinary run writes nothing, so
 *    a battery leaves the tree clean (the NR-14 discipline).
 *
 * The corpus then consumes the capture without a database, which is what lets
 * the agreement suite pose it to the worker beside every generated fixture.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

export const RACE_FIXTURE_PATH = resolve(HERE, 'fixtures/race-retired-holding.captured.json');

/** Set to any non-empty value to REWRITE the capture from a live race. */
export const CAPTURE_ENV = 'SP_CAPTURE_RACE_FIXTURE';

export interface RaceCapture {
  /** How this file came to exist. Prose, so a reader is never left guessing. */
  readonly producedBy: string;
  readonly racedMembershipId: string;
  readonly racedShiftTypeId: string;
  readonly racedQualificationId: string;
  readonly controlShiftTypeId: string;
  readonly document: SolverInputSnapshotDocument;
}

export function captureExists(): boolean {
  return existsSync(RACE_FIXTURE_PATH);
}

export function readRaceCapture(): RaceCapture {
  if (!captureExists()) {
    throw new Error(
      `the race-produced corpus fixture is missing at ${RACE_FIXTURE_PATH}. It is written by ` +
        `granted-while-retiring-inertness.test.ts with ${CAPTURE_ENV} set; it is never ` +
        'hand-written.',
    );
  }
  return JSON.parse(readFileSync(RACE_FIXTURE_PATH, 'utf8')) as RaceCapture;
}

/** Rewrite the capture. Called only from the harness, only under the flag. */
export function writeRaceCapture(capture: RaceCapture): void {
  mkdirSync(dirname(RACE_FIXTURE_PATH), { recursive: true });
  /* `canonicalStringify` — the same rendering the input hash is taken over, so
   * the committed bytes and the hashed bytes cannot disagree. */
  writeFileSync(RACE_FIXTURE_PATH, `${canonicalStringify(capture)}\n`, 'utf8');
}

/**
 * The structural properties the capture must still have, checked against a
 * freshly raced snapshot.
 *
 * Returns the mismatches rather than throwing, so the harness can report all of
 * them at once and name each one.
 */
export function captureDriftAgainstLive(
  capture: RaceCapture,
  live: {
    readonly document: SolverInputSnapshotDocument;
    readonly racedMembershipId: string;
    readonly racedShiftTypeId: string;
    readonly racedQualificationId: string;
    readonly controlShiftTypeId: string;
  },
): readonly string[] {
  const problems: string[] = [];

  const shape = (
    document: SolverInputSnapshotDocument,
    membershipId: string,
    racedShiftTypeId: string,
    racedQualificationId: string,
    controlShiftTypeId: string,
  ): { holdingCarried: boolean; racedEligible: boolean | null; controlEligible: boolean | null } => {
    const participant = document.participants.find((p) => p.membershipId === membershipId);
    return {
      holdingCarried:
        participant?.holdings.some((h) => h.qualificationId === racedQualificationId) ?? false,
      racedEligible:
        participant?.eligibility.find((e) => e.shiftTypeId === racedShiftTypeId)?.eligible ?? null,
      controlEligible:
        participant?.eligibility.find((e) => e.shiftTypeId === controlShiftTypeId)?.eligible ??
        null,
    };
  };

  const committed = shape(
    capture.document,
    capture.racedMembershipId,
    capture.racedShiftTypeId,
    capture.racedQualificationId,
    capture.controlShiftTypeId,
  );
  const observed = shape(
    live.document,
    live.racedMembershipId,
    live.racedShiftTypeId,
    live.racedQualificationId,
    live.controlShiftTypeId,
  );

  if (committed.holdingCarried !== observed.holdingCarried) {
    problems.push('the raced holding is carried in one snapshot and not the other');
  }
  if (committed.racedEligible !== observed.racedEligible) {
    problems.push('the raced pair has a different eligibility verdict than the capture records');
  }
  if (committed.controlEligible !== observed.controlEligible) {
    problems.push('the control pair has a different eligibility verdict than the capture records');
  }
  /* The three properties that make the fixture MEAN anything, asserted on the
   * live snapshot directly. Without them a capture could agree with a live race
   * that had stopped producing the case at all. */
  if (!observed.holdingCarried) problems.push('the live race carried no raced holding');
  if (observed.racedEligible !== false) problems.push('the live race left the raced pair eligible');
  if (observed.controlEligible !== true) {
    problems.push('the live control pair is not eligible — the oracle is dead');
  }
  return problems;
}

/** The capture, as a corpus fixture. */
export async function raceProducedRetiredHoldingFixture(): Promise<CorpusFixture> {
  const capture = readRaceCapture();
  return Promise.resolve({
    name: 'B-race-retired-holding',
    corpusClass: 'race-retired-holding' as const,
    /* Not a seed: this fixture is not generated. Named for what produced it, so
     * nothing reads it as reproducible-from-a-number. */
    seed: 'captured:granted-while-retiring-inertness',
    construction:
      'captured from the shipped granted-while-retiring interleaving — a conferring holding of a ' +
      'RETIRED qualification, which the frozen verdict makes ineligible',
    /* Nobody is eligible for the shift type the period demands, and T0 says so
     * structurally: no search makes a retired credential confer. */
    expectation: { outcome: 'infeasible', structuralCodes: ['no_eligible_member'] },
    document: capture.document,
  });
}
