#!/usr/bin/env node
/**
 * **The debris check the post-kill preflight was missing** (OPUS-M5-H, FU-27).
 *
 * ## The gap, proven empirically rather than argued
 *
 * The standing post-kill preflight is a DIFF RE-COUNT: after a killed red-case
 * arm, re-generate the patch and check the file count, because a killed arm can
 * leave a tracked file MUTATED — at M5-001 it left a runtime security guard
 * neutered in a worktree, which is the sharpest instance anyone has recorded.
 *
 * That check is structurally blind to the other half of the class. `.gitignore`
 * carries a recursive `__red_case__` pattern, so a killed arm's leftover ADDED
 * file is invisible to `git status` and therefore to any diff. (The pattern is
 * not quoted literally here: it ends in the two characters that close a block
 * comment, which is a small, real, and rather appropriate hazard for a file about
 * debris nobody can see.) The M5-002 reviewer proved it
 * against its own run: a `timeout`-killed arm left
 * `packages/contracts/src/__red_case__type.ts` behind, `git status` reported
 * ZERO, a regenerated-diff md5 integrity check passed BYTE-IDENTICAL with five
 * red-case artifacts in the tree, and the debris then failed the next typecheck
 * gate 16/17.
 *
 * FU-27 adopted a `find` over `__red_case__` names, excluding `node_modules`, as
 * the companion check on the spot, and left the entry open pending "the preflight
 * script/checklist carrying it". This file is that home, and it is the same sweep
 * expressed as a program rather than as a shell line an operator has to remember
 * correctly at the worst moment:
 *
 *  - `pnpm red-cases` runs it in its own preflight and says what it swept, so a
 *    battery never inherits the previous one's debris;
 *  - `node scripts/red-cases/debris.mjs` runs it on demand and exits non-zero
 *    when the tree is dirty — which is the form an operator needs **after a kill**,
 *    when running the battery again is exactly what they must not do until they
 *    know what the last one left behind;
 *  - `--sweep` removes what it finds, for the recovery step itself.
 *
 * ## Why by NAME and not by the registry's own list
 *
 * `clearStaleInjections` walks the `inject` targets the CURRENT registry
 * declares. That covers every debris file today and none of the ones a future arm
 * introduces, an arm that is later renamed, or an arm removed from the registry
 * while its artifact is still on disk. The naming convention is the invariant —
 * everything injected is named `__red_case__*` and gitignored — so the sweep is
 * by name, exactly as `sweepDistArtifacts` is and for the same reason it gives:
 * "the next injection will emit a set nobody predicted".
 */
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Directories that are never worth walking, and one of them is enormous. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.venv', '.evidence-scratch']);

/** The prefix every injected and every compiled red-case artifact carries. */
export const DEBRIS_PREFIX = '__red_case__';

/**
 * Every `__red_case__*` path under `root`, repository-relative and sorted.
 *
 * @param {string} [root]
 * @returns {string[]}
 */
export function findRedCaseDebris(root = REPO_ROOT) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} directory */
  const walk = (directory) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // unreadable or gone since the listing — not this check's business
    }
    for (const entry of entries) {
      const full = resolve(directory, entry.name);
      if (entry.name.startsWith(DEBRIS_PREFIX)) {
        found.push(relative(root, full));
        continue; // a debris DIRECTORY is reported whole, not enumerated
      }
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        walk(full);
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * The operator-facing wording, in one place so the runner and the standalone
 * invocation cannot describe the same finding differently.
 *
 * @param {readonly string[]} debris
 * @returns {string}
 */
export function describeRedCaseDebris(debris) {
  return (
    `RED-CASE DEBRIS: ${String(debris.length)} artifact(s) left in the tree.\n` +
    '  These are gitignored, so `git status` reports nothing and a regenerated\n' +
    '  diff is byte-identical WITH THEM PRESENT (FU-27, proven at M5-002). They\n' +
    '  will fail the next gate that compiles or scans the tree.\n\n' +
    debris.map((path) => `  ${path}\n`).join('') +
    '\n  Remove them with `node scripts/red-cases/debris.mjs --sweep`.\n'
  );
}

/* ── the standalone invocation: the post-kill half of the preflight ────────── */

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sweep = process.argv.includes('--sweep');
  const debris = findRedCaseDebris();
  if (debris.length === 0) {
    process.stdout.write('PASS  red-case debris — the tree carries no __red_case__* artifact\n');
    process.exit(0);
  }
  process.stdout.write(`\n${describeRedCaseDebris(debris)}`);
  if (!sweep) process.exit(1);
  for (const path of debris) rmSync(resolve(REPO_ROOT, path), { recursive: true, force: true });
  process.stdout.write(`  swept ${String(debris.length)} artifact(s).\n`);
  process.exit(0);
}
