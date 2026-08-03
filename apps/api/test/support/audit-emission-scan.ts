import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The static half of FAD-13 item 2: **a module that mutates also records.**
 *
 * ## Why the scanner lives here rather than inside its test file
 *
 * It was inside its test file, and that is the defect this module fixes. The
 * check had a non-vacuity floor and a correct detector, but **nothing proved it
 * could fail** — and a scanner that has only ever been observed passing is not
 * evidence of anything. A regex with a typo, a root prefix that matches no
 * directory, a `readdirSync` over the wrong path: every one of them reports
 * "0 unaudited mutations" forever, and the first anyone hears of it is a
 * mutation that was never audited.
 *
 * This is exactly the shape of R-02 against OPUS-M1-003, and the fix is the one
 * that already lives in this repository: **one implementation, exported, with
 * the red case running it against fixtures on disk.** Narrow a pattern and the
 * red case goes red. See `tenant-access-scan.ts`, which does the same thing for
 * I-15.
 *
 * ## What "mutates" means, as data
 *
 * Six detectors, not one regex, and again for a red-case reason: a single
 * combined pattern can only be proved as a whole, so a broken alternative is
 * carried by its neighbours. Each detector below is fired on its own by its own
 * fixture.
 */

export interface WriteDetector {
  readonly id: string;
  readonly pattern: RegExp;
  readonly label: string;
}

export const WRITE_DETECTORS: readonly WriteDetector[] = [
  { id: 'kysely-insert', pattern: /\.insertInto\s*\(/, label: 'insertInto(' },
  { id: 'kysely-update', pattern: /\.updateTable\s*\(/, label: 'updateTable(' },
  { id: 'kysely-delete', pattern: /\.deleteFrom\s*\(/, label: 'deleteFrom(' },
  { id: 'sql-insert', pattern: /['"`][^'"`]*\binsert\s+into\b/i, label: 'raw `insert into`' },
  { id: 'sql-update', pattern: /['"`][^'"`]*\bupdate\s+/i, label: 'raw `update`' },
  { id: 'sql-delete', pattern: /['"`][^'"`]*\bdelete\s+from\b/i, label: 'raw `delete from`' },
];

/** The one-line integration point every mutation must carry. */
const RECORDS_AUDIT = /\brecordAuditEvent\s*\(/;

export interface MutatingModule {
  /** Path relative to the scanned root, forward slashes. */
  readonly file: string;
  /** Which write forms fired. Never empty. */
  readonly writes: readonly string[];
  readonly recordsAudit: boolean;
}

export interface EmissionScanOptions {
  /**
   * Only consider files under these path prefixes (relative to `root`).
   *
   * Omitted means every file. The production call passes the surfaces that
   * perform tenant mutations; the red cases pass nothing, because a scratch
   * directory has no such structure and requiring one would make the fixture
   * test the prefix rather than the detector.
   */
  readonly subdirectories?: readonly string[];
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Comments describe writes constantly; the scan is about code. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * Every module under `root` that performs a write, and whether it records.
 *
 * @param root absolute directory to walk.
 */
export function scanForMutations(
  root: string,
  options: EmissionScanOptions = {},
): MutatingModule[] {
  const modules: MutatingModule[] = [];

  for (const absolute of walk(root)) {
    if (!absolute.endsWith('.ts')) continue;
    const file = relative(root, absolute).replaceAll('\\', '/');
    if (
      options.subdirectories !== undefined &&
      !options.subdirectories.some((prefix) => file.startsWith(`${prefix}/`))
    ) {
      continue;
    }

    const code = codeOnly(readFileSync(absolute, 'utf8'));
    const writes = WRITE_DETECTORS.filter((d) => d.pattern.test(code)).map((d) => d.label);
    if (writes.length === 0) continue;
    modules.push({ file, writes, recordsAudit: RECORDS_AUDIT.test(code) });
  }

  return modules;
}

/** The findings: modules that write and record nothing. */
export function unauditedMutations(modules: readonly MutatingModule[]): MutatingModule[] {
  return modules.filter((module) => !module.recordsAudit);
}
