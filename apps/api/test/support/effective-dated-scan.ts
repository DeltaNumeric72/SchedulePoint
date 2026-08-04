import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The "one selector" scan — the structural half of the S-01 lesson.
 *
 * ## Why it lives here rather than inside its test
 *
 * `tenant-access-scan.ts` and `audit-emission-scan.ts` both moved out of their
 * test files for the same reason, and R-02 against OPUS-M1-003 is the precedent:
 * a check declared inside the test that asserts it can only ever be exercised in
 * one direction. **A scanner that has only ever been observed passing is not
 * evidence of anything** — a typo'd pattern, a root that resolves nowhere, a
 * `readdirSync` over an empty directory all report "0 violations" forever.
 *
 * Exported, the same implementation runs against the real `src/` tree AND against
 * fixtures written to a scratch directory, so both directions are proven. Narrow
 * a pattern and the red cases go red.
 *
 * ## What it is looking for, and why these three tables
 *
 * `membership_work_profiles` and `qualification_holdings` are effective-dated:
 * more than one row per subject is the designed steady state, so any query
 * against them has to answer "which one, at which instant" — and that answer
 * belongs in exactly one place. `membership_weekday_fte` is included because its
 * rows belong to a profile VERSION: reading them without going through the
 * version that owns them is the same defect wearing different columns.
 *
 * `qualifications` is deliberately NOT here. It is not effective-dated; it is a
 * vocabulary with a status, and reading it needs no instant.
 */

export const EFFECTIVE_DATED_TABLES = [
  'membership_work_profiles',
  'membership_weekday_fte',
  'qualification_holdings',
] as const;

/** The one module permitted to name them, relative to the scanned root. */
export const SELECTOR_MODULE = 'profiles/in-force-loader.ts';

export interface SelectorFinding {
  /** Path relative to the scanned root, forward slashes. */
  readonly file: string;
  /** Which effective-dated tables it names. Never empty. */
  readonly tables: readonly string[];
}

