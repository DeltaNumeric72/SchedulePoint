/**
 * **Migration anchors must point at the LIVE definition** (R-8).
 *
 * A red-case arm that patches a migration is patching SQL that `globalSetup`
 * replays before every run, which is what makes those arms honest without a
 * rebuild (FAD-33(1)). It also makes them quietly fragile in one specific way,
 * measured rather than imagined:
 *
 *   `CREATE OR REPLACE FUNCTION` replaces a function body WHOLE. When a later
 *   migration replaces a function an earlier migration defined, it restates the
 *   whole body — every rule inside it — and the earlier copy becomes dead text.
 *   An arm still anchored in the earlier file then patches a string that is
 *   still THERE, so nothing errors, and the violation never reaches the
 *   database. The arm reports GREEN pass / RED pass: decorative.
 *
 * That is not hypothetical. R-5's migration 0020 replaced
 * `app_guard_build_run_transition`, first defined in 0018, and the
 * `builds-validation-gate` arm — the arm guarding "no hard-violating candidate
 * reaches approved" — went decorative for two commits without a single red
 * signal anywhere in CI. The three sibling 0018 arms survived only because they
 * happen to anchor in OTHER functions.
 *
 * The repository already had the right habit — `work-profile-delete-capability`
 * anchors in 0013 for functions first written in 0004 and replaced in 0012, and
 * `requires-expiry-flip-serialization` anchors in 0017 for functions first
 * written in 0012 — but the habit was unenforced, and an unenforced habit fails
 * in the direction that passes.
 *
 * So it is enforced here, as a PREFLIGHT: the runner refuses to run at all when
 * an arm anchors inside a function some later migration redefines, unless the
 * arm also patches that later migration. Refusing to run is the correct posture
 * for this class — the same posture as a shard spelling that selects nothing —
 * because the alternative is a battery that reports success while proving less
 * than it claims, which is the one failure mode the runner exists to prevent.
 *
 * The logic lives in its own module, importable and side-effect free, so that
 * `migration-anchor/check.mjs` can assert BOTH directions against fixtures. A
 * checker that only ever saw well-formed input would pass with a body of
 * `return []`, and would be exactly as useless as the decoration it exists to
 * catch — so a red-case arm neuters this module and that checker must go red.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where a migration-patching arm's `file` must start for this check to apply. */
export const MIGRATION_PREFIX = 'apps/api/migrations/';

/**
 * @typedef {{ name: string, start: number, end: number }} FunctionRange
 * @typedef {{ id: string, patch?: { file: string, find: string, replace: string }[] }} ArmLike
 * @typedef {{ armId: string, fn: string, patched: string, superseding: string }} Supersession
 */

/**
 * Every `CREATE [OR REPLACE] FUNCTION` in one migration, with the span of its
 * body.
 *
 * The span ends at the body's closing dollar-quote rather than at the next
 * `CREATE FUNCTION`, so a trigger or a grant written after a function is NOT
 * counted as part of it.
 *
 * ## The tag is READ, not assumed (R-8 F1)
 *
 * The first spelling of this assumed every body was `AS $$ ... $$;` and closed
 * on the next `$$`. That was wrong twice over. `0019_build_concurrency_capacity`
 * already uses `AS $sp_build_capacity$ ... $sp_build_capacity$;` — safe only by
 * the accident that 0019 contains no `$$` anywhere — and, worse, a TAGGED body
 * that legitimately contains `$$` (a nested `EXECUTE $$...$$`) would have closed
 * the span at that inner quote. The span would then be NARROWER than the
 * function, an anchor past it would read as "outside a body", and a real
 * supersession would return nothing at all: the exact silent pass this module
 * exists to prevent, reintroduced by its own parser.
 *
 * So the opening delimiter is matched as `$tag$` (empty tag included, which is
 * plain `$$`) and the body closes on THE SAME tag. `$$` and `$sp_build_capacity$`
 * are handled by one rule, and a nested quote of a different tag cannot end the
 * span.
 *
 * The stated property is therefore: **a span is exact, or — when no dollar quote
 * follows the head at all — it falls back to "up to the next function, or end of
 * file", which is WIDER. Never narrower.** Wider fails safe: it can only
 * over-report a supersession, and an over-report is a loud refusal a human reads
 * rather than a silent pass.
 *
 * NOT handled, and out of this repository's migration style: a schema-qualified
 * or double-quoted function head (`CREATE FUNCTION app.f()`, `CREATE FUNCTION
 * "F"()`). Such a head is not matched, so its function is invisible to this
 * check — it is neither flagged nor exempted. That is recorded honestly rather
 * than papered over; every one of the repository's function heads today is a
 * bare unquoted identifier, and the sweep in the R-8 record counts them.
 *
 * @param {string} sql
 * @returns {FunctionRange[]}
 */
