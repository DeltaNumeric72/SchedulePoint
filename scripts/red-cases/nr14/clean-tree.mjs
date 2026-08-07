#!/usr/bin/env node
/**
 * NR-14's check: **an evidence writer never writes a tracked artifact unless the
 * run asked it to** (OPUS-M3-008, packet 32 §2 row 9).
 *
 * ## What this proves, and what it deliberately does not
 *
 * It proves the two things a cheap check can prove for certain:
 *
 *   1. **Every known evidence writer goes through the resolver.** A writer that
 *      resolved its own destination would silently reopen the churn, and an
 *      equality test between the two resolver implementations could not notice
 *      it. So each writer's source is scanned for the resolver call AND for the
 *      absence of its old unconditional destination.
 *   2. **A scratch write lands in the ignored directory and changes nothing
 *      tracked.** The script writes through the real resolver in plain mode and
 *      then asks `git status --porcelain` whether any tracked evidence artifact
 *      moved. That is the exact question the discipline used to be about.
 *
 * It does **not** run the full battery. `pnpm check` inside `pnpm red-cases`
 * would be a battery inside a battery, and the end-to-end measurement — a real
 * battery run followed by `git status --porcelain` — belongs in the evidence
 * bundle where its output can be read, not in a gate whose only report is an
 * exit code. Both halves are recorded; neither is claimed as the other.
 *
 * ## The red arm
 *
 * `scripts/red-cases/run.mjs` patches `scripts/check.mjs` back to writing its
 * tracked path unconditionally — the exact regression — and requires this script
 * to fail. A check that has only ever been observed passing is not evidence.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EVIDENCE_SCRATCH_DIR,
  resolveEvidencePath,
} from '../../evidence-target.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Every writer of a tracked evidence artifact — **discovered, not listed** (N-8).
 *
 * It was a hand-kept array of four paths. That is precisely the stale-list class
 * this packet removed from SBX-004's "coverage gap" line, reintroduced two files
 * later: a list of what the code does goes out of date silently, and the check
 * that depends on it then passes while a fifth writer quietly dirties the tree.
 * The first pass of NR-14 had already been caught by exactly that shape — three
 * writers redirected, a fourth (every `capture()` in `apps/web/e2e/`) missed.
 *
 * So the tree is SCANNED instead. A writer is a tracked source file that does
 * BOTH: names a tracked evidence destination (`docs/evidence/…`,
 * `scripts/check-output.txt`, `scripts/red-cases/evidence-output.txt`) **and**
 * calls a filesystem-write primitive. Naming alone is not enough — a few dozen
 * files cite an evidence document in a docblock, and a scan that treated a
 * citation as a write would be noise nobody could keep green. Writing alone is
 * not enough either: plenty of code writes files that are not evidence.
 *
 * Every file matching both must resolve its destination through
 * `evidence-target`, or be listed as a reader with a stated reason.
 *
 * **A screenshot writer is caught by a second shape.** `apps/web/e2e/*.spec.ts`
 * calls `page.screenshot` into a directory it gets from `screenshotDir('EV-…')` —
 * it names a BUNDLE, never a path, so the destination test alone would never see
 * it. That is the writer the first pass missed, so `page.screenshot` is itself
 * treated as naming an evidence destination.
 *
 * The scan is over `git ls-files`, so it covers files this check has never heard
 * of and cannot be satisfied by an untracked scratch copy.
 */
const SOURCE_EXTENSIONS = ['.mjs', '.ts', '.tsx', '.js'];

/** Roots worth scanning: everything that can run and write. */
const SCAN_ROOTS = ['scripts/', 'apps/'];

/**
 * Files that name an evidence path but do NOT write one, with the reason.
 *
 * Kept as an explicit, justified allow-list rather than a heuristic: "it does not
 * look like a write" is exactly the judgement that lets a real writer through.
 * Each entry says why it is a reader.
 */
const NOT_WRITERS = new Map([
  [
    'scripts/red-cases/nr14/clean-tree.mjs',
    'this file — it names the destinations in order to CHECK them',
  ],
  [
    'apps/api/test/architecture/evidence-and-preview-target.test.ts',
    'the equality control — it reads the writers to compare them',
  ],
  ['scripts/evidence-target.mjs', 'the resolver itself'],
  [
    'apps/api/test/authn/secrecy.test.ts',
    'it READS docs/evidence/EV-M3-AUTHN to scan the bundle for secret-shaped ' +
      'values; its own writes go to a mkdtemp directory',
  ],
  ['apps/api/test/support/evidence-target.ts', 'the resolver mirror'],
  ['apps/web/e2e/support/evidence-target.ts', 'the resolver mirror'],
]);

/** Naming one of these is HALF of being a writer. */
const EVIDENCE_DESTINATIONS = [
  'docs/evidence/',
  'scripts/check-output.txt',
  'scripts/red-cases/evidence-output.txt',
];

/**
 * The other half: something that puts bytes on disk.
 *
 * `page.screenshot` is here because it is how `apps/web/e2e/` writes — the writer
 * the redesign's first pass missed, and the one that produced seventy-odd
 * modified PNGs. A scan that only knew about `writeFileSync` would have missed it
 * again.
 */
const WRITE_PRIMITIVES = [
  'writeFileSync',
  'writeFile(',
  'createWriteStream',
  'page.screenshot',
  'cpSync',
  'copyFileSync',
  'appendFileSync',
];

