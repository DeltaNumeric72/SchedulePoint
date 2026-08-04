import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CLUSTER_DATA_DIR,
  CLUSTER_PORT,
  DERIVED_PORT_BASE,
  DERIVED_PORT_SPAN,
  REPO_ROOT,
  deriveTestPgPort,
} from '../support/env.js';

/**
 * The per-worktree port derivation, and the control that keeps its two
 * implementations equal (OPUS-M2-004, finding E-1).
 *
 * ## Why there are two implementations at all
 *
 * The harness needs the port in TypeScript (`apps/api/test/support/env.ts`); the
 * red-case runner and the SBX scripts need it in JavaScript, and `scripts/` is
 * outside every TypeScript project in this repository, so it cannot import the
 * TypeScript one. Duplication was the choice with the fewest moving parts — and
 * duplicated arithmetic that nothing compares is exactly how two "identical"
 * derivations drift into pointing two processes at two different clusters,
 * which is the failure E-1 describes.
 *
 * So the JavaScript module is **executed** here, in a child `node`, and its
 * answers are compared with this process's TypeScript answers. Reading the file
 * and diffing the source would prove the text matched; running it proves the
 * numbers do.
 */

const PORT_MODULE = resolve(REPO_ROOT, 'scripts/sbx/test-port.mjs');

/** Paths chosen to exercise different digests, including two sibling worktrees. */
const SAMPLE_ROOTS = [
  '/synthetic/repo',
  '/synthetic/repo/.worktrees/m2-002',
  '/synthetic/repo/.worktrees/m2-003',
  '/synthetic/repo/.worktrees/m2-004',
  '/a',
  '/synthetic/repo with spaces/and-a-longer-tail/0123456789',
];

/** Runs `scripts/sbx/test-port.mjs` in a child process and returns its answers. */
function derivedByTheScript(roots: readonly string[]): {
  readonly ports: number[];
  readonly base: number;
  readonly span: number;
  readonly repoRoot: string;
  readonly resolvedWithoutOverride: number;
} {
  const script = [
    `const m = await import(${JSON.stringify(PORT_MODULE)});`,
    `const roots = ${JSON.stringify(roots)};`,
    'process.stdout.write(JSON.stringify({',
    '  ports: roots.map((r) => m.deriveTestPgPort(r)),',
    '  base: m.DERIVED_PORT_BASE,',
    '  span: m.DERIVED_PORT_SPAN,',
    '  repoRoot: m.REPO_ROOT,',
    '  resolvedWithoutOverride: m.resolveTestPgPort({}),',
    '}));',
  ].join('\n');

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `scripts/sbx/test-port.mjs could not be executed: ${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(result.stdout) as ReturnType<typeof derivedByTheScript>;
}

describe('the embedded-postgres port is derived per worktree (E-1)', () => {
  it('the TypeScript and JavaScript derivations agree, root by root', () => {
    const fromScript = derivedByTheScript(SAMPLE_ROOTS);

    expect(fromScript.base).toBe(DERIVED_PORT_BASE);
    expect(fromScript.span).toBe(DERIVED_PORT_SPAN);
    expect(fromScript.repoRoot).toBe(REPO_ROOT);
    expect(fromScript.ports).toEqual(SAMPLE_ROOTS.map((root) => deriveTestPgPort(root)));

    // The control that makes the equality above mean something: the sample roots
    // must not all hash to the same port, or "they agree" would be a statement
    // about one number.
    expect(new Set(fromScript.ports).size).toBeGreaterThan(1);
  });

  it('sibling worktrees derive DIFFERENT ports — the whole point of E-1', () => {
    const two = deriveTestPgPort('/synthetic/repo/.worktrees/m2-002');
    const three = deriveTestPgPort('/synthetic/repo/.worktrees/m2-003');
    const four = deriveTestPgPort('/synthetic/repo/.worktrees/m2-004');
    expect(new Set([two, three, four]).size).toBe(3);
  });

  it('every derived port lands in the reserved band, above every documented fixed port', () => {
    // 55432 (SP-A spike), 55433 (the old shared default) and every port pinned in
    // an evidence capture are below 55500, so a derived port can never collide
    // with a documented fixed one.
    for (const root of SAMPLE_ROOTS) {
      const port = deriveTestPgPort(root);
      expect(port).toBeGreaterThanOrEqual(DERIVED_PORT_BASE);
      expect(port).toBeLessThan(DERIVED_PORT_BASE + DERIVED_PORT_SPAN);
    }
    expect(DERIVED_PORT_BASE).toBeGreaterThan(55433);
  });

  it('derivation is stable: the same root gives the same port every time', () => {
    const first = deriveTestPgPort(REPO_ROOT);
    const second = deriveTestPgPort(REPO_ROOT);
    expect(second).toBe(first);
  });

  it('the data directory follows the port, so a distinct port is a distinct instance', () => {
    expect(CLUSTER_DATA_DIR.endsWith(`.pgdata-test-${String(CLUSTER_PORT)}`)).toBe(true);
  });

  it('an explicit SP_TEST_PG_PORT still wins, and a malformed one throws', () => {
    // Asserted through the JavaScript module, which takes its environment as an
    // argument — the TypeScript side reads `process.env` once at module load and
    // mutating it here would not re-run that.
    const script = [
      `const m = await import(${JSON.stringify(PORT_MODULE)});`,
      'const out = { override: m.resolveTestPgPort({ SP_TEST_PG_PORT: "55445" }) };',
      'try { m.resolveTestPgPort({ SP_TEST_PG_PORT: "not-a-port" }); out.threw = false; }',
      'catch { out.threw = true; }',
      'out.blankFallsBackToDerived = m.resolveTestPgPort({ SP_TEST_PG_PORT: "  " }) === m.deriveTestPgPort(m.REPO_ROOT);',
      'process.stdout.write(JSON.stringify(out));',
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      override: number;
      threw: boolean;
      blankFallsBackToDerived: boolean;
    };
    expect(parsed.override).toBe(55445);
    expect(parsed.threw).toBe(true);
    expect(parsed.blankFallsBackToDerived).toBe(true);
  });
});
