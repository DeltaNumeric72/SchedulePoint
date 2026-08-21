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

  /* ── OPUS-M1-003: the queue's own infrastructure ──────────────────────────
   *
   * Both own a connection and NEITHER touches a tenant table. They live under
   * `db/` because this file's own rule says connection ownership belongs there,
   * and satisfying an architecture rule is the right response to it — adding an
   * exemption that widened the rule would have been the quiet form of weakening
   * it (non-bypass rule 10).
   *
   * Because an entry here suppresses the tenant-table detectors as well as the
   * connection ones, each is re-asserted specifically by
   * `apps/api/test/audit/architecture.test.ts`, which scans both files for any
   * tenant-table reference and fails if one appears.
   */
  {
    file: 'db/queue-schema.ts',
    reason:
      "installs graphile-worker's own schema and SP-D condition C-1's policies, as app_migrator, " +
      'before any traffic. The same kind of step as db/bootstrap.ts, and it touches no tenant table',
  },
  {
    file: 'db/queue-pools.ts',
    reason:
      'SP-D condition C-2: registers this worker pool and force-unlocks dead peers. Touches ' +
      'queue_pools and graphile_worker only — neither is tenant-scoped, and the reclaim is not ' +
      'per tenant so it cannot run inside a unit of work',
  },
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

/**
 * **NR-16 — the bare-line detector** (FAD-33; doc 35 §6g Included (E)).
 *
 * The detector above requires a quote character EARLIER ON THE SAME LINE, which
 * is how a single-line SQL literal looks. A multi-line template literal does not
 * look like that:
 *
 * ```ts
 *   await sql`
 *     select id
 *       from memberships          <- no quote on this line. Undetected.
 *      where organization_id = ${x}
 *   `.execute(client);
 * ```
 *
 * So the arm that is supposed to catch "a direct query naming a tenant table"
 * could be evaded by pressing Enter. The connection detectors were unaffected —
 * which is why the gap scored low — but the tenant-table arm was the half that
 * would notice a query written against a connection somebody had already been
 * permitted to hold.
 *
 * This matches a line that IS a bare SQL fragment naming a tenant table: the
 * clause keyword at the start of the line, the table straight after it, and no
 * quote anywhere on the line. Requiring the keyword at the START is what keeps
 * it from firing on prose and on ordinary TypeScript — `const from = x` has no
 * table after it, and `.innerJoin('shifts', …)` carries its quotes.
 */
function bareLineTenantTableDetectors(): { pattern: RegExp; label: string }[] {
  return TENANT_TABLES.map((table) => ({
    pattern: new RegExp(
      String.raw`^\s*(?:from|into|update|join|delete\s+from)\s+${table.name}\b`,
      'i',
    ),
    label:
      `names the tenant table \`${table.name}\` on a BARE SQL line — a multi-line ` +
      'template literal is still a direct query (NR-16)',
  }));
}

/**
 * Files carrying a bare-line hit that predates the detector, pinned by path AND
 * count — the NUL gate's baseline pattern, and for the same reasons.
 *
 * NR-16's register entry names the situation: "live instances exist in
 * `publication.ts`", and "tightening ripples across existing modules so it needs
 * its own packet scope". Each entry below is a module that legitimately holds
 * multi-line SQL inside a unit of work, where the scanner cannot tell a
 * `uow.query` template from a `client.query` one — the detector is a
 * lexical control, not a dataflow one, and pretending otherwise would be worse
 * than pinning them.
 *
 * The pin is by COUNT, so:
 *
 *  * a NEW bare-line query anywhere fails;
 *  * a new one in a pinned FILE fails too — the pin says "exactly this many at
 *    this path", never "this path is exempt";
 *  * removing one fails, so the baseline shrinks deliberately rather than
 *    rotting.
 */
export const BARE_LINE_BASELINE: ReadonlyMap<string, number> = new Map([
  ['audit/checkpoints.ts', 1],
  ['audit/reader.ts', 1],
  ['audit/verification.ts', 2],
  ['authn/store.ts', 19],
  ['http/routes/schedule-publication.route.ts', 6],
  ['outbox/dispatcher.ts', 3],
  ['rules/service.ts', 2],
  ['schedule/publication.ts', 4],
  ['schedule/review-identity.ts', 7],
  ['solver/canonical-input.ts', 2],
  ['solver/snapshot-store.ts', 2],
]);

export interface ScanOptions {
  /** Files (relative to `root`, forward slashes) exempt from the scan. */
  readonly permitted?: readonly string[];
  /**
   * The pinned bare-line counts to reconcile against. **Empty unless supplied**
   * — see {@link BARE_LINE_BASELINE}, which the real `apps/api/src` scan passes
   * and which a fixture scan deliberately does not.
   */
  readonly bareLineBaseline?: ReadonlyMap<string, number>;
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
  const detectors = [
    ...DIRECT_ACCESS_DETECTORS,
    ...tenantTableDetectors(),
    ...bareLineTenantTableDetectors(),
  ];
  const findings: DirectAccessFinding[] = [];
  const bareLineCounts = new Map<string, number>();
  const bareLineTables = new Map<string, Set<string>>();
  /* Empty by DEFAULT, and the caller opts in. The baseline is a statement about
   * `apps/api/src` and means nothing about a fixture directory — a default that
   * applied everywhere made every red-case scratch scan report eleven "the
   * baseline shrank" findings, which is the shrink rule working against a
   * question nobody asked it. */
  const baseline = options.bareLineBaseline ?? new Map<string, number>();

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
          const isBareLine = detector.label.includes('BARE SQL line');
          /* A bare line inside a quoted single-line literal is already the other
           * detector's business; requiring the absence of any quote keeps the
           * two from double-reporting one site. */
          if (isBareLine && /['"`]/.test(code)) continue;
          if (detector.pattern.test(code)) {
            if (isBareLine) {
              bareLineCounts.set(file, (bareLineCounts.get(file) ?? 0) + 1);
              /* The TABLES, not only a number. A count tells a reader a file has
               * three of these; the names tell them which query to go and look
               * at, which is the difference between a finding and a chore. */
              const tables = bareLineTables.get(file) ?? new Set<string>();
              tables.add(detector.label.split('`')[1] ?? 'unknown');
              bareLineTables.set(file, tables);
              continue;
            }
            findings.push({ file, line: index + 1, detail: detector.label });
          }
        }
      });
  }

  /* The bare-line findings are reconciled against the baseline AFTER the sweep,
   * because the question is per FILE and per COUNT rather than per line. */
  for (const [file, count] of bareLineCounts) {
    const allowed = baseline.get(file);
    if (allowed === count) continue;
    findings.push({
      file,
      line: 0,
      detail:
        allowed === undefined
          ? `${String(count)} bare SQL line(s) naming a tenant table (NR-16): ` +
            [...(bareLineTables.get(file) ?? [])].sort().join(', ')
          : `${String(count)} bare SQL line(s) naming a tenant table, but the baseline pins ` +
            `exactly ${String(allowed)} — a pinned file is not exempt, its count is pinned`,
    });
  }
  for (const [file, allowed] of baseline) {
    if (bareLineCounts.has(file)) continue;
    findings.push({
      file,
      line: 0,
      detail:
        `the baseline pins ${String(allowed)} bare SQL line(s) naming a tenant table and there ` +
        'are now none — remove the entry, the baseline shrinks deliberately',
    });
  }

  return findings;
}
