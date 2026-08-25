#!/usr/bin/env node
/**
 * **The migration-anchor preflight's own control** (R-8).
 *
 * `assertMigrationAnchorsAreLive()` in `run.mjs` refuses the whole battery when
 * an arm's violation is anchored in a function body a later migration replaces.
 * On a well-formed registry that check is silent forever, which is precisely the
 * shape of a control that can rot without anybody noticing: a body of
 * `return []` would pass every real run, and the decorative arm it exists to
 * catch would sail through exactly as `builds-validation-gate` did for two
 * commits.
 *
 * So both directions are asserted, against fixtures rather than against the
 * live registry — the live registry is (correctly) clean, and a control whose
 * positive case never fires proves only that nothing threw. The fixtures are
 * three miniature migration sets under `fixture/`: `superseded` (a function
 * redefined a file later), `single` (one that is not), and `tagged` (the two
 * dollar-quote spellings the first parser mis-read, R-8 F1).
 *
 * The MUST-NOT-FLAG cases are as load-bearing as the MUST-FLAG ones. A check that
 * flagged everything would refuse every run and would be "safe" in the useless
 * sense; the six negative cases pin the exact permissions the design grants —
 * patch the live file, patch both files, patch a file nothing supersedes, anchor
 * outside any function body, and the same two through a tagged body.
 *
 * Beyond the flag/no-flag pairs, the SPAN itself is asserted: `functionRanges`
 * must end each tagged body exactly at its own closing quote. That is the R-8 F1
 * property — wider-or-exact, never narrower — and a narrower span is the one
 * error mode that turns this whole module back into a silent pass.
 *
 * Follows `runner-signature/check.mjs`, which is the same idea one layer down:
 * the runner's own machinery gets a falsifiable control of its own, and a
 * red-case arm proves that control bites.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIGRATION_PREFIX,
  describeSupersessions,
  findSupersededAnchors,
  functionRanges,
  readMigrationSet,
} from '../migration-anchor-supersession.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPERSEDED = readMigrationSet(resolve(HERE, 'fixture/superseded'));
const SINGLE = readMigrationSet(resolve(HERE, 'fixture/single'));
const TAGGED = readMigrationSet(resolve(HERE, 'fixture/tagged'));

/** The rule that is restated in both fixture files — the anchor under test. */
const ANCHOR = '    IF v_blocking > 0 THEN';
/** A line that sits outside every function body: the trigger, written after it. */
const OUTSIDE_ANCHOR = 'CREATE TRIGGER app_fixture_demo_guard';
/** A row on the SUPERSEDING file that neuters nothing — the F2 exemption probe. */
const UNRELATED_ANCHOR = '-- Down Migration';

/** @param {string} name */
const migrationFile = (name) => `${MIGRATION_PREFIX}${name}`;

/**
 * @param {string} id
 * @param {string[]} files
 * @param {string} [find]
 */
const arm = (id, files, find = ANCHOR) => ({
  id,
  patch: files.map((file) => ({
    file: migrationFile(file),
    find,
    replace: '    IF false THEN -- fixture',
  })),
});

const MUST_FLAG = [
  {
    why: 'anchored in the superseded body, and the superseding file is not patched',
    cases: [arm('fixture-anchored-in-superseded', ['0001_demo_guard.sql'])],
    migrations: SUPERSEDED,
  },
  {
    /* R-8 F1. The anchor sits BELOW a nested `$$` inside a `$fn$`-quoted body.
     * The first parser closed the span on that nested quote, so the anchor read
     * as "outside a body" and this supersession returned nothing at all. */
    why: 'anchored below a nested `$$` inside a TAGGED body that a later file redefines',
    cases: [arm('fixture-tagged-body-nested-quote', ['0001_tagged_demo.sql'])],
    migrations: TAGGED,
  },
  {
    /* R-8 F2. The arm neuters 0001's guard and also patches the superseding
     * file — but on a comment line, neutering nothing. The loose rule ("patches
     * that file at all") waved this through; the tight rule asks whether the
     * LIVE body of THIS function is neutered, and it is not. */
    why: 'patches the superseding file on a row that neuters a DIFFERENT part of it',
    cases: [
      {
        id: 'fixture-exempting-row-is-unrelated',
        patch: [
          {
            file: migrationFile('0001_demo_guard.sql'),
            find: ANCHOR,
            replace: '    IF false THEN -- fixture',
          },
          {
            file: migrationFile('0002_demo_guard_replaced.sql'),
            find: UNRELATED_ANCHOR,
            replace: '-- Down Migration (fixture edit)',
          },
        ],
      },
    ],
    migrations: SUPERSEDED,
  },
];

const MUST_NOT_FLAG = [
  {
    why: 'anchored in the LIVE definition (the R-8 re-founding)',
    cases: [arm('fixture-anchored-live', ['0002_demo_guard_replaced.sql'])],
    migrations: SUPERSEDED,
  },
  {
    why: 'patches BOTH the superseded and the superseding file',
    cases: [arm('fixture-anchored-both', ['0001_demo_guard.sql', '0002_demo_guard_replaced.sql'])],
    migrations: SUPERSEDED,
  },
  {
    why: 'nothing supersedes the file it patches',
    cases: [arm('fixture-only-definition', ['0001_demo_guard.sql'])],
    migrations: SINGLE,
  },
  {
    why: 'the anchor is outside every function body (a trigger, not a rule)',
    cases: [arm('fixture-outside-a-body', ['0001_demo_guard.sql'], OUTSIDE_ANCHOR)],
    migrations: SUPERSEDED,
  },
  {
    why: 'anchored in the LIVE definition of a TAGGED body (R-8 F1)',
    cases: [arm('fixture-tagged-anchored-live', ['0002_tagged_demo_replaced.sql'])],
    migrations: TAGGED,
  },
  {
    why: 'a `$sp_..$`-tagged function nothing supersedes (the 0019 shape)',
    cases: [
      {
        id: 'fixture-tagged-capacity',
        patch: [
          {
            file: migrationFile('0001_tagged_demo.sql'),
            find: '    RETURN 1;',
            replace: '    RETURN 2;',
          },
        ],
      },
    ],
    migrations: TAGGED,
  },
];

