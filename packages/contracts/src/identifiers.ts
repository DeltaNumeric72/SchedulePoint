import { z } from 'zod';

/**
 * The shape of a path identifier, as a contract rather than a regex at each
 * call site (OPUS-M2-004, review finding V-02).
 *
 * ## Why this exists at all
 *
 * A route that took a uuid path parameter passed it straight to the database,
 * so `GET …/shift-types/:shiftTypeId/qualifications` with a non-uuid segment
 * raised `22P02` — invalid input syntax for type uuid — inside the read. The
 * first fix caught every database error and answered `404`, which was the right
 * ANSWER reached the wrong way: it also swallowed faults that had nothing to do
 * with the identifier, and logged "refused by the database" about causes it had
 * never checked.
 *
 * The correct address is here. A malformed identifier is a **shape** problem,
 * decidable before any statement runs, and deciding it here means the `22P02`
 * class never reaches the database at all — so the error handling below it can
 * be narrow enough to be honest.
 *
 * ## It lives in contracts because `apps/api` cannot import zod
 *
 * The layering rule: `packages/contracts` imports zod; `apps/api` imports
 * contracts. A uuid check hand-rolled in the api as a regex would be a second
 * definition of the same shape, drifting from the one every request and response
 * body is already parsed against.
 */
export const uuidSchema = z.string().uuid();

/**
 * `true` when `value` is a well-formed uuid.
 *
 * A predicate rather than a parse result, because every caller wants the same
 * thing: keep the value it already has, or stop. It is deliberately NOT a
 * type-narrowing guard to a branded type — that would imply a validity this
 * function cannot promise, since a well-formed uuid naming nothing is exactly
 * as well-formed as one naming a row.
 */
export function isUuid(value: unknown): boolean {
  return uuidSchema.safeParse(value).success;
}