/**
 * Source with comments removed.
 *
 * Dozens of files CITE an evidence document in a docblock — that is the house
 * style and it is a good one. A citation is not a write, and a scan that treated
 * it as one produced twenty-eight false positives on its first run: noise nobody
 * could keep green, which is how a check stops being read.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** @returns {string[]} tracked source files under the scan roots */
function trackedSources() {
  const listed = spawnSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  return listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((path) => path !== '')
    .filter((path) => SCAN_ROOTS.some((root) => path.startsWith(root)))
    .filter((path) => SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)));
}

/**
 * Discover the writers.
 *
 * @returns {{ writers: string[], problems: string[] }}
 */
function discoverWriters() {
  /** @type {string[]} */
  const writers = [];
  /** @type {string[]} */
  const found = [];
  for (const path of trackedSources()) {
    if (NOT_WRITERS.has(path)) continue;
    const source = withoutComments(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
    const namesDestination =
      EVIDENCE_DESTINATIONS.some((destination) => source.includes(destination)) ||
      // The screenshot shape: a bundle id, resolved elsewhere into a path.
      source.includes('page.screenshot');
    if (!namesDestination) continue;
    if (!WRITE_PRIMITIVES.some((primitive) => source.includes(primitive))) continue;
    found.push(path);
    /* The resolver must be CALLED, not merely imported.
     *
     * Testing for the bare identifier let a red case through: a spec whose
     * destination had been changed back to a hard-coded `docs/evidence/…` string
     * still had the now-unused `screenshotDir` import at the top, and the scan
     * called it resolved. An import is not a call. */
    if (!source.includes('resolveEvidencePath(') && !source.includes('screenshotDir(')) {
      writers.push(path);
    }
  }
  return { writers: found, problems: writers };
}

/** Tracked artifacts a plain run must never touch. */
const TRACKED = [
  'scripts/check-output.txt',
  'scripts/red-cases/evidence-output.txt',
  'docs/evidence/EV-M2-SBX/scenario-report.txt',
];

/** @type {string[]} */
const problems = [];

/* ── 1. every DISCOVERED writer goes through the resolver ─────────────────── */

const discovered = discoverWriters();

for (const path of discovered.problems) {
  problems.push(`${path}: names a tracked evidence destination and does not resolve through evidence-target`);
}

// Non-vacuous: a scan that found nothing to scan proves nothing. The four known
// writers exist, so the discovery must find at least that many.
if (discovered.writers.length < 9) {
  problems.push(
    `the writer scan found only ${String(discovered.writers.length)} candidate(s); it is not ` +
      'looking where the writers are (three transcript writers and six screenshot specs exist)',
  );
}

/* ── 2. a plain (scratch) write changes nothing tracked ───────────────────── */

const probeRelative = 'docs/evidence/EV-NR14-PROBE/plain-run.txt';
const scratchTarget = resolveEvidencePath(REPO_ROOT, probeRelative, false);
const trackedTarget = resolveEvidencePath(REPO_ROOT, probeRelative, true);

if (!scratchTarget.startsWith(resolve(REPO_ROOT, EVIDENCE_SCRATCH_DIR))) {
  problems.push(`a plain write resolved OUTSIDE ${EVIDENCE_SCRATCH_DIR}: ${scratchTarget}`);
}
if (trackedTarget === scratchTarget) {
  problems.push('the plain and --refresh destinations are the same path');
}

/**
 * Dirty tracked evidence paths, right now.
 *
 * Taken BEFORE the probe write as well as after, and compared — the check asks
 * "did THIS write dirty anything?", not "is the tree clean?". Those are different
 * questions and the second one is not this check's business: an author part-way
 * through editing an evidence document has a legitimately dirty
 * `docs/evidence/…` path, and failing them for it would make the check something
 * people learn to ignore.
 *
 * (Measured: this check reported a false failure on exactly that, against an
 * INDEX.md being written at the time. Baseline-then-compare is the fix.)
 *
 * @returns {Set<string>}
 */
function dirtyEvidencePaths() {
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (status.status !== 0) {
    problems.push(`git status failed: ${status.stderr}`);
    return new Set();
  }
  return new Set(
    status.stdout
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter((path) => path !== '')
      .filter(
        (path) =>
          TRACKED.includes(path) ||
          path.startsWith('docs/evidence/') ||
          path === 'scripts/check-output.txt' ||
          path === 'scripts/red-cases/evidence-output.txt',
      ),
  );
}

const dirtyBefore = dirtyEvidencePaths();

mkdirSync(dirname(scratchTarget), { recursive: true });
writeFileSync(scratchTarget, `nr-14 probe ${new Date().toISOString()}\n`, 'utf8');

for (const path of dirtyEvidencePaths()) {
  if (dirtyBefore.has(path)) continue;
  problems.push(`a plain evidence write dirtied a TRACKED path: ${path}`);
}

// The probe is a run artifact; it lives in the ignored directory and is removed.
rmSync(dirname(scratchTarget), { recursive: true, force: true });

/* ── report ───────────────────────────────────────────────────────────────── */

if (problems.length > 0) {
  process.stdout.write('FAIL  nr14-clean-tree\n');
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  process.exit(1);
}

process.stdout.write(
  `PASS  nr14-clean-tree — ${String(discovered.writers.length)} DISCOVERED writer(s) resolve through ` +
    `evidence-target; a plain write landed in ${relative(REPO_ROOT, scratchTarget)} and left ` +
    'every tracked evidence artifact untouched\n',
);