export function functionRanges(sql) {
  /** @type {{ name: string, at: number }[]} */
  const heads = [];
  const head = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (let m = head.exec(sql); m !== null; m = head.exec(sql)) {
    heads.push({ name: (m[1] ?? '').toLowerCase(), at: m.index });
  }

  return heads.map((entry, index) => {
    const nextHead = index + 1 < heads.length ? (heads[index + 1]?.at ?? sql.length) : sql.length;

    /* The opening dollar quote, tag and all. `$1` and other positional
     * parameters cannot match: a tag is empty or starts with a letter or
     * underscore, and must be closed by a second `$`. */
    const opener = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/g;
    opener.lastIndex = entry.at;
    const open = opener.exec(sql);
    if (open === null) return { name: entry.name, start: entry.at, end: nextHead };

    const tag = open[0];
    const bodyClose = sql.indexOf(tag, open.index + tag.length);
    const end = bodyClose >= 0 ? bodyClose + tag.length : nextHead;
    return { name: entry.name, start: entry.at, end };
  });
}

/**
 * Read a migration set as `basename -> SQL`, in applied order.
 *
 * @param {string} migrationsDir
 * @returns {Map<string, string>}
 */
export function readMigrationSet(migrationsDir) {
  const names = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return new Map(names.map((name) => [name, readFileSync(join(migrationsDir, name), 'utf8')]));
}

/**
 * The last migration that DEFINES each function, by applied order.
 *
 * @param {Map<string, string>} migrations
 * @returns {Map<string, string>}
 */
function lastDefinerByFunction(migrations) {
  /** @type {Map<string, string>} */
  const last = new Map();
  for (const [name, sql] of migrations) {
    for (const range of functionRanges(sql)) last.set(range.name, name);
  }
  return last;
}

/**
 * Arms whose migration anchor lands in a function a LATER migration redefines,
 * where the arm does not also patch that later migration.
 *
 * An arm is exempted only if one of its OTHER patch rows anchors inside THE SAME
 * FUNCTION in the superseding file (R-8 F2). "Patches that file somewhere" is not
 * enough, and the difference is not academic: an arm could neuter 0018's copy of
 * a guard and, for an unrelated reason, also patch a comment line in 0020 — the
 * loose rule would read that as "the arm covers the live definition" and wave
 * through a violation that never reaches the database. The tight rule asks the
 * question that actually matters: is the LIVE body of this function neutered?
 *
 * Anchors that cannot be located, and anchors that fall outside every function
 * body (a table, a policy, a grant), are not this check's business and are
 * passed over: the runner's own per-arm anchor check already refuses a `find`
 * that is not present in the file it names.
 *
 * @param {ArmLike[]} cases
 * @param {Map<string, string>} migrations
 * @returns {Supersession[]}
 */
export function findSupersededAnchors(cases, migrations) {
  const lastDefiner = lastDefinerByFunction(migrations);
  /** @type {Supersession[]} */
  const problems = [];

  /**
   * Does this arm neuter `fn`'s body inside `file`?
   *
   * @param {ArmLike} arm
   * @param {string} file
   * @param {string} fn
   * @returns {boolean}
   */
  const neutersFunctionIn = (arm, file, fn) =>
    (arm.patch ?? []).some((patch) => {
      if (patch.file !== `${MIGRATION_PREFIX}${file}`) return false;
      const sql = migrations.get(file);
      if (sql === undefined) return false;
      const at = sql.indexOf(patch.find);
      if (at < 0) return false;
      return functionRanges(sql).some(
        (range) => range.name === fn && at >= range.start && at < range.end,
      );
    });

  for (const arm of cases) {
    const patches = (arm.patch ?? []).filter((patch) => patch.file.startsWith(MIGRATION_PREFIX));

    for (const patch of patches) {
      const basename = patch.file.slice(MIGRATION_PREFIX.length);
      const sql = migrations.get(basename);
      if (sql === undefined) continue;

      const at = sql.indexOf(patch.find);
      if (at < 0) continue;

      const range = functionRanges(sql).find((fn) => at >= fn.start && at < fn.end);
      if (range === undefined) continue;

      const superseding = lastDefiner.get(range.name);
      if (superseding === undefined || superseding === basename) continue;
      if (neutersFunctionIn(arm, superseding, range.name)) continue;

      const already = problems.some(
        (problem) =>
          problem.armId === arm.id && problem.fn === range.name && problem.patched === basename,
      );
      if (!already) {
        problems.push({
          armId: arm.id,
          fn: range.name,
          patched: basename,
          superseding,
        });
      }
    }
  }

  return problems;
}

/**
 * The refusal text, kept here so the runner and the control script assert the
 * same words.
 *
 * @param {Supersession[]} problems
 * @returns {string}
 */
export function describeSupersessions(problems) {
  const lines = [
    `RED-CASE RUNNER: ${String(problems.length)} arm(s) anchor a violation in a SUPERSEDED migration.`,
    '',
    'A later migration replaces the function body whole, so the patched text is',
    'dead by the time the assertions run: the arm would report PROVEN having',
    'never put its violation in front of the gate. Re-anchor onto the live',
    'definition (or patch both), exactly as R-8 did for builds-validation-gate.',
    '',
  ];
  for (const problem of problems) {
    lines.push(
      `  arm "${problem.armId}": anchor is inside ${problem.fn}() in ${problem.patched}, ` +
        `but ${problem.superseding} redefines it and the arm does not patch that file.`,
    );
  }
  return `${lines.join('\n')}\n`;
}
