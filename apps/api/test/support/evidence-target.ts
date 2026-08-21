import { resolve } from 'node:path';

/**
 * The TypeScript half of the NR-14 evidence-destination rule (OPUS-M3-008).
 *
 * `scripts/evidence-target.mjs` carries the same three lines and states the
 * reasoning at length; `scripts/` is outside every TypeScript project here, so
 * the vitest harness cannot import it. The duplication is *asserted* —
 * `apps/api/test/architecture/evidence-and-preview-target.test.ts` executes the JavaScript
 * module in a child process and fails if the two ever disagree, exactly as
 * `derived-test-port.test.ts` does for the database port.
 *
 * In one sentence: a plain run writes under `.evidence-scratch/` (git-ignored),
 * so the working tree stays clean; `SP_EVIDENCE_REFRESH=1` writes the TRACKED
 * paths, which is what assembling an evidence bundle deliberately does.
 *
 * The RELATIVE path never changes — a scenario's declared `retainedArtifact` is
 * still its SPEC-16 contract value. Only the root it resolves against moves.
 */

/** Mirrors `scripts/evidence-target.mjs`. */
export const EVIDENCE_SCRATCH_DIR = '.evidence-scratch';
/** Mirrors `scripts/evidence-target.mjs`. */
export const EVIDENCE_REFRESH_ENV = 'SP_EVIDENCE_REFRESH';

/**
 * Only the environment form here: a vitest worker receives an environment, never
 * the outer `--refresh` argv, so accepting a flag would be an affordance that
 * silently never fires. `scripts/check.mjs` translates the flag into the
 * variable for every child it spawns.
 */
export function isEvidenceRefresh(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EVIDENCE_REFRESH_ENV] === '1';
}

export function resolveEvidencePath(
  repoRoot: string,
  relative: string,
  refresh: boolean,
): string {
  return refresh ? resolve(repoRoot, relative) : resolve(repoRoot, EVIDENCE_SCRATCH_DIR, relative);
}