export interface ScanOptions {
  /** Override the table list. The red case uses it to prove the list is load-bearing. */
  readonly tables?: readonly string[];
  /** Include the loader itself in the results — the non-vacuity check. */
  readonly includeSelectorModule?: boolean;
  /** Override the allowlist. The red cases use it to prove it is load-bearing. */
  readonly allowedNamers?: readonly { readonly file: string; readonly reason: string }[];
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * Strips comments before scanning.
 *
 * A rule that fires on the sentence explaining the rule is a rule people delete
 * rather than obey. Block comments are blanked (newlines preserved so nothing
 * shifts); line comments are dropped.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * The modules permitted to NAME an effective-dated table at all, and why.
 *
 * ## Why an allowlist and not a cleverer pattern
 *
 * A pattern-only scan can be walked around, and an independent review walked
 * around the first one three times: `db.selectFrom(PROFILES)` where `PROFILES` is
 * a `const`, ``sql`select … from "membership_work_profiles"` `` with a quoted
 * identifier, and a `.returning()` that reads the window columns straight off a
 * write. The first two are invisible to any regex that looks for the table name
 * next to `selectFrom`; the third is not a read at all by shape, and is a read in
 * every sense that matters.
 *
 * So the rule has two halves, and the allowlist is the half that cannot be
 * evaded. **Naming one of these tables in code at all is a finding unless the
 * module is listed here** — which makes a `const` indirection, a quoted
 * identifier and a spelling nobody has thought of yet all equally caught, because
 * every one of them has to write the table's name down somewhere.
 *
 * The list is short on purpose. Adding to it is a decision a reviewer sees.
 */
export interface AllowedNamer {
  readonly file: string;
  readonly reason: string;
}

export const ALLOWED_NAMERS: readonly AllowedNamer[] = [
  {
    file: 'db/schema.ts',
    reason:
      'Declares the Kysely row types and the TENANT_TABLES registry. It must name every tenant '
      + 'table or they drop out of every generic isolation probe — which is the omission '
      + 'OPUS-M1-004 had to fix for migration 0003.',
  },
  {
    file: 'profiles/work-profiles.ts',
    reason:
      'The writer. It inserts profile versions and closes windows; writes are governed by the '
      + 'EXCLUDE constraint and the guard triggers, not by window selection. It reads ONLY '
      + 'through the loader.',
  },
  {
    file: 'profiles/qualifications.ts',
    reason: 'The writer for holdings, on the same terms.',
  },
];

/**
 * Columns whose value only means something relative to an instant.
 *
 * A `.returning()` that names one of these is reading effective-dated state off
 * the back of a write, which is a read the loader never saw — the reviewer's
 * third evasion. Reading back an `id` is fine and is what the writers do.
 */
const EFFECTIVE_DATED_COLUMNS = [
  'effective_from',
  'effective_to',
  'valid_from',
  'valid_until',
] as const;

/**
 * The READ shapes, including the two spellings the first version missed.
 *
 *   `.selectFrom('membership_work_profiles')`          Kysely, literal
 *   `.innerJoin('membership_weekday_fte', …)`          Kysely join — the shape reviewers miss
 *   ``sql`select … from qualification_holdings` ``     raw SQL
 *   ``sql`select … from "qualification_holdings"` ``   raw SQL, QUOTED identifier
 */
function readPatterns(table: string): readonly RegExp[] {
  return [
    new RegExp(String.raw`\.selectFrom\(\s*['"\`]${table}['"\`]`),
    new RegExp(String.raw`\.(?:inner|left|right|full)Join\(\s*['"\`]${table}['"\`]`, 'i'),
    // `"?` on both sides: a quoted identifier is the same read wearing quotes.
    new RegExp(String.raw`\bfrom\s+"?${table}"?\b`, 'i'),
  ];
}

/** Any mention of the table's name, however it is reached. */
function namePattern(table: string): RegExp {
  return new RegExp(String.raw`\b${table}\b`);
}

/** A `.returning(...)` call whose argument list names an effective-dated column. */
function returningReadsWindowColumns(code: string): boolean {
  // The call's argument text, up to the closing paren of a single-line
  // `.returning([...])` — which is how every call in this codebase is written.
  for (const match of code.matchAll(/\.returning\(([^)]*)\)/g)) {
    const args = match[1] ?? '';
    if (EFFECTIVE_DATED_COLUMNS.some((column) => new RegExp(String.raw`\b${column}\b`).test(args))) {
      return true;
    }
  }
  return false;
}

/**
 * Every module under `root` that reaches an effective-dated table outside the
 * loader.
 *
 * Three rule families, each catching what the others cannot:
 *
 *  1. **read forms** — `selectFrom`, joins, raw `FROM`, quoted or not;
 *  2. **naming at all** — anywhere outside `ALLOWED_NAMERS`, which is what makes
 *     a `const` indirection or any unanticipated spelling a finding;
 *  3. **`.returning()` of a window column** — a read off the back of a write,
 *     which is legitimate-looking inside an allowlisted writer and is still a
 *     second view of effective-dated state.
 */
export function effectiveDatedSelectors(root: string, options: ScanOptions = {}): SelectorFinding[] {
  const tables = options.tables ?? EFFECTIVE_DATED_TABLES;
  const allowed = new Set((options.allowedNamers ?? ALLOWED_NAMERS).map((entry) => entry.file));
  const findings: SelectorFinding[] = [];

  for (const absolute of walk(root)) {
    if (!absolute.endsWith('.ts')) continue;
    const file = relative(root, absolute).replaceAll('\\', '/');
    if (file === SELECTOR_MODULE && options.includeSelectorModule !== true) continue;

    const code = codeOnly(readFileSync(absolute, 'utf8'));
    const isAllowedNamer = allowed.has(file);

    const named = tables.filter((table) => {
      // (1) a read form, wherever it appears — an allowlisted writer may NOT read.
      if (readPatterns(table).some((pattern) => pattern.test(code))) return true;
      // (2) naming it at all, unless the module is allowlisted.
      if (!isAllowedNamer && namePattern(table).test(code)) return true;
      // (3) reading window columns off a write, even inside an allowlisted writer.
      if (namePattern(table).test(code) && returningReadsWindowColumns(code)) return true;
      return false;
    });
    if (named.length > 0) findings.push({ file, tables: named });
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file));
}
