import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CLUSTER_DATA_DIR,
  CLUSTER_PORT,
  DERIVED_NESTED_PORT_BASE,
  DERIVED_PORT_BASE,
  DERIVED_PORT_SPAN,
  nestedClusterPort,
  REPO_ROOT,
  deriveNestedTestPgPort,
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
  readonly nestedBase: number;
  readonly nestedPorts: number[];
  readonly nestedResolved: number;
  readonly nestedOverride: number;
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
    '  nestedBase: m.DERIVED_NESTED_PORT_BASE,',
    '  nestedPorts: roots.map((r) => m.deriveNestedTestPgPort(r)),',
    '  nestedResolved: m.resolveNestedTestPgPort({}),',
    '  nestedOverride: m.resolveNestedTestPgPort({ SP_TEST_NESTED_PG_PORT: "56999" }),',
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

  it('the NESTED cluster port is derived too, and agrees across both implementations (O-1)', () => {
    /* `gates-fail-on-violations.test.ts` spawns the whole api project from inside
     * a test, which needs a cluster of its own. That port was the fixed `55455`
     * until this revision — the same class E-1 closed for the main cluster, and it
     * failed the same way: under two concurrent batteries the nested runs collided
     * and fixed seed 8675309 reported a failure that passes serially. It had
     * already been recorded once, at that same seed, by OPUS-M3-002. */
    const fromScript = derivedByTheScript(SAMPLE_ROOTS);

    expect(fromScript.nestedBase).toBe(DERIVED_NESTED_PORT_BASE);
    // By VALUE, root by root — the standard the preview-port control was raised
    // to after it passed while two implementations disagreed.
    expect(fromScript.nestedPorts).toEqual(SAMPLE_ROOTS.map((root) => deriveNestedTestPgPort(root)));
    expect(fromScript.nestedResolved).toBe(nestedClusterPort());
    expect(fromScript.nestedOverride, 'an explicit override must still win').toBe(56999);

    // The two bands are ADJACENT and DISJOINT, so a nested port can never be
    // mistaken for a main one on any worktree.
    expect(DERIVED_NESTED_PORT_BASE).toBe(DERIVED_PORT_BASE + DERIVED_PORT_SPAN);
    for (const [index, root] of SAMPLE_ROOTS.entries()) {
      const main = deriveTestPgPort(root);
      const nested = deriveNestedTestPgPort(root);
      expect(nested - main, `${root} (sample ${String(index)})`).toBe(DERIVED_PORT_SPAN);
      expect(nested).toBeGreaterThanOrEqual(DERIVED_NESTED_PORT_BASE);
      expect(nested).toBeLessThan(DERIVED_NESTED_PORT_BASE + DERIVED_PORT_SPAN);
    }

    // No sample root's nested port is any other sample root's MAIN port, and the
    // whole point: sibling worktrees get distinct nested ports.
    const mains = new Set(SAMPLE_ROOTS.map((root) => deriveTestPgPort(root)));
    const nesteds = SAMPLE_ROOTS.map((root) => deriveNestedTestPgPort(root));
    expect(nesteds.filter((port) => mains.has(port))).toEqual([]);
    expect(new Set(nesteds).size).toBe(new Set(SAMPLE_ROOTS.map((r) => deriveTestPgPort(r))).size);

    // …and this run's own nested port is not this run's own cluster port.
    expect(nestedClusterPort()).not.toBe(CLUSTER_PORT);
  });

  it('no test hard-codes a cluster port any more — the structural half of O-1', () => {
    /* The equality control above cannot notice a THIRD spawn site that invents
     * its own port, which is exactly what `55455` was for four milestones. So the
     * test tree is scanned for a literal `SP_TEST_PG_PORT: '<digits>'`.
     *
     * Calls to the RESOLVERS are stripped first: `resolveTestPgPort({
     * SP_TEST_PG_PORT: "55445" })` is a literal port passed as an ARGUMENT to the
     * function under test — it configures nothing and spawns nothing, and the
     * override tests in this file need it. Everything else naming a port in an
     * environment is configuring a real process. */
    const testRoot = resolve(REPO_ROOT, 'apps/api/test');
    const RESOLVER_CALL = /resolve(?:Nested)?TestPgPort\(\{[^}]*\}\)/g;
    const HARD_CODED = /SP_TEST_(?:NESTED_)?PG_PORT:\s*['"`]\d+['"`]/;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const source = readFileSync(path, 'utf8').replace(RESOLVER_CALL, '');
        if (HARD_CODED.test(source)) offenders.push(path.slice(REPO_ROOT.length + 1));
      }
    };
    walk(testRoot);
    expect(offenders, 'a test spawns a cluster on a hard-coded port').toEqual([]);

    /* Non-vacuous: the scan MUST fire on the shape it exists to catch, or an
     * empty list means nothing. This is the exact text that stood at
     * `gates-fail-on-violations.test.ts:470` for four milestones.
     *
     * It is ASSEMBLED from two halves rather than written out, because a scanner
     * that walks this directory would otherwise find its own probe and report
     * this file — which it did, on the first run. A control whose evidence
     * incriminates the control is a control nobody can keep green. */
    const wasThere = `SP_TEST_PG_PORT` + `: '55455',`;
    expect(HARD_CODED.test(wasThere), 'the scan does not fire on the shape it exists for').toBe(
      true,
    );
    const isThereNow = `SP_TEST_PG_PORT` + `: String(nestedClusterPort()),`;
    expect(HARD_CODED.test(isThereNow), 'the scan fires on the derived form').toBe(false);
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
