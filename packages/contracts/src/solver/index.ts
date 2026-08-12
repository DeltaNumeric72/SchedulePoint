/**
 * `packages/contracts/src/solver` — the solver boundary's wire shapes
 * (OPUS-M4-001; SPEC-04 §§1–2, §3.4, §4).
 *
 * Read `snapshot.ts`'s header before adding to it. Two properties there are
 * load-bearing rather than stylistic: every object is `.strict()` because the
 * canonical input hash covers the whole document (an accidental extra key is a
 * different problem, and a deliberate one is an unreviewed input), and
 * `evidence_ref` is deliberately absent from the holding shape so that
 * `SENSITIVE-PII` free text cannot reach the snapshot table or the worker.
 */
export * from './snapshot.js';
export * from './outcome.js';
