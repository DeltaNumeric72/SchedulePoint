/**
 * The closed audit payload — I-07, in the domain.
 *
 * ## What "closed" means here, and why it is not zod
 *
 * The packet asks for "the payload schema is closed (zod strict)". This module
 * is the same guarantee written without zod, for a reason that is structural
 * rather than a preference: **`packages/domain` imports nothing** — that is the
 * layering rule `.dependency-cruiser.cjs` enforces and `scripts/red-cases/
 * import-boundary/` proves — and `packages/contracts`, which may import zod, is
 * outside this task's allowed globs. Recorded as a deviation in
 * `docs/evidence/EV-M1-AUDIT/INDEX.md`.
 *
 * What matters is that the guarantee is not weaker, and on the dimension I-07
 * actually cares about it is stronger. zod's `.strict()` rejects unknown keys;
 * it says nothing about whether a *known* key's string value is an identifier or
 * a clinician's note. The rules below are about the values.
 *
 * ## The rules
 *
 * | Rule | Rejects |
 * |---|---|
 * | the payload is a plain object | arrays, `null`, primitives |
 * | at most 16 keys | an unbounded bag |
 * | each key matches `^[a-z][a-zA-Z0-9]{0,39}$` | anything that reads like prose |
 * | each value is `string`, `number` or `boolean` | nesting, `null`, `undefined` |
 * | a number is finite | `NaN`, `Infinity` |
 * | a string is ≤ 64 characters | a paragraph |
 * | **a string is printable ASCII with no space** (`[!-~]*`) | **a sentence** |
 *
 * The last rule is the one doing the work, and it is an allowlist rather than a
 * whitespace test for a reason that was **measured, not anticipated**: the first
 * version of this file tested `/\s/` and the SQL mirror tested `[[:space:]]`,
 * and they disagreed about U+00A0 — the SQL class does not match a non-breaking
 * space under this cluster's ctype. Two validators disagreeing about what counts
 * as free text would make the weaker one the real rule. `[!-~]` (0x21–0x7E) has
 * no locale and no Unicode table behind it: a uuid, an enum token, an ISO
 * timestamp and a correlation id all match; a sentence, any control character
 * and any non-ASCII character do not.
 *
 * It is a blunt instrument, and blunt is right — I-07 is not a preference to be
 * traded against expressiveness, and the alternative's failure mode is patient
 * information in an audit row, and then in a backup, permanently.
 *
 * ## It is mirrored in SQL, and the mirror is tested
 *
 * `app_audit_payload_is_closed(jsonb)` in migration 0003 applies the same rules
 * as a CHECK constraint, so a caller that bypasses this module still cannot
 * store free text. `apps/api/test/audit/payload-closedness.test.ts` runs one
 * corpus of candidate payloads through BOTH and asserts they agree on every one
 * — two validators that drift apart are worse than one, because the weaker one
 * becomes the real rule while the stronger one is the documented one.
 */

export type AuditPayloadValue = string | number | boolean;

/** A flat, scalar-valued, whitespace-free bag of identifiers and tokens. */
export type AuditPayload = Readonly<Record<string, AuditPayloadValue>>;

export const AUDIT_PAYLOAD_MAX_KEYS = 16;
export const AUDIT_PAYLOAD_MAX_STRING_LENGTH = 64;

const KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,39}$/;
/**
 * Printable ASCII, space excluded: 0x21 (`!`) through 0x7E (`~`).
 *
 * Mirrors `'^[!-~]*$'` in `app_audit_payload_is_closed`, character for
 * character. `apps/api/test/audit/payload-closedness.test.ts` runs one corpus
 * through both and fails if they ever disagree again.
 */
const TOKEN_PATTERN = /^[!-~]*$/;

export type AuditPayloadViolationCode =
  | 'not_an_object'
  | 'too_many_keys'
  | 'key_not_an_identifier'
  | 'value_not_a_scalar'
  | 'number_not_finite'
  | 'string_too_long'
  | 'string_not_a_token';

export interface AuditPayloadViolation {
  readonly code: AuditPayloadViolationCode;
  /** The offending key, or `null` when the payload itself is the problem. */
  readonly key: string | null;
}

/**
 * Every rule the payload breaks, not merely the first.
 *
 * All of them, because a caller fixing one violation at a time against a
 * validator that reports one at a time is a caller who will eventually stop
 * fixing and start stringifying.
 */
export function auditPayloadViolations(payload: unknown): readonly AuditPayloadViolation[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return [{ code: 'not_an_object', key: null }];
  }

  const violations: AuditPayloadViolation[] = [];
  const entries = Object.entries(payload as Record<string, unknown>);

  if (entries.length > AUDIT_PAYLOAD_MAX_KEYS) {
    violations.push({ code: 'too_many_keys', key: null });
  }

  for (const [key, value] of entries) {
    if (!KEY_PATTERN.test(key)) {
      violations.push({ code: 'key_not_an_identifier', key });
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) violations.push({ code: 'number_not_finite', key });
      continue;
    }
    if (typeof value === 'boolean') continue;
    if (typeof value !== 'string') {
      violations.push({ code: 'value_not_a_scalar', key });
      continue;
    }
    if (value.length > AUDIT_PAYLOAD_MAX_STRING_LENGTH) {
      violations.push({ code: 'string_too_long', key });
    }
    if (!TOKEN_PATTERN.test(value)) {
      violations.push({ code: 'string_not_a_token', key });
    }
  }

  return violations;
}

export function isClosedAuditPayload(payload: unknown): payload is AuditPayload {
  return auditPayloadViolations(payload).length === 0;
}

/**
 * Raised when a payload would carry something I-07 prohibits.
 *
 * **The offending value is deliberately NOT in the message.** An error that
 * quoted the free text it rejected would put that free text into a log, which is
 * the thing being prevented (non-bypass rule 9). Keys and rule codes only.
 */
export class AuditPayloadNotClosedError extends Error {
  readonly code = 'AUDIT_PAYLOAD_NOT_CLOSED';

  constructor(readonly violations: readonly AuditPayloadViolation[]) {
    super(
      `AUDIT_PAYLOAD_NOT_CLOSED: ${violations
        .map((v) => (v.key === null ? v.code : `${v.code} at ${v.key}`))
        .join('; ')}`,
    );
    this.name = 'AuditPayloadNotClosedError';
  }
}

export function assertClosedAuditPayload(payload: unknown): asserts payload is AuditPayload {
  const violations = auditPayloadViolations(payload);
  if (violations.length > 0) throw new AuditPayloadNotClosedError(violations);
}
