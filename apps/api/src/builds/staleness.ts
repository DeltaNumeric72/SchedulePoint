import type { SnapshotConstituent, UnitOfWork } from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import { compareConstituents, FRESH, type StalenessVerdict } from './constituent-diff.js';
import type { Database } from '../db/schema.js';
import { assembleCanonicalInput } from '../solver/canonical-input.js';
import { readSnapshot } from '../solver/snapshot-store.js';
import type { BuildRunRow } from './service.js';

/**
 * **Staleness — doc 35 §6g ruling 4, which is absolute.**
 *
 * > A build whose **ANY** input revision changed after snapshot assembly is
 * > visibly STALE and can **NEVER** silently become the current draft.
 *
 * ## Why the existing control was not this
 *
 * Selection already carried FAD-26(2)'s compare-and-set: the caller states the
 * source draft's material-input digest, and a draft that moved produces
 * `STALE_BUILD_SOURCE`. That covers the **source version** — its assignments,
 * their pins, their credits — and nothing else.
 *
 * It does not cover a rule that was revised, a shift type that was archived, a
 * qualification that expired, a weekday demand that was re-set, a location that
 * was renamed, or the group timezone being changed, between the moment the
 * snapshot was assembled and the moment somebody clicks Apply. Every one of
 * those changes what the problem WAS, and a candidate applied afterwards is a
 * schedule computed against a world that no longer exists — while every screen
 * says it is current.
 *
 * ## The mechanism is the 0016 constituents, and it is not a second spelling
 *
 * Migration 0016 persists `constituents`: one `(kind, key, revision)` row for
 * every revisioned thing the build consumed, at the revision it consumed. The
 * counters are database-owned — no application role can write them — which is
 * what makes citing one meaningful rather than advisory.
 *
 * So staleness is: **re-run the assembly now, and compare.** The comparison uses
 * the SAME `assembleCanonicalInput` that produced the pinned list, so there is
 * exactly one implementation of "what does this build depend on" and a
 * constituent kind added later is covered here on the day it is added, with no
 * second list to remember to update (the S-01 defect class, applied to reads).
 *
 * Both directions count, and the second is the one a naive comparison misses:
 *
 *  * a constituent whose revision **moved**;
 *  * a constituent that is **gone** — a retired shift type, a deleted
 *    requirement, a participant who left the group;
 *  * a constituent that is **new** — demand added for a date the build never
 *    saw. A candidate that fills yesterday's demand is stale in exactly the
 *    way that matters even though nothing it cited changed.
 *
 * ## An assembly that REFUSES is stale, not an error
 *
 * `assembleCanonicalInput` throws when the world is in a state it will not pose
 * a problem from — an inactive participant, an invalid date, a stale timezone
 * basis. Reaching that from here means the inputs moved into a shape that can no
 * longer be assembled at all, which is the strongest possible evidence of
 * staleness. It is reported as staleness with the refusals attached, rather than
 * propagated as a 500 that tells a scheduler nothing.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/* The pure half lives in `constituent-diff.ts`. Re-exported here so callers keep
 * one import for "staleness" — the split exists to break a module cycle
 * (`errors.ts` needs the verdict type), not to give readers two places to look. */
export {
  CHANGE_LIMIT,
  compareConstituents,
  type ConstituentChange,
  type StalenessDirection,
  type StalenessVerdict,
} from './constituent-diff.js';

/**
 * Is this build still posed against the world it was assembled from?
 *
 * A run with no pinned snapshot — one that never reached `readiness_check` —
 * answers `fresh`. That is not a loophole: such a run has no candidate either,
 * so there is nothing selection could apply, and the transition matrix refuses
 * it long before this is consulted.
 */
export async function buildStaleness(uow: Uow, run: BuildRunRow): Promise<StalenessVerdict> {
  if (run.snapshot_id === null) return FRESH;

  const stored = await readSnapshot(uow, run.snapshot_id);
  if (stored === null) {
    /* The snapshot is immutable and never deleted (0016's append-only guard), so
     * this means it is not VISIBLE — a different group, or a row that predates
     * the tenant tuple in force. Treated as stale rather than fresh: the one
     * thing this function must never do is answer "unchanged" about a comparison
     * it did not perform. */
    return {
      stale: true,
      changes: [],
      changeCount: 0,
      classes: [],
      assemblyRefusals: ['pinned-snapshot-not-visible'],
    };
  }

  const pinned = (Array.isArray(stored.constituents) ? stored.constituents : []) as readonly SnapshotConstituent[];

  let current: readonly SnapshotConstituent[];
  try {
    const assembled = await assembleCanonicalInput(uow, {
      periodId: run.period_id,
      versionId: run.source_version_id,
      at: new Date(),
      ...(run.protected_assignment_identities.length === 0
        ? {}
        : { protectedAssignmentIdentities: [...run.protected_assignment_identities] }),
    });
    current = assembled.constituents;
  } catch (error) {
    const refusals = (error as { refusals?: unknown }).refusals;
    const reasons = Array.isArray(refusals)
      ? [...new Set(refusals.map((r) => String((r as { reason?: unknown }).reason ?? 'unknown')))]
      : ['assembly-failed'];
    return {
      stale: true,
      changes: [],
      changeCount: 0,
      classes: [],
      assemblyRefusals: reasons.sort(),
    };
  }

  const { changes, changeCount, classes } = compareConstituents(pinned, current);
  return { stale: changeCount > 0, changes, changeCount, classes, assemblyRefusals: [] };
}
