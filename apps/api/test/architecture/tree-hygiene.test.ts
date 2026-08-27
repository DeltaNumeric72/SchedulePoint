import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { log } from '../support/harness.js';

/**
 * **Two hygiene properties of the working tree, each of which currently rests on
 * somebody noticing** (OPUS-M5-H: FU-07 and FU-06).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## FU-07 — a stray file at the repository ROOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * REV-C-007 found a tracked file at the repository root named `=` — the residue
 * of a shell redirect that went somewhere nobody intended. It was removed by
 * hand, and the CLASS was left unguarded: REV-C-008 recorded that the
 * architecture assertion which looks at the root sees DIRECTORIES only, and that
 * `ALLOWED_IMPL_ROOTS`, the constant that would have carried a file allowlist,
 * was dead code (it no longer exists anywhere in this repository — verified by
 * grep at M5-H, which is why this is written fresh rather than revived).
 *
 * The root is the one directory in this repository with no owner and no README,
 * so a file that lands there lands quietly. The allowlist below is the whole
 * contents of the root, enumerated: adding a file to the root is a deliberate act
 * that includes adding its name here, and every other spelling fails the build.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## FU-06 — an UNTRACKED probe under a collected root
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Doc 38 §3's R-9.2 rules say a probe lives OUTSIDE any collected root and is
 * removed afterwards. Nothing enforced it: NR-14's `dirtyEvidencePaths` filters
 * `git status` down to tracked files and `docs/evidence/`, so an untracked probe
 * dropped into `apps/api/test/` was invisible to the only automated check in the
 * neighbourhood, and the discipline rested on convention.
 *
 * It matters because a file under a collected root is not inert: a `*.test.ts`
 * there is COLLECTED, so it changes what the battery runs and what every count in
 * an acceptance record means — and it does so without appearing in any diff.
 *
 * **Why "untracked" is the right predicate rather than a hardship.** This
 * repository already requires `git add -N` for a new file before the local gate
 * run — the RISK-REGISTER's citation-sweep class rule adopted it because the
 * citation gate enumerates `git ls-files` and is blind to a file until it is in
 * the index. A new test written the way this repository already asks for it is
 * therefore tracked-in-index and passes here; a probe somebody forgot to delete
 * is not, and fails.
 *
 * ## Both are asserted with a NON-VACUITY control
 *
 * A scan that found nothing to scan reports success for the most boring possible
 * reason. Each half requires that it actually enumerated something, so a broken
 * `git` invocation fails loudly instead of passing silently.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

/**
 * Every file the repository root is allowed to hold.
 *
 * Enumerated rather than pattern-matched. A pattern (`*.json`, `Dockerfile.*`)
 * would admit the next stray file of a shape somebody had already used, which is
 * how an allowlist stops being one.
 */
const ALLOWED_ROOT_FILES: readonly string[] = [
  '.dependency-cruiser.cjs',
  '.env.example',
  '.gitignore',
  '.prettierignore',
  '.prettierrc.json',
  'AGENTS.md',
  'CLAUDE.md',
  'Dockerfile.app',
  'Dockerfile.ingress',
  'Dockerfile.solver',
  'SchedulePoint_Claude_Workflow_Playbook.pdf',
  'docker-compose.yml',
  'eslint.config.js',
  'ingress.nginx.conf',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'tsconfig.json',
  'vitest.config.ts',
];

/**
 * The directories vitest and playwright COLLECT from.
 *
 * Read off the five project configurations plus the e2e directory. If a project
 * is added and its root is not listed here, this control simply does not cover it
 * — which is a bound worth stating, and the reason the list names its sources.
 */
const COLLECTED_ROOTS: readonly string[] = [
  'packages/contracts/test/',
  'packages/domain/test/',
  'apps/api/test/',
  'apps/web/test/',
  'apps/web/e2e/',
  'scripts/gates/test/',
];

/** Tracked paths, repository-relative. */
function trackedPaths(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\0').filter((path) => path !== '');
}

/**
 * Untracked, NOT-IGNORED paths, repository-relative.
 *
 * `--others --exclude-standard` is `git status`'s own `??` set without its
 * porcelain formatting, so a `.gitignore`d artifact — every `__red_case__*`
 * injection, `dist/`, `.evidence-scratch/` — is correctly absent. Those have
 * their own check (`scripts/red-cases/debris.mjs`, FU-27), and this one would
 * only duplicate it badly.
 */
function untrackedPaths(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out.split('\0').filter((path) => path !== '');
}

