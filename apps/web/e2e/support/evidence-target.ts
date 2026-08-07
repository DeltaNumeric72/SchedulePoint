import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where an e2e run writes its SCREENSHOTS — the browser half of the NR-14
 * redesign (OPUS-M3-008).
 *
 * ## Why this file exists at all
 *
 * The first pass of NR-14 redirected the three obvious writers — `pnpm check`'s
 * transcript, the red-case transcript, and the SBX bundle. Then a plain
 * `pnpm check` was run and `git status --porcelain` still listed **seventy-odd
 * modified PNGs**: every `capture()` call in `apps/web/e2e/` writes a screenshot
 * straight into a tracked `docs/evidence/EV-.../screenshots/` directory, and a
 * PNG re-encoded from a fresh render differs byte-for-byte even when the page is
 * identical.
 *
 * That is the redesign's own lesson arriving on schedule: a rule enforced by
 * three redirected call sites is a rule the fourth call site does not have. It is
 * why `clean-tree.mjs` scans for writers rather than trusting a list, and why the
 * scan now includes this file.
 *
 * ## The behaviour, identical to the other three halves
 *
 * A plain run writes under `.evidence-scratch/` (git-ignored); a run with
 * `SP_EVIDENCE_REFRESH=1` writes the tracked directory. The RELATIVE path is
 * unchanged either way, so a refreshed run lands every screenshot exactly where
 * it has always landed and a reviewer can diff scratch against tracked to see
 * what a refresh would change.
 *
 * `apps/api/test/architecture/evidence-and-preview-target.test.ts` compares this
 * mirror against `scripts/evidence-target.mjs` by execution.
 */

/** Mirrors `scripts/evidence-target.mjs`. */
export const EVIDENCE_SCRATCH_DIR = '.evidence-scratch';
/** Mirrors `scripts/evidence-target.mjs`. */
export const EVIDENCE_REFRESH_ENV = 'SP_EVIDENCE_REFRESH';

/** The worktree root, from this file's own location. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export function isEvidenceRefresh(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EVIDENCE_REFRESH_ENV] === '1';
}

export function resolveEvidencePath(relative: string, refresh = isEvidenceRefresh()): string {
  return refresh
    ? resolve(REPO_ROOT, relative)
    : resolve(REPO_ROOT, EVIDENCE_SCRATCH_DIR, relative);
}

/**
 * The directory a spec's screenshots go in.
 *
 * @param bundle e.g. `EV-M3-PUBLICATION-UX`
 */
export function screenshotDir(bundle: string): string {
  return resolveEvidencePath(`docs/evidence/${bundle}/screenshots`);
}
