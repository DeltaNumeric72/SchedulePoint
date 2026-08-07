import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../support/env.js';
import {
  EVIDENCE_REFRESH_ENV,
  EVIDENCE_SCRATCH_DIR,
  isEvidenceRefresh,
  resolveEvidencePath,
} from '../support/evidence-target.js';

/**
 * Two OPUS-M3-008 mechanisms and the controls that keep their duplicated halves
 * honest.
 *
 * **NR-14** — where a run writes its evidence. A plain run writes under
 * `.evidence-scratch/`, so a battery no longer dirties the working tree and the
 * restore-with-`git checkout --` discipline retires; `--refresh` writes the
 * tracked artifacts deliberately.
 *
 * **E-2** — the Playwright preview port, now derived per worktree exactly as the
 * database port is.
 *
 * Both are implemented twice (JavaScript under `scripts/`, TypeScript where the
 * consumer lives) because `scripts/` is outside every TypeScript project here.
 * Duplicated logic that nothing compares is how two "identical" implementations
 * drift, so both are **executed** in a child process and compared — reading the
 * files and diffing text would prove the source matched, not the behaviour.
 *
 * The third control is structural: every writer of a tracked evidence artifact
 * must go THROUGH the resolver. A writer that resolved its own path would
 * silently reopen the churn, and no equality test would notice.
 */

const EVIDENCE_MODULE = resolve(REPO_ROOT, 'scripts/evidence-target.mjs');
const NR14_CHECK = resolve(REPO_ROOT, 'scripts/red-cases/nr14/clean-tree.mjs');
const PORT_MODULE = resolve(REPO_ROOT, 'scripts/sbx/test-port.mjs');

