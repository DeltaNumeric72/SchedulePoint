import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { log } from '../support/harness.js';
import { effectiveDatedSelectors, EFFECTIVE_DATED_TABLES, SELECTOR_MODULE } from '../support/effective-dated-scan.js';

/**
 * **There is exactly ONE module that selects from an effective-dated table.**
 *
 * ## Why a structural test and not a code review note
 *
 * S-01 was two selection rules that disagreed. Each was written in good faith at
 * its own call site; neither author knew the other existed. A code-review rule
 * ("please use the loader") catches that only when the reviewer happens to think
 * of it, and the second query is always the one nobody thought about.
 *
 * So the rule is mechanical: any module under `src/` other than
 * `profiles/in-force-loader.ts` that names `membership_work_profiles`,
 * `membership_weekday_fte` or `qualification_holdings` in a query fails this
 * test. Adding a second selector is a build failure rather than a review comment.
 *
 * ## Why the scanner is exported and red-cased
 *
 * `tenant-access-scan.ts` and `audit-emission-scan.ts` learned this the hard way,
 * and R-02 against OPUS-M1-003 is the precedent: **a scanner that has only ever
 * been observed passing is not evidence of anything.** A regex with a typo, a root
 * that resolves to the wrong directory, a `readdirSync` over an empty folder —
 * every one of them reports "0 violations" forever, and the first anyone hears of
 * it is a second loader in production.
 *
 * The implementation therefore lives in `test/support/effective-dated-scan.ts`,
 * is exported, and is run below against fixtures written to a scratch directory.
 * Narrow the pattern and the red cases go red.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

describe('the shipped source has exactly one selector', () => {
  it('names the effective-dated tables it protects', () => {
    // The floor. A scan whose table list had been emptied would report zero
    // violations against any source tree at all.
    expect([...EFFECTIVE_DATED_TABLES].sort()).toEqual([
      'membership_weekday_fte',
      'membership_work_profiles',
      'qualification_holdings',
    ]);
    expect(SELECTOR_MODULE).toBe('profiles/in-force-loader.ts');
  });

  it('the loader itself IS found by the scan — otherwise the scan sees nothing', () => {
    // Non-vacuity, and the specific failure it guards against: a scanner pointed
    // at the wrong root reports "no other module selects these tables" while also
    // being unable to find the one that does.
    const found = effectiveDatedSelectors(SRC, { includeSelectorModule: true });
    expect(
      found.map((entry) => entry.file),
      'the scan cannot even see the loader — it is looking at the wrong tree',
    ).toContain(SELECTOR_MODULE);
  });

  it('no OTHER module under src/ selects from an effective-dated table', () => {
    const offenders = effectiveDatedSelectors(SRC);
    expect(
      offenders.map((entry) => `${entry.file} -> ${entry.tables.join(', ')}`),
      'a second selector exists; the S-01 defect class is reachable again',
    ).toEqual([]);
    log(
      `${String(EFFECTIVE_DATED_TABLES.length)} effective-dated table(s), exactly 1 module ` +
        `selecting from them: ${SELECTOR_MODULE}`,
    );
  });
});

describe('RED — the scan catches a second selector', () => {
  function withScratch<T>(files: Record<string, string>, body: (root: string) => T): T {
    const root = mkdtempSync(join(tmpdir(), 'sp-selector-scan-'));
    try {
      for (const [relative, contents] of Object.entries(files)) {
        const path = join(root, relative);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents, 'utf8');
      }
      return body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('GREEN control — a tree with only the loader has no offenders', () => {
    withScratch(
      {
        'profiles/in-force-loader.ts':
          "export const q = (db) => db.selectFrom('membership_work_profiles').selectAll();\n",
        'http/routes/unrelated.route.ts':
          "export const q = (db) => db.selectFrom('memberships').selectAll();\n",
      },
      (root) => {
        expect(effectiveDatedSelectors(root)).toEqual([]);
      },
    );
  });

  it('catches a Kysely `selectFrom` in another module', () => {
    withScratch(
      {
        'profiles/in-force-loader.ts': 'export const loader = 1;\n',
        'scheduling/engine-inputs.ts':
          "export const q = (db) => db.selectFrom('membership_work_profiles').orderBy('effective_from', 'desc').limit(1);\n",
      },
      (root) => {
        const offenders = effectiveDatedSelectors(root);
        expect(offenders.map((entry) => entry.file)).toEqual(['scheduling/engine-inputs.ts']);
        expect(offenders[0]?.tables).toEqual(['membership_work_profiles']);
      },
    );
  });

  it('catches raw SQL naming the table', () => {
    withScratch(
      {
        'profiles/in-force-loader.ts': 'export const loader = 1;\n',
        'reports/credentials.ts':
          'export const q = sql`select * from qualification_holdings where membership_id = ${id}`;\n',
      },
      (root) => {
        expect(effectiveDatedSelectors(root).map((entry) => entry.file)).toEqual([
          'reports/credentials.ts',
        ]);
      },
    );
  });

  it('catches a JOIN, which is the shape a reviewer misses', () => {
    withScratch(
      {
        'profiles/in-force-loader.ts': 'export const loader = 1;\n',
        'reports/roster.ts':
          "export const q = (db) => db.selectFrom('memberships').innerJoin('membership_weekday_fte', 'x', 'y');\n",
      },
      (root) => {
        expect(effectiveDatedSelectors(root).map((entry) => entry.file)).toEqual([
          'reports/roster.ts',
        ]);
      },
    );
  });

  it('does NOT fire on a comment or on a differently-named table', () => {
    // The other direction. A scan that matched comments would make the rule
    // unfollowable and would eventually be deleted rather than obeyed.
    withScratch(
      {
        'profiles/in-force-loader.ts': 'export const loader = 1;\n',
        'docs-in-code/notes.ts':
          '// membership_work_profiles is read only through the loader.\n' +
          "export const q = (db) => db.selectFrom('memberships_work').selectAll();\n",
      },
      (root) => {
        expect(effectiveDatedSelectors(root)).toEqual([]);
      },
    );
  });

  const ALLOW = [
    { file: 'profiles/writer.ts', reason: 'the fixture writer' },
    { file: 'db/schema.ts', reason: 'the fixture registry' },
  ];

  it('does NOT fire on a WRITE, or on the schema declaration', () => {
    // The narrowing that the first version of this scan lacked. Writers must name
    // these tables — that is what writing to them is — and the registry in
    // `db/schema.ts` must name them or they drop out of every generic probe. A
    // rule that flagged both would be deleted rather than followed, and deleting
    // it would take the real check with it. They are ALLOWLISTED, by name and with
    // a reason, rather than pattern-excused.
    withScratch(
      {
        'profiles/in-force-loader.ts': 'export const loader = 1;\n',
        'profiles/writer.ts':
          "export const w = (db) => db.insertInto('membership_work_profiles').values({});\n" +
          "export const u = (db) => db.updateTable('qualification_holdings').set({}).returning(['id']);\n",
        'db/schema.ts':
          "export const TENANT_TABLES = [{ name: 'membership_weekday_fte' }];\n" +
          'export interface MembershipWorkProfilesTable { id: string }\n',
      },
      (root) => {
        expect(
          effectiveDatedSelectors(root, { allowedNamers: ALLOW }),
          'the scan flagged a write or a type declaration',
        ).toEqual([]);
      },
    );
  });

  /* ────────────────────────────────────────────────────────────────────────
   * The reviewer's three evasions
   *
   * Each of these walked past the first version of the scan. They are the reason
   * the rule now has an ALLOWLIST half as well as a pattern half: every one of
   * them has to write the table's name down somewhere, so "naming it at all,
   * outside a listed module" catches the ones no pattern anticipated.
   * ──────────────────────────────────────────────────────────────────────── */

  it('EVASION 1 — `selectFrom` reached through a `const` identifier', () => {
    withScratch(
      {
        'profiles/in-force-loader.ts': 'export const loader = 1;\n',
        'scheduling/engine-inputs.ts':
          "const PROFILES = 'membership_work_profiles';\n" +
          'export const q = (db) => db.selectFrom(PROFILES).selectAll();\n',
      },
      (root) => {
        expect(
          effectiveDatedSelectors(root, { allowedNamers: ALLOW }).map((entry) => entry.file),
          'a const indirection walked past the scan',
        ).toEqual(['scheduling/engine-inputs.ts']);
      },
    );
  });

  it('EVASION 2 — raw SQL with a QUOTED identifier', () => {
    withScratch(
      {
        'profiles/in-force-loader.ts': 'export const loader = 1;\n',
        'reports/credentials.ts':
          'export const q = sql`select * from "qualification_holdings" where id = ${id}`;\n',
      },
      (root) => {
        const found = effectiveDatedSelectors(root, { allowedNamers: ALLOW });
        expect(found.map((entry) => entry.file)).toEqual(['reports/credentials.ts']);
        expect(found[0]?.tables).toEqual(['qualification_holdings']);
      },
    );
  });

  it('EVASION 3 — `returning()` reads window columns off a write, INSIDE an allowlisted writer', () => {
    // The sharpest of the three. This module is allowlisted — it is allowed to
    // name the table and to write to it — and it is still a finding, because
    // reading `effective_from`/`effective_to` back off an UPDATE is a second view
    // of effective-dated state that the loader never saw.
    withScratch(
      {
        'profiles/in-force-loader.ts': 'export const loader = 1;\n',
        'profiles/writer.ts':
          "export const u = (db) => db.updateTable('membership_work_profiles').set({})" +
          ".returning(['id', 'effective_from', 'effective_to']);\n",
      },
      (root) => {
        expect(
          effectiveDatedSelectors(root, { allowedNamers: ALLOW }).map((entry) => entry.file),
          'a returning() of window columns was not caught inside an allowlisted writer',
        ).toEqual(['profiles/writer.ts']);
      },
    );
  });

  it('…and returning() of the id alone in the same writer is NOT a finding', () => {
    // The control on evasion 3. Without it the rule would read as "allowlisted
    // writers may not use returning()", which is not the rule and would be
    // followed by deleting the check.
    withScratch(
      {
        'profiles/in-force-loader.ts': 'export const loader = 1;\n',
        'profiles/writer.ts':
          "export const u = (db) => db.updateTable('membership_work_profiles').set({}).returning(['id']);\n",
      },
      (root) => {
        expect(effectiveDatedSelectors(root, { allowedNamers: ALLOW })).toEqual([]);
      },
    );
  });

  it('MUTATION — emptying the allowlist makes the shipped writers findings', () => {
    // Proof that the allowlist is what does the work in rule (2), rather than the
    // patterns quietly not matching the writers anyway.
    const withoutAllowlist = effectiveDatedSelectors(SRC, { allowedNamers: [] });
    expect(
      withoutAllowlist.map((entry) => entry.file).sort(),
      'emptying the allowlist changed nothing, so it is not the control it claims to be',
    ).toEqual(['db/schema.ts', 'profiles/qualifications.ts', 'profiles/work-profiles.ts']);
  });

  it('MUTATION — narrowing the table list makes the scan miss a real offender', () => {
    // The control on the control: proof that the table list is what does the
    // work, not an accident of the regex.
    withScratch(
      {
        'profiles/in-force-loader.ts': 'export const loader = 1;\n',
        'scheduling/engine-inputs.ts':
          "export const q = (db) => db.selectFrom('qualification_holdings').selectAll();\n",
      },
      (root) => {
        expect(effectiveDatedSelectors(root)).toHaveLength(1);
        expect(
          effectiveDatedSelectors(root, { tables: ['membership_work_profiles'] }),
          'the scan found an offender for a table it was not asked about',
        ).toEqual([]);
      },
    );
  });
});
