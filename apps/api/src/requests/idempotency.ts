import type { RequestAggregate, RequestSubtype, UnitOfWork } from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

import { requestStore } from './store.js';

/**
 * D-7's replay decision, split from the record read — **FU-23's closure**
 * (OPUS-M5-003, doc 42 §5f Part A).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## The seam, exactly as the register records it
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * > `PgRequestStore.findByIdempotencyKey` returns `record === null ? null : …`,
 * > and `loadRecord` returns `null` for `vacation-selection` by design … The
 * > composition is less honest than either half: a member who already holds a
 * > vacation request under key K, submitting a non-vacation request under the
 * > same K, gets `null` from the R-11 replay read, proceeds to the insert, and is
 * > refused by `UNIQUE (membership_id, idempotency_key, organization_id)` — a 409
 * > rather than a replay.
 *
 * It was unreachable while the creation union excluded vacation at compile time
 * and the route refused it at 422. **This packet retires both**, so the seam
 * becomes reachable and this module is the close.
 *
 * ## Which of FU-23's two exits, and why
 *
 * The row offers "splitting the root read from the record read on the replay
 * path, or scoping the idempotency namespace per subtype". This is the SPLIT.
 *
 * Per-subtype namespacing is rejected on two grounds, both structural:
 *
 *  1. **It is not additive.** D-7 is `UNIQUE (membership_id, idempotency_key,
 *     organization_id)` in migration 0021. Namespacing means altering that
 *     constraint, and doc 42 §5f's constraints are "additive migrations only,
 *     0021/0022/0023/0024 never weakened".
 *  2. **It makes one key mean two things.** An idempotency key is a promise that
 *     "the same key is the same command"; a key that means a different command
 *     depending on which body carried it is the opposite of that promise, and the
 *     first ambiguous retry is the one nobody can reason about.
 *
 * ## The three answers, and the one that is new
 *
 * `fresh` and `replay` are R-11's, unchanged in meaning. **`reused` is the new
 * one, and it is the point**: a key that already names a request of a DIFFERENT
 * subtype is a genuine conflict with a genuine remedy — choose another key —
 * which is neither a replay nor something reloading fixes. Before this it was a
 * bare `23505` surfacing as an unexplained `409`; now it is a named refusal
 * decided BEFORE any write, so nothing reaches the constraint.
 *
 * **The constraint is not thereby redundant.** This read is the fast path and
 * `UNIQUE (membership_id, idempotency_key, organization_id)` is the correct one:
 * two callers racing the same key both read `fresh`, both insert, and the index
 * decides. That ordering is `submitRequest`'s existing design and is unchanged —
 * what changes is that the non-racing case now has an answer.
 *
 * ## Nothing here discloses anything
 *
 * D-7's uniqueness is scoped to `membership_id`, so every row this can find
 * belongs to the caller, and their own list already shows it. There is no
 * cross-member and no cross-tenant answer to give.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/** What a key already names, if anything. */
export type IdempotentReplay =
  /** No request holds this key for this member. Proceed to the write. */
  | { readonly kind: 'fresh' }
  /** A request of the SAME subtype holds it: R-11's replay. */
  | { readonly kind: 'replay'; readonly root: RequestAggregate }
  /** A request of a DIFFERENT subtype holds it. FU-23's named conflict. */
  | { readonly kind: 'reused'; readonly existingSubtype: RequestSubtype };

/**
 * Decide what a member's idempotency key already names, for a submission of
 * `subtype`.
 *
 * The read is the ROOT alone — `findRootByIdempotencyKey`, not
 * `findByIdempotencyKey` — because D-7's uniqueness is a property of the root and
 * of nothing else, and because composing a subtype-record read into it is the
 * defect this closes.
 */
export async function classifyIdempotencyKey(
  uow: Uow,
  membershipId: string,
  idempotencyKey: string,
  subtype: RequestSubtype,
): Promise<IdempotentReplay> {
  const root = await requestStore.findRootByIdempotencyKey(uow, membershipId, idempotencyKey);
  if (root === null) return { kind: 'fresh' };
  if (root.subtype === subtype) return { kind: 'replay', root };
  return { kind: 'reused', existingSubtype: root.subtype };
}
