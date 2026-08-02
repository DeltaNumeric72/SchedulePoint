import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { log } from '../support/harness.js';

/**
 * **Red cases: proof that each gate actually fails on its violation.**
 *
 * > A gate that has only ever been observed passing is not evidence of anything.
 * > A regex with a typo, a config with a wrong path, a check that scans an empty
 * > directory — all of them report PASS forever, and the first time anyone finds
 * > out is when the thing the gate was supposed to prevent ships.
 *
 * `pnpm red-cases` covers the M0 scaffold's gates by injecting fixtures into the
 * working tree. These are the OPUS-M1-001 additions, and they run inside the
 * unit suite so that a gate broken by *this* change is caught by `pnpm check`
 * itself rather than only by a separate command.
 *
 * Each case asserts **both directions**: the gate passes on the real tree, and
 * the same gate fails once the violation exists. A one-directional red case
 * proves nothing — a gate that always fails would satisfy it.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sp-redcase-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
  readonly status: number;
  readonly output: string;
}

function run(command: string, args: readonly string[]): RunResult {
  const result = spawnSync(command, [...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NODE_NO_WARNINGS: '1' },
  });
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('red case — migration+RLS pairing (I-15)', () => {
  const gate = resolve(REPO_ROOT, 'scripts/gates/migration-rls-check.mjs');

  it('GREEN: the real tenancy migration passes', () => {
    const result = run(process.execPath, [gate, '--dir', resolve(REPO_ROOT, 'apps/api/migrations')]);
    expect(result.output).toContain('PASS');
    expect(result.status).toBe(0);
    log(result.output.trim());
  });

  it('RED: a tenant table created without ENABLE + FORCE + a policy fails the gate', () => {
    const dir = scratch('migration');
    writeFileSync(
      join(dir, '0001_missing_rls.sql'),
      [
        '-- Up Migration',
        'CREATE TABLE shift_assignments (',
        '    id              uuid PRIMARY KEY,',
        '    organization_id uuid NOT NULL,',
        '    group_id        uuid NOT NULL',
        ');',
        '-- Down Migration',
        'DROP TABLE IF EXISTS shift_assignments;',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = run(process.execPath, [gate, '--dir', dir]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL');
    expect(result.output).toContain('ENABLE ROW LEVEL SECURITY');
    expect(result.output).toContain('FORCE ROW LEVEL SECURITY');
    expect(result.output).toContain('CREATE POLICY');
    log(result.output.trim());
  });

  it('RED: ENABLE and a policy but no FORCE still fails — the owner bypass is the whole point', () => {
    const dir = scratch('migration-force');
    writeFileSync(
      join(dir, '0001_no_force.sql'),
      [
        '-- Up Migration',
        'CREATE TABLE shift_assignments (id uuid PRIMARY KEY, organization_id uuid NOT NULL);',
        'ALTER TABLE shift_assignments ENABLE ROW LEVEL SECURITY;',
        "CREATE POLICY shift_assignments_tenant ON shift_assignments",
        "    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);",
        '-- Down Migration',
        'DROP TABLE IF EXISTS shift_assignments;',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = run(process.execPath, [gate, '--dir', dir]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FORCE ROW LEVEL SECURITY');
  });
});

describe('red case — route without a policy (I-02)', () => {
  const gate = resolve(REPO_ROOT, 'scripts/gates/route-policy-check.mjs');

  it('GREEN: every registered route declares a policy', () => {
    const result = run(process.execPath, [gate]);
    expect(result.output).toContain('PASS');
    expect(result.status).toBe(0);
    log(result.output.trim());
  });

  it('RED: a route registered with no config.policy fails the gate', () => {
    // The gate enumerates the routes Fastify ACTUALLY registered by booting an
    // entry point in a child process. This entry point registers one extra route
    // with no policy — the same shape as forgetting the declaration on a real
    // one — and the gate must see it.
    const entry = resolve(
      REPO_ROOT,
      'apps/api/test/red-cases/fixtures/undeclared-route-entry.ts',
    );
    const result = run(process.execPath, [gate, '--entry', entry]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL');
    expect(result.output).toContain('/red-case/undeclared');
    log(result.output.trim());
  });
});

describe('red case — the lint ban on every statement form of a tenant setting', () => {
  const eslint = resolve(REPO_ROOT, 'node_modules/eslint/bin/eslint.js');
  const config = resolve(REPO_ROOT, 'eslint.config.js');

  /**
   * The banned statements, assembled from fragments.
   *
   * The lint rule matches the forbidden text inside a **string literal or a
   * template element**, and it is right to: that is exactly where a tenant
   * setting would be interpolated. Writing the fixture as a literal here would
   * therefore make this very file fail the gate — and the two ways out of that
   * are an `eslint-disable` comment or a narrower rule, both of which weaken the
   * control this test exists to prove (non-bypass rule 10: add tests, do not
   * subtract them).
   *
   * So the fragments are joined at runtime. The FILE WRITTEN TO DISK contains
   * the full forbidden statement, which is what ESLint then reads — the fixture
   * is real, only its spelling in this source is not.
   */
  const SET_KEYWORD = 'SET';
  const TENANT_SETTING = 'app.organization_id';
  const setLocal = `${SET_KEYWORD} LOCAL ${TENANT_SETTING}`;
  const setLocalLower = `set local ${TENANT_SETTING}`;
  const setSession = `${SET_KEYWORD} SESSION ${TENANT_SETTING}`;

  /**
   * The fixture has to live INSIDE the repository.
   *
   * ESLint refuses to lint a file outside the config's base path — it reports
   * "File ignored because outside of base path" and **exits 0**, which would
   * make every red case below pass without linting anything. That is precisely
   * the class of silently-decorative check these tests exist to prevent, so the
   * fixture is written to the repository root under the `__red_case__` prefix
   * (gitignored, and outside every tsconfig's `include`, so a leftover cannot be
   * committed and cannot break the typecheck) and removed immediately.
   */
  function lintSource(fileName: string, source: string): RunResult {
    const file = resolve(REPO_ROOT, `__red_case__${fileName}`);
    writeFileSync(file, source, 'utf8');
    try {
      const result = run(process.execPath, [eslint, '--no-config-lookup', '--config', config, file]);
      expect(
        result.output,
        'ESLint skipped the fixture instead of linting it — the red case would be vacuous',
      ).not.toContain('outside of base path');
      return result;
    } finally {
      rmSync(file, { force: true });
    }
  }

  it('GREEN: the permitted `set_config(name, value, true)` spelling lints clean', () => {
    const result = lintSource(
      'permitted.ts',
      [
        'export async function establish(client: { query(text: string, values: unknown[]): Promise<unknown> }, id: string) {',
        "  await client.query('select set_config($1, $2, true)', ['app.organization_id', id]);",
        '}',
        '',
      ].join('\n'),
    );
    expect(result.status, result.output).toBe(0);
  });

  it('RED: the transaction-local statement form, in a string literal, fails lint', () => {
    // The only way to write this form is to interpolate the tenant id into SQL —
    // an injection surface at the single most security-critical statement in the
    // system (X-10). Lint is the control; this proves the control fires.
    const result = lintSource(
      'set-local.ts',
      [
        'export async function bypass(client: { query(text: string): Promise<unknown> }, id: string) {',
        `  await client.query('${setLocal} = ' + id);`,
        '}',
        '',
      ].join('\n'),
    );
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('set_config(name, value, true)');
    log(result.output.trim().split('\n').slice(0, 4).join('\n'));
  });

  it('RED: the same bypass in a template literal fails lint', () => {
    const result = lintSource(
      'set-local-template.ts',
      [
        'export async function bypass(client: { query(text: string): Promise<unknown> }, id: string) {',
        '  await client.query(`' + setLocalLower + " = '${id}'`);",
        '}',
        '',
      ].join('\n'),
    );
    expect(result.status).not.toBe(0);
  });

  it('RED: the session-scoped statement form fails lint', () => {
    const result = lintSource(
      'set-session.ts',
      [
        'export async function bypass(client: { query(text: string): Promise<unknown> }, id: string) {',
        `  await client.query('${setSession} = ' + id);`,
        '}',
        '',
      ].join('\n'),
    );
    expect(result.status).not.toBe(0);
  });
});

