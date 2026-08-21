import type { SnapshotConstituent } from '@schedulepoint/domain';

/**
 * **The staleness comparison, pure** (doc 35 §6g ruling 4; OPUS-M4-005).
 *
 * Its own module, importing nothing from `builds/`, for two reasons that are
 * both load-bearing:
 *
 *  1. **the cycle.** `errors.ts` needs the verdict type for
 *     `BuildInputsMovedError`, `staleness.ts` needs the errors' siblings, and
 *     `service.ts` sits between them. A type-only import does not make a cycle
 *     benign — `dependency-cruiser`'s `no-circular` counts it, and it is right
 *     to: the cycle is a fact about the module graph whatever the emitted
 *     JavaScript does;
 *  2. **the same discipline `solver-snapshot.ts` states for itself** — the reads
 *     live in the api layer and the JUDGEMENT is pure, so a reviewer's probes
 *     can hand-build both sides of a comparison instead of constructing a
 *     database to provoke it.
 */

export type StalenessDirection = 'moved' | 'removed' | 'added';

export interface ConstituentChange {
  readonly kind: string;
  readonly key: string;
  readonly direction: StalenessDirection;
  /** The revision the build was posed against; `null` when the constituent is new. */
  readonly pinnedRevision: string | null;
  /** The revision in force now; `null` when the constituent is gone. */
  readonly currentRevision: string | null;
}

export interface StalenessVerdict {
  readonly stale: boolean;
  /** Every change, in a stable order. Bounded — see {@link CHANGE_LIMIT}. */
  readonly changes: readonly ConstituentChange[];
  /** How many changes there were in total, which may exceed `changes.length`. */
  readonly changeCount: number;
  /**
   * Every changed `(kind, direction)` with its COMPLETE count, computed before
   * `changes` was truncated (FAD-51 D-2). `sum(classes[].count) === changeCount`
   * always — unlike `changes`, this is never bounded.
   */
  readonly classes: readonly ConstituentChangeClass[];
  /**
   * Set when the inputs can no longer be assembled at all. The refusal reasons,
   * never the detail strings: a reason is a closed vocabulary and a detail is
   * prose (I-07 discipline, the same one `build_run_events.reason` follows).
   */
  readonly assemblyRefusals: readonly string[];
}

/**
 * A bound, because a scheduler reading a list and a database storing one both
 * have limits, and "1 400 things changed" is as actionable as the first twenty.
 * `changeCount` carries the true number so the bound never becomes a lie.
 */
export const CHANGE_LIMIT = 20;

export const FRESH: StalenessVerdict = {
  stale: false,
  changes: [],
  changeCount: 0,
  classes: [],
  assemblyRefusals: [],
};

/* ────────────────────────────────────────────────────────────────────────────
 * The WIRE projection (FAD-50 C-4)
 * ──────────────────────────────────────────────────────────────────────────── */

/** One input CLASS that moved, and how many of it. No identifiers, no revisions. */
export interface ConstituentChangeClass {
  readonly kind: string;
  readonly direction: StalenessDirection;
  readonly count: number;
}

export interface StalenessWire {
  readonly stale: boolean;
  readonly changes: readonly ConstituentChangeClass[];
  readonly changeCount: number;
  readonly assemblyRefusals: readonly string[];
}

/**
 * **Narrow a computed verdict to what a caller may be told** (FAD-50 C-4).
 *
 * ## The finding
 *
 * `constituents` carries `(kind, key, revision)`, and for the
 * `qualificationHolding` class the `key` is the holding row's surrogate id and
 * the revision is its version counter. The detail GET put that list on the wire
 * for anybody who could read the build — including callers with no
 * `staffing.qualification_holding.read` grant, which is a grant-only,
 * `SENSITIVE-PII` capability (`canonical-input.ts` says so in as many words).
 * "Which holding rows exist, and which of them changed this week" is exactly the
 * shape of thing that grant exists to gate. The FAD-23/FAD-29 class, on a
 * surface nobody had looked at from the disclosure side.
 *
 * ## Why the COMPUTATION stays and only the WIRE narrows
 *
 * FAD-29's rationale is that an enforcement gate must compute on the truth
 * rather than on the caller's visibility — a staleness check that only saw what
 * the reader may see would declare a build fresh because the reader cannot see
 * the thing that moved, which is the worst possible answer. So the comparison is
 * unchanged and still runs over every constituent; this projects the RESULT.
 *
 * ## Why uniformly class-level, and the measurement behind it
 *
 * FAD-50 C-4 allows uniform class-level "if no surface consumes constituent
 * ids". Measured, rather than assumed: `BuildDetailPage.tsx` renders
 * `{change.kind} {change.key} — {direction}` and nothing else, and NOTHING
 * anywhere reads `pinnedRevision` or `currentRevision`. So one surface did
 * consume `key` — and it consumed it to print an **opaque surrogate UUID** next
 * to a class name, which tells a scheduler nothing they can act on. Withholding
 * it costs the screen nothing and gains it a count; keeping it would mean a
 * wire whose shape depends on the reader's grants, for a field whose only use
 * was decorative. One shape for every caller is also the shape that cannot be
 * got wrong later by a route that forgets which projection it owed.
 */
