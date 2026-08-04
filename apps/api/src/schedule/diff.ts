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
 */

/** The fields of a snapshot the difference is computed over. */
export interface DiffSnapshot {
  readonly assignmentIdentityId: string;
  readonly membershipId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: string;
}

export type AssignmentChangeKind = 'added' | 'removed' | 'reassigned' | 'retimed';

export interface AssignmentChange {
  readonly assignmentIdentityId: string;
  readonly kind: AssignmentChangeKind;
  /** The membership that held it before, when there was one. */
  readonly fromMembershipId: string | null;
  /** The membership that holds it after, when there is one. */
  readonly toMembershipId: string | null;
}

export interface VersionDifference {
  readonly changes: readonly AssignmentChange[];
  /**
   * Every membership with a stake in a change — the union of the before and
   * after sides. A reassignment affects BOTH people: the one who lost the shift
   * and the one who gained it. Notifying only the gainer is the defect this
   * union exists to prevent.
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
    const beforeRow = beforeRows.get(identity);
    if (beforeRow === undefined) {
      changes.push({
        assignmentIdentityId: identity,
        kind: 'added',
        fromMembershipId: null,
        toMembershipId: afterRow.membershipId,
      });
      affected.add(afterRow.membershipId);
      continue;
    }
    if (beforeRow.membershipId !== afterRow.membershipId) {
      changes.push({
        assignmentIdentityId: identity,
        kind: 'reassigned',
        fromMembershipId: beforeRow.membershipId,
        toMembershipId: afterRow.membershipId,
      });
      affected.add(beforeRow.membershipId);
      affected.add(afterRow.membershipId);
      continue;
    }
    if (
      beforeRow.startsAt.getTime() !== afterRow.startsAt.getTime() ||
      beforeRow.endsAt.getTime() !== afterRow.endsAt.getTime()
    ) {
      changes.push({
        assignmentIdentityId: identity,
        kind: 'retimed',
        fromMembershipId: beforeRow.membershipId,
        toMembershipId: afterRow.membershipId,
      });
      affected.add(afterRow.membershipId);
    }
    // Identical content: not a change, and its holder is NOT affected. This is
    // the half of the property that a diff returning "everyone" would fail.
  }

  for (const [identity, beforeRow] of beforeRows) {
    if (afterRows.has(identity)) continue;
    changes.push({
      assignmentIdentityId: identity,
      kind: 'removed',
      fromMembershipId: beforeRow.membershipId,
      toMembershipId: null,
    });
    affected.add(beforeRow.membershipId);
  }

  changes.sort((a, b) =>
    a.assignmentIdentityId === b.assignmentIdentityId
      ? a.kind.localeCompare(b.kind)
      : a.assignmentIdentityId.localeCompare(b.assignmentIdentityId),
  );

  return { changes, affectedMembershipIds: [...affected].sort() };
}
