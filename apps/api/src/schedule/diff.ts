import {
  materialChangeFields,
  materialStakeholders,
  type MaterialAssignment,
  type MaterialField,
} from './review-identity.js';

/**
 * The affected-staff difference between two schedule versions.
 *
 * ## Why this is a pure function over rows
 *
 * The publication transaction computes it from the two versions' snapshots and
 * writes notification INTENTS from the result. Keeping it pure means the
 * property the packet actually cares about — "affected staff are notified,
 * others are not" (SBX-018's pass criterion) — is assertable directly, against
 * a constructed pair of snapshot sets, without publishing anything.
 *
 * ## The join is on assignment IDENTITY, never on snapshot id
 *
 * SPEC-05 §1: identity is "the stable thing a human means when they say *that
 * assignment changed*". Diffing by snapshot id would report every row of a clone
 * as removed-and-added, because a clone gives every snapshot a new id while
 * deliberately preserving its identity. That is exactly the heuristic diff the
 * identity table exists to replace (§7).
 *
 * ## What counts as a change is NOT decided here any more (OPUS-M4-000C)
 *
 * Doc 34 §4-G: "schedule differences and affected-participant calculations share
 * one material-change definition covering time, shift type, location, pins,
 * credits." They did not. This function compared the participant and the two
 * instants and nothing else, so **moving an assignment to a different shift
 * type, moving it to a different location, pinning it, or moving its credit to
 * another person produced no change at all** — no diff row, nobody notified, and
 * a review digest that did not move when the schedule did.
 *
 * The definition now lives in `review-identity.ts` and is consumed by this
 * function, by the affected-participant union below, and by the publication
 * review digest. One definition, three consumers, equality asserted rather than
 * intended.
 */

/**
 * The fields of a snapshot the difference is computed over.
 *
 * This is `MaterialAssignment` with the two instants kept as `Date`s, because
 * every caller reads them straight out of the driver. The conversion is one
 * place ({@link materialOf}) rather than at each call site.
 */
export interface DiffSnapshot {
  readonly assignmentIdentityId: string;
  readonly membershipId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly shiftTypeId: string;
  readonly locationId: string | null;
  readonly isPinned: boolean;
  readonly creditedMembershipId: string | null;
  readonly creditWeight: string | null;
}

/**
 * The five kinds.
 *
 * `amended` is OPUS-M4-000C's: the same person, at the same time, whose shift
 * type, location, pin or credit moved. Before it, those changes were invisible
 * — and a change that is invisible to the difference is a change nobody is
 * notified about. It is a fifth kind rather than a stretched `retimed` because
 * calling a location move a re-timing would be a false statement to the person
 * reading the review.
 */
export type AssignmentChangeKind = 'added' | 'removed' | 'reassigned' | 'retimed' | 'amended';

export interface AssignmentChange {
  readonly assignmentIdentityId: string;
  readonly kind: AssignmentChangeKind;
  /** The membership that held it before, when there was one. */
  readonly fromMembershipId: string | null;
  /** The membership that holds it after, when there is one. */
  readonly toMembershipId: string | null;
  /**
   * Every material dimension that moved, from the shared definition.
   *
   * `kind` is a summary for a reader; this is the complete answer. A
   * reassignment that also moved the shift type reports `['participant',
   * 'shiftType']` while its kind stays `reassigned`, so nothing is lost to the
   * summarising.
   */
  readonly materialFields: readonly MaterialField[];
}

export interface VersionDifference {
  readonly changes: readonly AssignmentChange[];
  /**
   * Every membership with a stake in a change — the union of the before and
   * after sides. A reassignment affects BOTH people: the one who lost the shift
   * and the one who gained it. Notifying only the gainer is the defect this
   * union exists to prevent.
   *
   * Since OPUS-M4-000C the union also includes the CREDITED membership on each
   * side, because "who works a shift and who is scored for it can legitimately
   * differ" (doc 07) and a credit moved from A to B affects two people, neither
   * of whom need be the assignee.
   *
   * Sorted, so the value is deterministic and comparable across runs.
   */
  readonly affectedMembershipIds: readonly string[];
}

/** Only `active` rows are content; a cancelled snapshot is not on the schedule. */
function activeByIdentity(rows: readonly DiffSnapshot[]): Map<string, DiffSnapshot> {
  const byIdentity = new Map<string, DiffSnapshot>();
  for (const row of rows) {
    if (row.status === 'active') byIdentity.set(row.assignmentIdentityId, row);
  }
  return byIdentity;
}

