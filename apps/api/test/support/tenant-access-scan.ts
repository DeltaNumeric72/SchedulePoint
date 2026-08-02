import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { TENANT_TABLES } from '../../src/db/schema.js';

/**
 * The static half of non-bypass rule 1 / I-15: **no code outside the unit of
 * work touches a connection or names a tenant table.**
 *
 * ## Why the scanner lives here rather than inside its test file
 *
 * The first version of this check declared its patterns inside the test and
 * re-declared them again in the "red case", so the red case exercised a *copy*
 * of the rules and would have passed happily while the real scan was broken.
 * That is the exact failure mode a red case exists to prevent, and the
 * independent review caught it.
 *
 * Now there is one implementation, exported, and the red case runs **it** against
 * a handler-shaped fixture on disk. Narrow a pattern and the red case goes red.
 *
 * ## Why static as well as runtime
 *
 * T-13 proves the database refuses — a statement outside the wrapper reads zero
 * rows and cannot write, which is what makes forgetting the wrapper a loud
 * failure rather than a leak. But T-13 cannot prove that no such code path
 * *exists*. A direct query that returns zero rows is still a bug: it is a feature
 * that silently does nothing. This catches it in review instead of in production
 * support.
 */

export interface DirectAccessFinding {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

/**
 * A module permitted to hold a connection. Each is the implementation of a
 * boundary rather than a caller across one, and each carries its reason.
 */
export interface ConnectionOwner {
  readonly file: string;
  readonly reason: string;
}

export const CONNECTION_OWNERS: readonly ConnectionOwner[] = [
  {
    file: 'db/unit-of-work.ts',
    reason: 'IS the unit of work — it owns BEGIN, COMMIT and the pinned client',
  },
  { file: 'db/pool.ts', reason: 'constructs the pool; issues no statement of its own' },
  {
    file: 'db/pooler-assertion.ts',
    reason:
      'the startup transaction-affinity probe (SPEC-01 §4 amendment (c)); touches no tenant table',
  },
  {
    file: 'db/bootstrap.ts',
    reason: 'cluster bootstrap as superuser: roles and the database, before any tenant table exists',
  },
  { file: 'db/migrate.ts', reason: 'runs migrations as app_migrator; never application traffic' },
];

/** Comments discuss connections and tenant tables constantly; the scan is about code. */
function codeOnly(line: string): string {
  return line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * The detectors, as data, so both the scan and its red case use the same list.
 *
 * `label` is what a violation reports; a reader who trips one should be able to
 * tell from the message what rule they broke and why it exists.
 */
export const DIRECT_ACCESS_DETECTORS: readonly {
  readonly id: string;
  readonly pattern: RegExp;
  readonly label: string;
}[] = [
  {
    id: 'imports-driver',
    pattern: /\bfrom\s+['"]pg['"]/,
    label: 'imports the pg driver outside the unit of work',
  },
  {
    id: 'checks-out-connection',
    pattern: /\.\s*connect\s*\(\s*\)/,
    label: 'checks out a connection outside the unit of work',
  },
  {
    id: 'raw-query',
    pattern: /\b(?:client|pool|db)\s*\.\s*query\s*\(/,
    label: 'issues a raw statement outside the unit of work',
  },
];

/** `select … from memberships`, `insert into groups`, … inside a string literal. */
function tenantTableDetectors(): { pattern: RegExp; label: string }[] {
  return TENANT_TABLES.map((table) => ({
    pattern: new RegExp(
      String.raw`['"\`][^'"\`]*\b(?:from|into|update|join)\s+${table.name}\b`,
      'i',
    ),
    label: `names the tenant table \`${table.name}\` in a SQL string literal`,
  }));
}

export interface ScanOptions {
  /** Files (relative to `root`, forward slashes) exempt from the scan. */
  readonly permitted?: readonly string[];
}

/**
 * Scans every `.ts` file under `root`.
 *
 * @param root absolute directory to walk.
 */
export function scanForDirectTenantAccess(
  root: string,
  options: ScanOptions = {},
): DirectAccessFinding[] {
  const permitted = new Set(options.permitted ?? CONNECTION_OWNERS.map((owner) => owner.file));
  const detectors = [...DIRECT_ACCESS_DETECTORS, ...tenantTableDetectors()];
  const findings: DirectAccessFinding[] = [];

  for (const absolute of walk(root)) {
    if (!absolute.endsWith('.ts')) continue;
    const file = relative(root, absolute).replaceAll('\\', '/');
    if (permitted.has(file)) continue;

    readFileSync(absolute, 'utf8')
      .split('\n')
      .forEach((text, index) => {
        const code = codeOnly(text);
        // `import type pg from 'pg'` is a type-only import: it disappears at
        // runtime and cannot hold a connection.
        const typeOnlyImport = /^\s*import\s+type\b/.test(code);
        for (const detector of detectors) {
          if (typeOnlyImport && detector.label.startsWith('imports the pg driver')) continue;
          if (detector.pattern.test(code)) {
            findings.push({ file, line: index + 1, detail: detector.label });
          }
        }
      });
  }

  return findings;
}
