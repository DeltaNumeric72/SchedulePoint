/**
 * `packages/contracts/src/builds` — the build lifecycle's wire shapes
 * (OPUS-M4-003; report 21 §4, SPEC-04 §2/§6/§7).
 *
 * Read `lifecycle.ts`'s header before adding to it. Three properties there are
 * load-bearing rather than stylistic: the sixteen states are an enum so a client
 * cannot receive a seventeenth; `state`, `solverStatus` and `terminationReason`
 * are three fields and never one, because `failed` alone cannot say whether a
 * deadline, a kill, a crash or a refused result produced it; and every refusal
 * that carries state has its own `.strict()` body shape, because the shared
 * error envelope is `.strict()` and would reject a body with an extra field.
 */
export * from './lifecycle.js';