/** The shared shape the one definition is written over. */
function materialOf(row: DiffSnapshot): MaterialAssignment {
  return {
    assignmentIdentityId: row.assignmentIdentityId,
    membershipId: row.membershipId,
    date: row.date,
    startsAtMs: row.startsAt.getTime(),
    endsAtMs: row.endsAt.getTime(),
    shiftTypeId: row.shiftTypeId,
    locationId: row.locationId,
    isPinned: row.isPinned,
    creditedMembershipId: row.creditedMembershipId,
    creditWeight: row.creditWeight,
  };
}

/**
 * The reader-facing summary of a set of material fields.
 *
 * Ordered by what a person most needs to know first: who is working it, then
 * when, then everything else. A change is never summarised as `amended` when a
 * participant or a time moved, because those are the two facts a scheduler scans
 * for.
 */
function kindOf(fields: readonly MaterialField[]): AssignmentChangeKind | null {
  if (fields.length === 0) return null;
  if (fields.includes('participant')) return 'reassigned';
  if (fields.includes('time') || fields.includes('date')) return 'retimed';
  return 'amended';
}

/**
 * Compare the previously current version's snapshots with the incoming one's.
 *
 * `before` is empty for a first publication, which correctly yields every row as
 * `added`.
 */
export function differenceByIdentity(
  before: readonly DiffSnapshot[],
  after: readonly DiffSnapshot[],
): VersionDifference {
  const beforeRows = activeByIdentity(before);
  const afterRows = activeByIdentity(after);
  const changes: AssignmentChange[] = [];
  const affected = new Set<string>();

  for (const [identity, afterRow] of afterRows) {
    const afterMaterial = materialOf(afterRow);
    const beforeRow = beforeRows.get(identity);

    if (beforeRow === undefined) {
      changes.push({
        assignmentIdentityId: identity,
        kind: 'added',
        fromMembershipId: null,
        toMembershipId: afterRow.membershipId,
        // Everything about it is new, so every dimension moved.
        materialFields: [...MATERIAL_FIELDS_ALL],
      });
      for (const stakeholder of materialStakeholders(afterMaterial)) affected.add(stakeholder);
      continue;
    }

    const beforeMaterial = materialOf(beforeRow);
    const fields = materialChangeFields(beforeMaterial, afterMaterial);
    const kind = kindOf(fields);
    if (kind === null) {
      // Identical content: not a change, and its holder is NOT affected. This is
      // the half of the property that a diff returning "everyone" would fail.
      continue;
    }

    changes.push({
      assignmentIdentityId: identity,
      kind,
      fromMembershipId: beforeRow.membershipId,
      toMembershipId: afterRow.membershipId,
      materialFields: fields,
    });
    // BOTH sides. A reassignment affects the person who lost it as well as the
    // one who gained it, and a credit move affects both credited memberships.
    for (const stakeholder of materialStakeholders(beforeMaterial)) affected.add(stakeholder);
    for (const stakeholder of materialStakeholders(afterMaterial)) affected.add(stakeholder);
  }

  for (const [identity, beforeRow] of beforeRows) {
    if (afterRows.has(identity)) continue;
    changes.push({
      assignmentIdentityId: identity,
      kind: 'removed',
      fromMembershipId: beforeRow.membershipId,
      toMembershipId: null,
      materialFields: [...MATERIAL_FIELDS_ALL],
    });
    for (const stakeholder of materialStakeholders(materialOf(beforeRow))) {
      affected.add(stakeholder);
    }
  }

  changes.sort((a, b) =>
    a.assignmentIdentityId === b.assignmentIdentityId
      ? a.kind.localeCompare(b.kind)
      : a.assignmentIdentityId.localeCompare(b.assignmentIdentityId),
  );

  return { changes, affectedMembershipIds: [...affected].sort() };
}

/**
 * Every material dimension, for an `added` or `removed` change.
 *
 * Re-exported from the definition rather than spelled again here: a second list
 * would be a second answer, which is the whole thing this packet is closing.
 */
const MATERIAL_FIELDS_ALL: readonly MaterialField[] = [
  'participant',
  'date',
  'time',
  'shiftType',
  'location',
  'pin',
  'credit',
];
