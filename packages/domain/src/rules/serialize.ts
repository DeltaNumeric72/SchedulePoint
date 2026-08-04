/**
 * Deterministic canonical serialization of rules and compiled output
 * (OPUS-M3-002, SPEC-04 §3.2 "compiler determinism … byte for byte").
 *
 * The one function {@link canonicalStringify} produces a stable, environment-
 * independent JSON string: object keys in a fixed order — `Array.prototype.sort`'s
 * default, which is UTF-16 **code-unit** order, not code-point order (they differ
 * only above the BMP, and the ordering is deterministic either way, which is the
 * property that matters here) — arrays in their
 * authored order (order is meaning for a `PatternRule`'s segments), no whitespace
 * variance, and `undefined`-valued keys dropped so an absent optional and an
 * explicit `undefined` serialize identically. That determinism is what lets the
 * round trip assert *equality* rather than "looks the same", and what lets the
 * corpus regeneration and compiler-determinism proofs compare bytes.
 *
 * Pure and dependency-free. No locale, no timezone, no clock touches this.
 */

/** A JSON-compatible value. The AST and compiled forms are built only from these. */
export type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };

/**
 * Recursively canonicalise a value into a form `JSON.stringify` renders
 * identically every time: object keys sorted in UTF-16 code-unit order (the
 * engine-independent default of `Array.prototype.sort`), `undefined` members
 * dropped, arrays preserved in order. Throws on a non-finite number so a `NaN`
 * or `Infinity` can never enter a "canonical" artifact silently.
 */
export function canonicalize(value: unknown): Json {
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalise a non-finite number.');
    return value;
  }
  if (Array.isArray(value)) return value.map((element) => canonicalize(element));
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, Json> = {};
    for (const key of Object.keys(source).sort()) {
      const member = source[key];
      if (member === undefined) continue;
      result[key] = canonicalize(member);
    }
    return result;
  }
  throw new Error(`Cannot canonicalise a value of type ${typeof value}.`);
}

/** The canonical string form. Byte-identical for equal inputs, on any machine. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Parse a canonical (or any) JSON rule string back into a value. Serialization
 * is lossless over the JSON-representable AST, so `parse(canonicalStringify(x))`
 * canonicalises back to the same bytes — the round-trip property the authoring
 * API proves (SPEC-04 §3.2, "author → persist → compile → load → re-validate →
 * re-serialize with canonical-form equality").
 */
export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