export function stalenessWire(verdict: StalenessVerdict): StalenessWire {
  return {
    stale: verdict.stale,
    /* The aggregate `compareConstituents` computed over EVERY change, before it
     * truncated the itemised list (FAD-51 D-2). This function deliberately does
     * no counting of its own: the version that did counted the truncated list
     * and produced class totals that were quietly short. */
    changes: verdict.classes,
    changeCount: verdict.changeCount,
    assemblyRefusals: verdict.assemblyRefusals,
  };
}

function keyOf(constituent: { kind: string; key: string }): string {
  return `${constituent.kind}\x00${constituent.key}`;
}

/**
 * Compare a pinned constituent list against the one in force now.
 *
 * Pure, and exported, so the reviewer's probes can hand-build both sides — the
 * same reason `solver-snapshot.ts` keeps its judgement pure while its reads live
 * in the api layer.
 */
export function compareConstituents(
  pinned: readonly SnapshotConstituent[],
  current: readonly SnapshotConstituent[],
): { changes: ConstituentChange[]; changeCount: number; classes: ConstituentChangeClass[] } {
  const pinnedByKey = new Map(pinned.map((c) => [keyOf(c), c]));
  const currentByKey = new Map(current.map((c) => [keyOf(c), c]));
  const changes: ConstituentChange[] = [];

  for (const [key, before] of pinnedByKey) {
    const after = currentByKey.get(key);
    if (after === undefined) {
      changes.push({
        kind: before.kind,
        key: before.key,
        direction: 'removed',
        pinnedRevision: before.revision,
        currentRevision: null,
      });
      continue;
    }
    if (after.revision !== before.revision) {
      changes.push({
        kind: before.kind,
        key: before.key,
        direction: 'moved',
        pinnedRevision: before.revision,
        currentRevision: after.revision,
      });
    }
  }

  for (const [key, after] of currentByKey) {
    if (pinnedByKey.has(key)) continue;
    changes.push({
      kind: after.kind,
      key: after.key,
      direction: 'added',
      pinnedRevision: null,
      currentRevision: after.revision,
    });
  }

  /* Sorted so two readers of the same pair of lists see the same list, and so a
   * test can assert on position without depending on map iteration order. */
  changes.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.key.localeCompare(b.key) ||
      a.direction.localeCompare(b.direction),
  );

  /* **The class aggregate is computed HERE, over every change, BEFORE the list
   * is truncated** (FAD-51 D-2). It used to be computed by `stalenessWire` from
   * the ALREADY-SLICED list, so each per-class count silently inherited
   * `CHANGE_LIMIT`: 25 changes of one class reported `changeCount: 25` beside a
   * class count of 20, and three separate places — this file's docblock, the
   * INDEX, and the arm's own title — claimed the projection made the bound stop
   * mattering. It did not; it moved the bound somewhere less visible.
   *
   * Computed before the slice, the counts are complete by CONSTRUCTION rather
   * than by a caller remembering to aggregate first, and `sum(classes) ===
   * changeCount` is an invariant of this function. */
  const classes = classesOf(changes);

  return { changes: changes.slice(0, CHANGE_LIMIT), changeCount: changes.length, classes };
}

/** Group changes by `(kind, direction)` and count them. Order is stable. */
function classesOf(changes: readonly ConstituentChange[]): ConstituentChangeClass[] {
  const counts = new Map<string, ConstituentChangeClass>();
  for (const change of changes) {
    const key = `${change.kind}\x00${change.direction}`;
    const seen = counts.get(key);
    counts.set(
      key,
      seen === undefined
        ? { kind: change.kind, direction: change.direction, count: 1 }
        : { ...seen, count: seen.count + 1 },
    );
  }
  return [...counts.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.direction.localeCompare(b.direction),
  );
}

