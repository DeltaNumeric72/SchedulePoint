import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { log } from '../support/harness.js';

/**
 * **`embedded-postgres` must never be imported by the test runner's process.**
 *
 * ## The measurement this test exists to protect
 *
 * `embedded-postgres` registers a graceful-shutdown hook via `async-exit-hook`,
 * which hooks `beforeExit` with code `0` and calls `process.exit(0)` on a
 * natural exit. That **discards `process.exitCode`**:
 *
 * ```
 * $ node -e "import('embedded-postgres').then(() => { process.exitCode = 1 })"
 * $ echo $?
 * 0
 * ```
 *
 * When the package was imported into Vitest's main process, `vitest run` printed
 * `1 failed | 232 passed` and exited **0**. The `unit` gate — one of the twelve
 * that `pnpm check` runs — reported PASS on a failing suite, and would have gone
 * on doing so for every future change. `pnpm red-cases` is what caught it.
 *
 * The fix is structural: the package is imported by `test/support/cluster.ts`,
 * which is imported by `test/support/cluster-daemon.ts`, which runs as a **child
 * process** spawned by `globalSetup`. This test asserts that arrangement holds,
 * because the failure it prevents is invisible — a masked exit code looks
 * exactly like a passing suite.
 *
 * ## Why an import scan rather than a runtime check
 *
 * A runtime check would have to run inside the very process whose exit code is
 * being clobbered, and it could only observe the symptom after the fact. The
 * import graph is the cause, and it is checkable before anything runs.
 */

const TEST_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC_ROOT = resolve(fileURLToPath(new URL('../../src', import.meta.url)));

const PACKAGE = 'embedded-postgres';
/** The one module allowed to import it. */
const PERMITTED_IMPORTER = 'support/cluster.ts';
/** The one module allowed to import THAT. */
const PERMITTED_CONSUMER = 'support/cluster-daemon.ts';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * Strips comments before scanning.
 *
 * The docblocks in these very files quote `import('embedded-postgres')` as the
 * reproduction of the bug. A scan that counted those would report a violation
 * for the file explaining the violation — and the obvious fix, softening the
 * pattern, would be the start of a scan that matches nothing.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function importersOf(root: string, specifierPattern: RegExp): string[] {
  const found: string[] = [];
  for (const absolute of walk(root)) {
    if (!absolute.endsWith('.ts')) continue;
    const source = code(readFileSync(absolute, 'utf8'));
    const statements = source.match(/^\s*(?:import|export)\b[^\n]*from\s+['"][^'"]+['"]/gm) ?? [];
    const dynamic = source.match(/\bimport\(\s*['"][^'"]+['"]\s*\)/g) ?? [];
    if ([...statements, ...dynamic].some((line) => specifierPattern.test(line))) {
      found.push(relative(root, absolute).replaceAll('\\', '/'));
    }
  }
  return found;
}

describe('embedded-postgres is confined to the cluster daemon', () => {
  it(`only ${PERMITTED_IMPORTER} imports ${PACKAGE}`, () => {
    const importers = importersOf(TEST_ROOT, /['"]embedded-postgres['"]/);
    expect(importers.sort()).toEqual([PERMITTED_IMPORTER]);
    log(`${PACKAGE} is imported by exactly one module: ${importers.join(', ')}`);
  });

  it(`only ${PERMITTED_CONSUMER} imports ${PERMITTED_IMPORTER}`, () => {
    // Matches both `./cluster.js` and `../support/cluster.js`, and deliberately
    // does NOT match `./cluster-daemon.js` or `./admin-client.js`.
    const importers = importersOf(TEST_ROOT, /['"][^'"]*(?:^|\/)cluster\.js['"]/);
    expect(importers.sort()).toEqual([PERMITTED_CONSUMER]);
    log(`support/cluster.ts is imported by exactly one module: ${importers.join(', ')}`);
  });

  it('no production source imports it — it is a devDependency of the harness', () => {
    const importers = importersOf(SRC_ROOT, /['"]embedded-postgres['"]/);
    expect(importers).toEqual([]);
  });

  it('the scan can actually find an importer — it is not matching nothing', () => {
    // A scan whose pattern never matches reports "no violations" forever. This
    // proves the mechanism by pointing it at something that IS imported widely.
    const pgImporters = importersOf(TEST_ROOT, /['"]pg['"]/);
    expect(pgImporters.length).toBeGreaterThan(1);
  });

  it('this very process therefore has no exit-code-clobbering beforeExit hook', () => {
    // The direct symptom check. `async-exit-hook` registers exactly one
    // `beforeExit` listener; Vitest's worker registers none of that shape. If
    // this ever becomes non-zero, the suite's exit code is no longer meaningful.
    const listeners = process.listeners('beforeExit');
    const clobbering = listeners.filter((listener) => /eventFilters/.test(listener.toString()));
    expect(
      clobbering,
      'an async-exit-hook beforeExit listener is installed in the test process',
    ).toEqual([]);
  });
});