/** @type {string[]} */
const problems = [];

/* The fixtures must actually BE what the cases assume. A fixture that quietly
 * stopped containing the anchor would make every negative case vacuous and the
 * positive case fail for the wrong reason, so it is asserted rather than
 * trusted. */
for (const [label, set, expectedFiles] of [
  ['superseded', SUPERSEDED, 2],
  ['single', SINGLE, 1],
  ['tagged', TAGGED, 2],
]) {
  const migrations = /** @type {Map<string, string>} */ (set);
  if (migrations.size !== expectedFiles) {
    problems.push(
      `fixture "${String(label)}": expected ${String(expectedFiles)} file(s), read ${String(migrations.size)}`,
    );
  }
  for (const [name, sql] of migrations) {
    const at = sql.indexOf(ANCHOR);
    if (at < 0) {
      problems.push(`fixture "${String(label)}/${name}": no longer contains the anchor under test`);
      continue;
    }
    if (functionRanges(sql).find((fn) => at >= fn.start && at < fn.end) === undefined) {
      problems.push(
        `fixture "${String(label)}/${name}": the anchor is not inside any parsed function body`,
      );
    }
  }
}

/* The body span must END at the function's closing delimiter. If it ran on to
 * the next function (or to end of file) the trigger below the body would read as
 * part of it, the "outside a body" permission would silently disappear, and the
 * check would start refusing runs it has no business refusing. */
const outsideSql = SUPERSEDED.get('0001_demo_guard.sql') ?? '';
const outsideAt = outsideSql.indexOf(OUTSIDE_ANCHOR);
if (outsideAt < 0) {
  problems.push('fixture "superseded/0001_demo_guard.sql": the outside-a-body anchor is gone');
} else if (functionRanges(outsideSql).some((fn) => outsideAt >= fn.start && outsideAt < fn.end)) {
  problems.push('the function body span swallowed a CREATE TRIGGER written after it');
}

/* R-8 F1, the property itself: every span in the tagged fixture must end EXACTLY
 * at its own closing dollar quote — not at a nested quote of another tag, and not
 * at the next head. Asserted against independently computed offsets rather than
 * against the parser's own idea of where the body ended. */
const taggedSql = TAGGED.get('0001_tagged_demo.sql') ?? '';
for (const [fnName, tag] of [
  ['app_fixture_tagged_demo', '$fn$'],
  ['app_fixture_capacity_demo', '$sp_fixture_capacity$'],
]) {
  const head = taggedSql.indexOf(`FUNCTION ${String(fnName)}`);
  const open = taggedSql.indexOf(String(tag), head);
  const close = open < 0 ? -1 : taggedSql.indexOf(String(tag), open + String(tag).length);
  const range = functionRanges(taggedSql).find((fn) => fn.name === fnName);
  if (head < 0 || close < 0) {
    problems.push(
      `fixture "tagged/0001_tagged_demo.sql": ${String(fnName)} ${String(tag)} shape is gone`,
    );
    continue;
  }
  if (range === undefined) {
    problems.push(`${String(fnName)} was not parsed as a function at all`);
    continue;
  }
  const expectedEnd = close + String(tag).length;
  if (range.end !== expectedEnd) {
    problems.push(
      `${String(fnName)}: span ends at ${String(range.end)}, its ${String(tag)} body ends at ` +
        `${String(expectedEnd)} — ${range.end < expectedEnd ? 'NARROWER than the truth' : 'not exact'}`,
    );
  }
}

for (const expectation of MUST_FLAG) {
  const found = findSupersededAnchors(expectation.cases, expectation.migrations);
  if (found.length === 0) {
    problems.push(`NOT flagged, and it must be — ${expectation.why}`);
    continue;
  }
  /* The refusal has to name the arm, the function, the file that was patched and
   * the file that supersedes it. Derived from what was actually found rather
   * than from a hand-written list, so a new MUST_FLAG case cannot forget it. */
  const text = describeSupersessions(found);
  for (const problem of found) {
    for (const needle of [problem.armId, problem.fn, problem.patched, problem.superseding]) {
      if (!text.includes(needle)) {
        problems.push(`the refusal text omits "${needle}" — a reader could not act on it`);
      }
    }
  }
}

for (const expectation of MUST_NOT_FLAG) {
  const found = findSupersededAnchors(expectation.cases, expectation.migrations);
  if (found.length > 0) {
    problems.push(
      `flagged and it must NOT be — ${expectation.why}: ` +
        found.map((problem) => `${problem.armId}/${problem.fn}`).join(', '),
    );
  }
}

if (problems.length > 0) {
  process.stdout.write(
    `FAIL  red-case migration-anchor supersession — ${String(problems.length)} problem(s)\n`,
  );
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  process.exit(1);
}

process.stdout.write(
  `PASS  red-case migration-anchor supersession — ${String(MUST_FLAG.length)} refused, ` +
    `${String(MUST_NOT_FLAG.length)} correctly left alone\n`,
);