describe('FU-07 — the repository root holds only what it is meant to', () => {
  it('every TRACKED root file is on the allowlist', () => {
    const tracked = trackedPaths();
    expect(tracked.length, 'git ls-files enumerated nothing — the scan is not scanning').toBeGreaterThan(
      100,
    );

    const rootFiles = tracked.filter((path) => !path.includes('/'));
    expect(rootFiles.length, 'no root file was found at all, which cannot be right').toBeGreaterThan(
      0,
    );

    const stray = rootFiles.filter((name) => !ALLOWED_ROOT_FILES.includes(name));
    expect(
      stray,
      'a tracked file at the repository root that the allowlist does not name. If it belongs ' +
        'there, add its name to ALLOWED_ROOT_FILES in this file — deliberately. If it does not ' +
        '(REV-C-007 found a file named `=`, left by a shell redirect), delete it.',
    ).toEqual([]);

    log(`root hygiene: ${String(rootFiles.length)} tracked root file(s), all allowlisted`);
  });

  it('and no UNTRACKED, unignored file is sitting at the root either', () => {
    /* The `=` incident was caught only after it had been committed. An untracked
     * one is the same file one step earlier, and a root that is clean in the
     * index but littered on disk is how the next one gets committed. */
    const stray = untrackedPaths().filter((path) => !path.includes('/'));
    expect(
      stray,
      'an untracked file at the repository root. Move it into a directory that owns it, add it ' +
        'to .gitignore if it is a run artifact, or delete it.',
    ).toEqual([]);
  });
});

describe('FU-13 — executable sources under docs/ are enumerated, not conventional', () => {
  /**
   * The gap FU-13 records as "the `.mjs`-under-`docs/` gap (convention only)".
   *
   * `eslint.config.js` ignores `docs/**` and no TypeScript project includes it, so an
   * executable module committed under `docs/` is linted by nothing, type-checked by
   * nothing and imported by nothing that would notice it rotting. That is the right
   * arrangement for a documentation tree — and it means a probe or repro script
   * parked there is outside every gate, which is the whole of the gap.
   *
   * Nothing here changes the ignore. What changes is that the exceptions are
   * ENUMERATED: an executable source under `docs/` must be named below, with the
   * reason it lives there, so adding one is a decision somebody made rather than a
   * file somebody dropped.
   */
  const ALLOWED_DOCS_SOURCES: readonly string[] = [
    /* REV-B's own reproduction script, retained as evidence of the finding it
       produced. Evidence is the one thing that legitimately lives under `docs/`
       as code: it must stay byte-frozen to remain evidence, which is exactly why
       it must not be linted or refactored. */
    'docs/evidence/EV-M4-INPUT-B/b1-repro.mjs',
  ];

  it('every executable source under docs/ is on the list', () => {
    const executable = trackedPaths().filter(
      (path) => path.startsWith('docs/') && /\.(mjs|cjs|js|ts|tsx)$/.test(path),
    );
    const unlisted = executable.filter((path) => !ALLOWED_DOCS_SOURCES.includes(path));
    expect(
      unlisted,
      'an executable source under docs/, which eslint ignores and no TypeScript project ' +
        'compiles. If it is retained EVIDENCE, add it to ALLOWED_DOCS_SOURCES with the ' +
        'reason. If it is a probe, doc 38 §3 R-9.2 says it should not have been committed ' +
        'at all. If it is real code, it belongs in scripts/ or a package, where the gates ' +
        'can see it.',
    ).toEqual([]);

    /* Non-vacuity: the allowlist must describe something that exists, or this
     * assertion is a filter over an empty set that will pass for ever. */
    for (const allowed of ALLOWED_DOCS_SOURCES) {
      expect(executable, `${allowed} is allowlisted but no longer tracked`).toContain(allowed);
    }
    log(`docs/ executables: ${String(executable.length)}, all enumerated`);
  });
});

describe('FU-06 — no untracked probe is sitting under a collected root', () => {
  it('the collected roots hold nothing untracked', () => {
    const untracked = untrackedPaths();
    const stray = untracked.filter((path) => COLLECTED_ROOTS.some((root) => path.startsWith(root)));
    expect(
      stray,
      'an UNTRACKED file under a directory vitest or playwright collects from. A `*.test.ts` ' +
        'there is collected, so it changes what the battery runs while appearing in no diff. ' +
        'Doc 38 §3 R-9.2: a probe lives OUTSIDE every collected root and is removed afterwards. ' +
        'If this is a new test rather than a probe, `git add -N` it — which this repository ' +
        'already requires before a local gate run (the citation-sweep class rule).',
    ).toEqual([]);
  });

  it('the collected roots are real — the assertion above is not scanning empty air', () => {
    /* Non-vacuity, and it is the assertion that would have caught this control
     * being pointed at directories that do not exist. Each named root must hold
     * at least one TRACKED file, or the scan above is filtering against a prefix
     * nothing could ever match. */
    const tracked = trackedPaths();
    for (const root of COLLECTED_ROOTS) {
      expect(
        tracked.some((path) => path.startsWith(root)),
        `no tracked file under ${root} — this collected root has moved or been renamed, and the ` +
          'FU-06 scan silently covers nothing there',
      ).toBe(true);
    }
    log(`probe backstop: ${String(COLLECTED_ROOTS.length)} collected root(s) covered`);
  });
});