function runModule(script: string): unknown {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`the module could not be executed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

describe('NR-14 — a plain run writes to scratch, --refresh writes the tracked paths', () => {
  it('the JavaScript and TypeScript resolvers agree, path by path', () => {
    const samples = [
      'scripts/check-output.txt',
      'scripts/red-cases/evidence-output.txt',
      'docs/evidence/EV-M2-SBX/scenario-report.txt',
      'docs/evidence/EV-M3-PUBLICATION/sbx-018.txt',
    ];

    const fromScript = runModule(
      [
        `const m = await import(${JSON.stringify(EVIDENCE_MODULE)});`,
        `const samples = ${JSON.stringify(samples)};`,
        `const root = ${JSON.stringify(REPO_ROOT)};`,
        'process.stdout.write(JSON.stringify({',
        '  scratchDir: m.EVIDENCE_SCRATCH_DIR,',
        '  refreshEnv: m.EVIDENCE_REFRESH_ENV,',
        '  scratch: samples.map((s) => m.resolveEvidencePath(root, s, false)),',
        '  tracked: samples.map((s) => m.resolveEvidencePath(root, s, true)),',
        '  refreshByFlag: m.isEvidenceRefresh(["--refresh"], {}),',
        '  refreshByEnv: m.isEvidenceRefresh([], { SP_EVIDENCE_REFRESH: "1" }),',
        '  plain: m.isEvidenceRefresh([], {}),',
        '}));',
      ].join('\n'),
    ) as {
      scratchDir: string;
      refreshEnv: string;
      scratch: string[];
      tracked: string[];
      refreshByFlag: boolean;
      refreshByEnv: boolean;
      plain: boolean;
    };

    expect(fromScript.scratchDir).toBe(EVIDENCE_SCRATCH_DIR);
    expect(fromScript.refreshEnv).toBe(EVIDENCE_REFRESH_ENV);
    expect(fromScript.scratch).toEqual(
      samples.map((sample) => resolveEvidencePath(REPO_ROOT, sample, false)),
    );
    expect(fromScript.tracked).toEqual(
      samples.map((sample) => resolveEvidencePath(REPO_ROOT, sample, true)),
    );
    expect(fromScript.refreshByFlag).toBe(true);
    expect(fromScript.refreshByEnv).toBe(true);
    expect(fromScript.plain).toBe(false);

    // The control that makes the equality mean something: the two destinations
    // must actually differ, or "they agree" is a statement about one path.
    expect(fromScript.scratch).not.toEqual(fromScript.tracked);
  });

  it('a scratch path is INSIDE the git-ignored directory, and a tracked path is not', () => {
    const scratch = resolveEvidencePath(REPO_ROOT, 'scripts/check-output.txt', false);
    const tracked = resolveEvidencePath(REPO_ROOT, 'scripts/check-output.txt', true);
    expect(scratch.startsWith(resolve(REPO_ROOT, EVIDENCE_SCRATCH_DIR))).toBe(true);
    expect(tracked).toBe(resolve(REPO_ROOT, 'scripts/check-output.txt'));

    // …and the directory really is ignored, or the whole redesign is decorative.
    const gitignore = readFileSync(resolve(REPO_ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toContain(`${EVIDENCE_SCRATCH_DIR}/`);
  });

  it('the TypeScript half reads only the ENVIRONMENT, because a worker sees no argv', () => {
    expect(isEvidenceRefresh({})).toBe(false);
    expect(isEvidenceRefresh({ [EVIDENCE_REFRESH_ENV]: '1' })).toBe(true);
    // Anything other than exactly "1" is not a refresh. A truthy-string reading
    // would make `SP_EVIDENCE_REFRESH=0` refresh the bundle.
    expect(isEvidenceRefresh({ [EVIDENCE_REFRESH_ENV]: '0' })).toBe(false);
    expect(isEvidenceRefresh({ [EVIDENCE_REFRESH_ENV]: 'true' })).toBe(false);
  });

  it('every evidence WRITER goes through the resolver — the structural half', () => {
    /* This used to carry its OWN hand-kept list of four writers, which is the
     * stale-list class the packet removed from SBX-004's coverage line and then
     * reintroduced here (N-8). A duplicate list is a second thing to forget.
     *
     * So the check is not duplicated: `scripts/red-cases/nr14/clean-tree.mjs` is
     * the one implementation — it DISCOVERS writers by scanning `git ls-files`
     * for files that both name an evidence destination (or call
     * `page.screenshot`) and call a write primitive — and this runs it. One
     * scanner, exercised from both the red-case runner and the unit gate. */
    const scan = spawnSync(process.execPath, [NR14_CHECK], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(scan.status, `${scan.stdout}${scan.stderr}`).toBe(0);
    expect(scan.stdout).toMatch(/DISCOVERED writer\(s\) resolve through evidence-target/);

    // Non-vacuous: it must have found the writers that exist, not zero of them.
    const found = /(\d+) DISCOVERED writer/.exec(scan.stdout);
    expect(Number(found?.[1] ?? 0)).toBeGreaterThanOrEqual(9);
  });
});

describe('E-2 — the Playwright preview port is derived per worktree', () => {
  it('the config and the script derive the same numbers, root by root', () => {
    const roots = [
      '/synthetic/repo',
      '/synthetic/repo/.worktrees/m3-004',
      '/synthetic/repo/.worktrees/m3-007',
      '/synthetic/repo/.worktrees/m3-008',
    ];

    const fromScript = runModule(
      [
        `const m = await import(${JSON.stringify(PORT_MODULE)});`,
        `const roots = ${JSON.stringify(roots)};`,
        'process.stdout.write(JSON.stringify({',
        '  base: m.DERIVED_PREVIEW_PORT_BASE,',
        '  span: m.DERIVED_PREVIEW_PORT_SPAN,',
        '  ports: roots.map((r) => m.deriveTestPreviewPort(r)),',
        '  resolvedWithoutOverride: m.resolveTestPreviewPort({}),',
        '  resolvedWithOverride: m.resolveTestPreviewPort({ SP_TEST_PREVIEW_PORT: "4420" }),',
        '}));',
      ].join('\n'),
    ) as {
      base: number;
      span: number;
      ports: number[];
      resolvedWithoutOverride: number;
      resolvedWithOverride: number;
    };

    /* The playwright config carries the same arithmetic inline (it cannot import
     * from `scripts/`), so the config's own source is the second implementation.
     *
     * ## This comparison is by VALUE, and the first version was not
     *
     * The first version checked the two constants and the string
     * `sp.test.preview.port.v1` as TEXT — and passed while the two
     * implementations derived DIFFERENT ports, because the script's domain
     * separator was a raw NUL byte and the config's was a space. Neither is
     * visible, `toContain('sp.test.preview.port.v1')` matched both, and the
     * control that existed to prevent exactly this drift did not see it.
     *
     * So the separator BYTES are now extracted from each file and compared, and
     * the config's derivation is RECOMPUTED here from its own extracted
     * separator and asserted equal to the script's answers, root by root. A
     * separator changed in one file and not the other now fails. */
    const configSource = readFileSync(resolve(REPO_ROOT, 'apps/web/playwright.config.ts'), 'utf8');
    const scriptSource = readFileSync(PORT_MODULE, 'utf8');

    expect(configSource).toContain(`const DERIVED_PREVIEW_PORT_BASE = ${String(fromScript.base)};`);
    expect(configSource).toContain(`const DERIVED_PREVIEW_PORT_SPAN = ${String(fromScript.span)};`);

    const seedOf = (source: string): string => {
      const match = /update\(`(sp\.test\.preview\.port\.v1[^`]*?)\$\{root\}`\)/.exec(source);
      if (match?.[1] === undefined) throw new Error('the preview-port seed literal was not found');
      return match[1];
    };
    const configSeed = seedOf(configSource);
    const scriptSeed = seedOf(scriptSource);

    // Byte-for-byte, so an invisible character cannot hide a divergence.
    expect([...configSeed].map((c) => c.codePointAt(0))).toEqual(
      [...scriptSeed].map((c) => c.codePointAt(0)),
    );
    // …and no invisible separator at all: the lesson, made structural.
    expect(configSeed).not.toContain('\u0000');
    expect(configSeed.trim()).toBe(configSeed);

    // The config's derivation, RECOMPUTED, must equal the script's — by value.
    const recomputed = roots.map(
      (root) =>
        fromScript.base +
        (Number.parseInt(
          createHash('sha256').update(`${configSeed}${root}`).digest('hex').slice(0, 8),
          16,
        ) %
          fromScript.span),
    );
    expect(recomputed, 'the config and the script derive different preview ports').toEqual(
      fromScript.ports,
    );

    // Sibling worktrees must land on different ports — the whole point of E-2.
    expect(new Set(fromScript.ports).size).toBe(roots.length);
    for (const port of fromScript.ports) {
      expect(port).toBeGreaterThanOrEqual(fromScript.base);
      expect(port).toBeLessThan(fromScript.base + fromScript.span);
    }

    // The band is clear of 4173, the fixed port every earlier worktree used.
    expect(fromScript.base).toBeGreaterThan(4173);

    // An explicit override still wins, because the red-case harness pins one.
    expect(fromScript.resolvedWithOverride).toBe(4420);
    expect(fromScript.resolvedWithoutOverride).not.toBe(4173);
  });
});
