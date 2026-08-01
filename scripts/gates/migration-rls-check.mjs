import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { REPO_ROOT, lineOf, lineStarts, listFiles, parseArgs, rel, report } from './lib/gate.mjs';

/**
 * Migration + RLS pairing check — I-15, SPEC-01 §4.
 *
 * A tenant table without a row-level-security policy is a cross-tenant leak
 * waiting for its first query, and the gap is invisible in review because the
 * `CREATE TABLE` looks correct on its own. So the rule is mechanical and
 * same-file: whatever creates a tenant table must, **in the same migration**,
 * enable RLS, force it, and create at least one policy.
 *
 * Same-file rather than same-deployment because migrations are applied one at a
 * time. Between "table created" and "policy created in the next file" there is a
 * real window, and a failed deploy can make that window permanent.
 *
 * Opting out is possible and deliberately awkward: a table can be marked
 * non-tenant with a `-- rls: not-tenant-scoped (<reason>)` comment on the line
 * before its `CREATE TABLE`. The reason is required and shows up in the diff.
 */

/** @typedef {{ file: string, line: number, detail: string }} Violation */

const CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?([A-Za-z0-9_."]+)/gi;
const OPT_OUT = /--\s*rls:\s*not-tenant-scoped\s*\((.+?)\)/i;

/** @param {string} identifier */
function normalizeTable(identifier) {
  const bare = identifier.replaceAll('"', '');
  const parts = bare.split('.');
  return (parts[parts.length - 1] ?? bare).toLowerCase();
}

/**
 * Strips block comments so a commented-out `CREATE TABLE` is not scanned, while
 * keeping line comments (the opt-out marker is a line comment).
 *
 * @param {string} sql
 */
function stripBlockComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * @param {{ path: string, sql: string }} file
 * @returns {Violation[]}
 */
export function analyzeFile({ path, sql }) {
  const source = stripBlockComments(sql);
  const starts = lineStarts(source);
  /** @type {Violation[]} */
  const violations = [];

  for (const match of source.matchAll(CREATE_TABLE)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const table = normalizeTable(raw);
    const index = match.index ?? 0;
    const line = lineOf(starts, index);

    // Look for an opt-out on this line or the line before it.
    const lineStart = starts[line - 1] ?? 0;
    const prevStart = starts[line - 2] ?? 0;
    const context = source.slice(prevStart, source.indexOf('\n', lineStart) + 1 || undefined);
    const optOut = OPT_OUT.exec(context);
    if (optOut !== null && (optOut[1] ?? '').trim().length > 0) continue;

    const escaped = table.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    const tableRef = String.raw`(?:[A-Za-z0-9_]+\.)?"?${escaped}"?`;

    const enabled = new RegExp(
      String.raw`alter\s+table\s+(?:if\s+exists\s+)?${tableRef}\s+enable\s+row\s+level\s+security`,
      'i',
    ).test(source);
    const forced = new RegExp(
      String.raw`alter\s+table\s+(?:if\s+exists\s+)?${tableRef}\s+force\s+row\s+level\s+security`,
      'i',
    ).test(source);
    const policed = new RegExp(
      String.raw`create\s+policy\s+[A-Za-z0-9_"]+\s+on\s+${tableRef}`,
      'i',
    ).test(source);

    /** @type {string[]} */
    const missing = [];
    if (!enabled) missing.push('ENABLE ROW LEVEL SECURITY');
    if (!forced) missing.push('FORCE ROW LEVEL SECURITY');
    if (!policed) missing.push('CREATE POLICY');

    if (missing.length > 0) {
      violations.push({
        file: path,
        line,
        detail: `table "${table}" created without ${missing.join(' + ')} in the same migration`,
      });
    }
  }

  return violations;
}

/**
 * @param {{ path: string, sql: string }[]} files
 * @returns {Violation[]}
 */
export function analyze(files) {
  return files.flatMap((f) => analyzeFile(f));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir =
    typeof args['dir'] === 'string'
      ? resolve(args['dir'])
      : resolve(REPO_ROOT, 'apps/api/migrations');

  const files = listFiles(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((path) => ({ path: rel(path), sql: readFileSync(path, 'utf8') }));

  process.exit(
    report(
      'migration-rls-pairing (I-15)',
      analyze(files),
      `${String(files.length)} migration file(s) in ${rel(dir)}`,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