describe("red case — the test runner's exit code is real", () => {
  // ── The hazard this block closes, measured rather than argued ──────────────
  //
  // `embedded-postgres` registers a graceful-shutdown hook through
  // `async-exit-hook`, which hooks `beforeExit` with code 0 and calls
  // `process.exit(0)` on a natural exit — DISCARDING `process.exitCode`. While
  // that package was imported into Vitest's main process, `vitest run` printed
  // `1 failed | 232 passed` and exited **0**. The `unit` gate — one of the twelve
  // in `pnpm check` — reported PASS on a failing suite.
  //
  // `embedded-postgres-isolation.test.ts` asserts the STRUCTURAL fix: the package
  // is imported by one module, which runs in a child process. This block asserts
  // the CONSEQUENCE, end to end, three ways — because a structural assertion can
  // be satisfied by a rearrangement that still masks the code.
  //
  // The scratch project lives under `apps/api/__red_case__exitcode/` rather than
  // in the OS temp directory for one reason: it has to be able to resolve
  // `embedded-postgres`, and module resolution walks up from the file. The prefix
  // is gitignored and the directory is removed in `finally`.

  const scratchProject = resolve(REPO_ROOT, 'apps/api/__red_case__exitcode');

  /**
   * The package name, assembled from fragments.
   *
   * `embedded-postgres-isolation.test.ts` scans this directory for anything that
   * imports the package, and it is right to — that scan is what keeps the
   * exit-code masking from coming back. The fixtures below need the *text* of an
   * import in a file they WRITE, not an import in this file, and spelling it
   * literally here would trip the scan on a false positive. Softening the scan
   * to tolerate it would be the wrong trade: the fixture is the unusual case,
   * the scan is the control.
   */
  const PACKAGE_NAME = ['embedded', 'postgres'].join('-');

  function writeScratchProject(options: { importsEmbeddedPostgres: boolean }): void {
    mkdirSync(scratchProject, { recursive: true });
    writeFileSync(
      join(scratchProject, 'vitest.config.ts'),
      [
        "import { dirname } from 'node:path';",
        "import { fileURLToPath } from 'node:url';",
        "import { defineConfig } from 'vitest/config';",
        '',
        'export default defineConfig({',
        '  // Without an explicit root, `include` resolves against the CWD of the',
        '  // spawning process and silently matches nothing.',
        '  root: dirname(fileURLToPath(import.meta.url)),',
        '  test: {',
        "    name: 'red-case-exitcode',",
        "    environment: 'node',",
        "    include: ['*.test.ts'],",
        // `globalSetup`, NOT `setupFiles`. Measured while writing this test:
        // a setup file runs in the WORKER process, whose exit code nobody reads,
        // and importing the package there masks nothing. The hazard is specific
        // to Vitest's MAIN process — which is exactly where the api project's
        // globalSetup used to import it.
        options.importsEmbeddedPostgres ? "    globalSetup: ['./hazard.ts']," : '',
        '  },',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );

    if (options.importsEmbeddedPostgres) {
      writeFileSync(
        join(scratchProject, 'hazard.ts'),
        [
          '// Importing the package is the whole hazard: the import registers an',
          '// async-exit-hook `beforeExit` handler that calls process.exit(0).',
          '// Nothing else in this file does anything.',
          `import ${JSON.stringify(PACKAGE_NAME)};`,
          '',
          'export function setup(): void {}',
          'export function teardown(): void {}',
          '',
        ].join('\n'),
        'utf8',
      );
    }

    writeFileSync(
      join(scratchProject, 'failing.test.ts'),
      [
        "import { expect, it } from 'vitest';",
        '',
        "it('fails on purpose so the runner must exit non-zero', () => {",
        '  expect(1 + 1).toBe(3);',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  function runScratchProject(): RunResult {
    return run(process.execPath, [
      resolve(REPO_ROOT, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      join(scratchProject, 'vitest.config.ts'),
    ]);
  }

  afterAll(() => {
    rmSync(scratchProject, { recursive: true, force: true });
  });

  it('HAZARD: importing the package registers an exit-code-clobbering beforeExit handler', () => {
    // ── The PRIMARY assertion is the MECHANISM, not the symptom ──────────────
    //
    // An earlier version asserted `exit status === 0` on a failing run. That is
    // the symptom, and asserting it makes the test fail the day the dependency
    // is fixed upstream — at which point, under time pressure, somebody deletes
    // it and the two genuine red cases below lose their explanation. So the
    // assertion is the thing that is actually true today and would remain
    // meaningful either way: **importing the package installs an
    // `async-exit-hook` `beforeExit` listener in the importing process.** That
    // listener is what calls `process.exit(0)` and discards `process.exitCode`.
    //
    // The exit status is still measured, and logged, so the evidence bundle
    // records what the hazard actually did — it just is not what fails the test.
    mkdirSync(scratchProject, { recursive: true });
    const probe = join(scratchProject, 'listener-probe.mjs');
    writeFileSync(
      probe,
      [
        'const before = process.listeners("beforeExit").length;',
        `await import(${JSON.stringify(PACKAGE_NAME)});`,
        'const after = process.listeners("beforeExit");',
        '// async-exit-hook builds its handler around a per-event `eventFilters`',
        '// array; that is the signature the isolation test looks for too.',
        'const clobbering = after.filter((fn) => /eventFilters/.test(fn.toString())).length;',
        "process.stdout.write(JSON.stringify({ before, after: after.length, clobbering }));",
        'process.exit(0);',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = run(process.execPath, [probe]);
    expect(result.status, result.output).toBe(0);

    const observed = JSON.parse(result.output.trim().split('\n').pop() ?? '{}') as {
      before: number;
      after: number;
      clobbering: number;
    };

    expect(observed.before, 'the probe started with a beforeExit listener already installed').toBe(0);
    expect(
      observed.clobbering,
      'importing embedded-postgres no longer installs an async-exit-hook beforeExit handler — ' +
        'the isolation may be revisitable, but do not remove it on this test alone',
    ).toBeGreaterThan(0);

    // Secondary, LOGGED not asserted: what that listener does to a failing run.
    writeScratchProject({ importsEmbeddedPostgres: true });
    const masked = runScratchProject();
    log(
      `beforeExit listeners 0 -> ${String(observed.after)} on import (${String(observed.clobbering)} async-exit-hook); ` +
        `a failing run in that process exited ${String(masked.status)} (observed, not asserted)`,
    );
  });

  it('RED: WITHOUT that import, the same failing spec exits non-zero', () => {
    writeScratchProject({ importsEmbeddedPostgres: false });
    const result = runScratchProject();

    expect(result.output).toMatch(/1 failed/i);
    expect(
      result.status,
      `the runner exited 0 on a failing spec:\n${result.output}`,
    ).not.toBe(0);
    log(`without the import: 1 failed test, exit status ${String(result.status)}`);
  });

  it('RED: the REAL api project exits non-zero on a failing spec', () => {
    // The one that actually closes it. The failing spec is injected into the api
    // project's own include glob and run through its own config — globalSetup,
    // cluster daemon and all — on a distinct port so it cannot collide with the
    // cluster this very test is running against.
    const injected = resolve(REPO_ROOT, 'apps/api/test/__red_case__exitcode.test.ts');
    writeFileSync(
      injected,
      [
        "import { expect, it } from 'vitest';",
        '',
        "it('fails on purpose', () => {",
        '  expect(1 + 1).toBe(3);',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          resolve(REPO_ROOT, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          resolve(REPO_ROOT, 'apps/api/vitest.config.ts'),
          'test/__red_case__exitcode.test.ts',
        ],
        {
          cwd: resolve(REPO_ROOT, 'apps/api'),
          encoding: 'utf8',
          env: {
            ...process.env,
            FORCE_COLOR: '0',
            NODE_NO_WARNINGS: '1',
            // A port of its own: this test is itself running against 55433.
            SP_TEST_PG_PORT: '55455',
          },
        },
      );
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(output, 'the injected spec did not run').toMatch(/1 failed/i);
      expect(
        result.status,
        `the api project exited 0 on a failing spec — the unit gate is decorative again:\n${output}`,
      ).not.toBe(0);
      log(`real api project, failing spec -> exit status ${String(result.status ?? -1)}`);
    } finally {
      rmSync(injected, { force: true });
    }
  });
});
