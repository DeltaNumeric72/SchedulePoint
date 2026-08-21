/**
 * Where a run writes its evidence — the NR-14 redesign (OPUS-M3-008, packet 32
 * §2 row 9).
 *
 * ## The discipline this retires
 *
 * `pnpm check`, `pnpm red-cases` and the SBX battery each rewrite a TRACKED file
 * (`scripts/check-output.txt`, `scripts/red-cases/evidence-output.txt`,
 * `docs/evidence/EV-<TASK>/…`) with fresh timestamps and per-scenario milliseconds.
 * Running the battery therefore dirtied the working tree, and the standing
 * instruction was to notice and undo it:
 *
 * > never `git add -A`; discard these with `git checkout --` before committing
 *
 * That is a control made of vigilance. It failed in both directions during M1–M3
 * — an agent committing a run artifact it did not mean to, and an agent
 * discarding an artifact it did mean to refresh — and it recurred often enough
 * to be written into the runbook five separate times.
 *
 * ## The redesign
 *
 * A plain run writes to `.evidence-scratch/`, which is git-ignored. Nothing in
 * the tree changes, so "is the tree clean?" is a real question again rather than
 * one whose answer is always "no, but that's expected".
 *
 * `--refresh` (or `SP_EVIDENCE_REFRESH=1`) writes to the TRACKED paths, which is
 * what a task does deliberately, once, from a coherent run, when it is
 * assembling its evidence bundle. Refreshing is now an act rather than a side
 * effect.
 *
 * **The relative paths never change.** A scenario's declared `retainedArtifact`
 * is still `docs/evidence/EV-M2-SBX/sbx-004-sweep.txt`; only the ROOT it is
 * resolved against moves. SPEC-16's contract field keeps meaning exactly what it
 * meant, and a refreshed run lands it exactly where it always landed.
 *
 * ## Two implementations, and the test that keeps them equal
 *
 * `scripts/` is outside every TypeScript project here, so the vitest harness
 * cannot import this module and carries the same three lines in
 * `apps/api/test/support/evidence-target.ts`. That duplication is *asserted* by
 * `apps/api/test/architecture/evidence-and-preview-target.test.ts`, which executes THIS file
 * in a child process and compares answers — the same control the derived test
 * port has, for the same reason.
 */
import { resolve } from 'node:path';

/**
 * The git-ignored directory a plain run writes into.
 *
 * A directory rather than a temp path: an agent that wants to read what the last
 * plain run produced should be able to find it without hunting through
 * `/var/folders`, and a reviewer re-running the battery should be able to diff
 * `.evidence-scratch/docs/evidence/EV-M2-SBX/…` against the tracked file to see
 * exactly what a refresh would change.
 */
export const EVIDENCE_SCRATCH_DIR = '.evidence-scratch';

/** The environment variable that turns a plain run into a refreshing one. */
export const EVIDENCE_REFRESH_ENV = 'SP_EVIDENCE_REFRESH';

/**
 * Does this invocation intend to update the TRACKED artifacts?
 *
 * Either spelling works and they mean the same thing: `--refresh` on the command
 * line, or `SP_EVIDENCE_REFRESH=1` in the environment. The environment form
 * exists because `pnpm check` spawns the gates as child processes, and the flag
 * has to reach `vitest`'s workers — which receive an environment, not an argv.
 *
 * @param {readonly string[]} [argv]
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isEvidenceRefresh(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--refresh')) return true;
  return env[EVIDENCE_REFRESH_ENV] === '1';
}

/**
 * The absolute path a relative evidence path resolves to for this run.
 *
 * @param {string} repoRoot absolute path of the worktree root
 * @param {string} relative repository-relative evidence path
 * @param {boolean} refresh
 * @returns {string}
 */
export function resolveEvidencePath(repoRoot, relative, refresh) {
  return refresh
    ? resolve(repoRoot, relative)
    : resolve(repoRoot, EVIDENCE_SCRATCH_DIR, relative);
}

/**
 * A one-line banner naming where this run's evidence went.
 *
 * Printed by every writer, because the failure mode of the redesign is the
 * mirror image of the old one: an agent assembling a bundle, refreshing nothing,
 * and reporting artifacts it never updated. Silence about the destination is
 * what would make that possible.
 *
 * @param {boolean} refresh
 * @returns {string}
 */
export function evidenceDestinationBanner(refresh) {
  return refresh
    ? 'evidence: --refresh — writing the TRACKED artifacts (the working tree WILL change)'
    : `evidence: scratch — writing under ${EVIDENCE_SCRATCH_DIR}/ (tracked artifacts untouched; ` +
        'pass --refresh to update them)';
}
