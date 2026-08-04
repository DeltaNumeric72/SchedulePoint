/**
 * The B-* benchmark-corpus generator (OPUS-M3-002, SPEC-04 §8).
 *
 * Produces **wholly synthetic, known-by-construction** scheduling-problem
 * fixtures that reference the typed rule model. Two classes are committed here:
 *
 *  - `B-feasible-*` — satisfiable **by a counting argument** recorded alongside
 *    the fixture. The argument shows a satisfying assignment must exist; it does
 *    **not** compute one. There is no packing, no search, no optimization in this
 *    file — building and solving the model is M4 and is prohibited here
 *    (non-bypass rule 7). `solver/corpus/` is fixtures only.
 *  - `B-infeasible-*` — one deliberately infeasible cause each (SPEC-04 §8:
 *    over-demand, missing qualification, fixed-assignment conflict, contradictory
 *    rules), with a **minimal infeasibility certificate**: the smallest subset of
 *    rules that is already unsatisfiable, and a one-line proof that it is minimal
 *    (removing any member restores feasibility). That is what makes the
 *    explanation oracle scorable — the expected cause is known by construction.
 *
 * ## Determinism (SPEC-04 §8, and the corpus-regeneration named proof)
 *
 * The generator takes no clock, no randomness, no environment. It emits each
 * fixture through `@schedulepoint/domain`'s `canonicalStringify`, so regeneration is
 * byte-identical. `--check` regenerates in memory and diffs against the committed
 * files, exiting non-zero on any drift (the tampering red case).
 *
 * ## Referencing the typed model
 *
 * Every rule a fixture carries is validated with the domain `ruleProblems` and
 * compiled with `compileRuleSet` before the fixture is written — a fixture that
 * did not conform to the closed AST could not be produced. Run `tsc -b
 * packages/domain` first so the imported dist exists.
 *
 *     node solver/corpus/build-corpus.mjs            # write fixtures + manifest
 *     node solver/corpus/build-corpus.mjs --check    # verify byte-identity, no writes
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RULE_SCHEMA_VERSION,
  canonicalStringify,
  compileRuleSet,
  ruleProblems,
} from '../../packages/domain/dist/src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');

// ─── Synthetic building blocks (no real names — clean-room rule) ──────────────

/** Synthetic member identities `m01`..`mNN`. */
function members(count) {
  return Array.from({ length: count }, (_, i) => `m${String(i + 1).padStart(2, '0')}`);
}

/** @param {string} classification @param {string} ruleKey @param {object} predicate @param {object} [extra] */
function hard(ruleKey, name, predicate, scope = {}) {
  return {
    ruleKey,
    name,
    ruleSchemaVersion: RULE_SCHEMA_VERSION,
    classification: 'HARD',
    scope,
    predicate,
  };
}
function soft(ruleKey, name, weight, predicate, scope = {}) {
  return {
    ruleKey,
    name,
    ruleSchemaVersion: RULE_SCHEMA_VERSION,
    classification: 'SOFT',
    weight,
    scope,
    predicate,
  };
}

// ─── The corpus (each entry: a problem plus its construction record) ──────────

/**
 * Every fixture is a total function of constants below — no inputs. Each carries
 * either a `constructionArgument` (feasible) or an `infeasibilityCertificate`
 * (infeasible). The `rules` are typed ASTs; `staff`, `shiftTypes` and `demand`
 * are the synthetic problem frame the rules are stated over.
 */
function corpus() {
  return [
    {
      name: 'B-feasible-small',
      class: 'feasible',
      description: '15 synthetic staff, one week, a single required-count coverage rule.',
      frame: {
        staff: members(15),
        shiftTypes: [{ code: 'day', qualifications: [] }],
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
        demandPerDay: 1,
        qualificationHolders: {},
      },
      rules: [
        hard(
          'cover_day',
          'Cover the day shift',
          { kind: 'RequiredCount', count: 1 },
          { shiftTypes: ['day'] },
        ),
      ],
      constructionArgument:
        'Demand is 1 assignment per day for 7 days = 7 slots. 15 staff are eligible (no HARD eligibility rule excludes any), and no HARD rule caps a member below 1 assignment/day. Assign a distinct member to each of the 7 slots (7 <= 15): each RequiredCount(1) slot is filled and no capacity, eligibility, rest, pattern, or linkage HARD rule is stated, so every HARD rule holds. A satisfying assignment therefore exists — feasible by construction. (The argument counts; it does not build the assignment.)',
    },
    {
      name: 'B-feasible-eligibility',
      class: 'feasible',
      description: '15 staff, a qualification-gated shift with more holders than demand.',
      frame: {
        staff: members(15),
        shiftTypes: [{ code: 'call', qualifications: ['acls'] }],
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        demandPerDay: 1,
        qualificationHolders: { acls: members(15).slice(0, 6) },
      },
      rules: [
        hard(
          'cover_call',
          'Cover the call shift',
          { kind: 'RequiredCount', count: 1 },
          { shiftTypes: ['call'] },
        ),
        hard(
          'call_needs_acls',
          'Call requires ACLS',
          { kind: 'RequiresQualification', qualification: 'acls', validAt: 'shift_date' },
          { shiftTypes: ['call'] },
        ),
        soft('prefer_spread', 'Spread the call load', 5, {
          kind: 'FairnessBalance',
          metric: 'call_load',
          normalisation: 'per_fte',
        }),
      ],
      constructionArgument:
        'Demand is 1 call/day for 5 days = 5 slots, each HARD-gated to ACLS holders (RequiresQualification, valid at the shift date). 6 members hold ACLS, and no HARD rule caps a holder below the schedule. 5 slots can be filled from 6 eligible holders (5 <= 6) using distinct members, satisfying RequiredCount(1) and RequiresQualification on every slot. The one SOFT rule (FairnessBalance) cannot cause infeasibility — a soft rule is an objective term, never a constraint (SPEC-04 §3.3). Feasible by construction.',
    },
    {
      name: 'B-infeasible-overdemand',
      class: 'infeasible',
      description: 'Required coverage exceeds the eligible population.',
      frame: {
        // FIVE staff, of whom THREE are senior. Both numbers are load-bearing:
        // 4 <= 5 makes the population alone sufficient (so `cover_day_4` is not
        // unsatisfiable on its own), and 4 > 3 makes the eligibility restriction
        // the thing that breaks it. An earlier version had 3 staff who were ALL
        // senior, which made `day_seniors_only` inert and the certificate
        // non-minimal — `{cover_day_4}` alone was already unsatisfiable.
        staff: members(5),
        shiftTypes: [{ code: 'day', qualifications: [] }],
        days: ['mon'],
        demandPerDay: 4,
        qualificationHolders: {},
        eligibleStaffGroup: { senior: members(5).slice(0, 3) },
      },
      rules: [
        hard(
          'cover_day_4',
          'Cover four day slots',
          { kind: 'RequiredCount', count: 4 },
          { shiftTypes: ['day'] },
        ),
        hard(
          'day_seniors_only',
          'Day is seniors only',
          { kind: 'MemberOfStaffGroup', staffGroup: 'senior' },
          { shiftTypes: ['day'] },
        ),
      ],
      infeasibilityCertificate: {
        conflictingRules: ['cover_day_4', 'day_seniors_only'],
        cause: 'over-demand',
        proof:
          'The population is 5 staff, of whom 3 are senior. RequiredCount(4) demands 4 distinct assignments on the Monday day shift; MemberOfStaffGroup(senior) HARD-restricts eligibility to the 3 seniors. A slot needs a distinct member and only 3 are eligible: 4 > 3, unsatisfiable. MINIMAL, and both removals are checked: drop cover_day_4 and 0 slots are required, trivially feasible; drop day_seniors_only and all 5 staff are eligible, so 4 <= 5 and a satisfying assignment exists. Neither rule is unsatisfiable on its own, so no proper subset of {cover_day_4, day_seniors_only} is already infeasible — the core is minimal in the rule dimension against this fixed population.',
      },
    },
    {
      name: 'B-infeasible-missing-qualification',
      class: 'infeasible',
      description: 'A HARD qualification requirement no member holds.',
      frame: {
        staff: members(10),
        shiftTypes: [{ code: 'picu', qualifications: ['picu_cert'] }],
        days: ['mon'],
        demandPerDay: 1,
        qualificationHolders: { picu_cert: [] },
      },
      rules: [
        hard(
          'cover_picu',
          'Cover PICU',
          { kind: 'RequiredCount', count: 1 },
          { shiftTypes: ['picu'] },
        ),
        hard(
          'picu_needs_cert',
          'PICU requires certification',
          { kind: 'RequiresQualification', qualification: 'picu_cert', validAt: 'shift_date' },
          { shiftTypes: ['picu'] },
        ),
      ],
      infeasibilityCertificate: {
        conflictingRules: ['cover_picu', 'picu_needs_cert'],
        cause: 'missing-qualification',
        proof:
          'RequiredCount(1) demands one PICU assignment; RequiresQualification(picu_cert) HARD-restricts it to holders of picu_cert. Zero members hold picu_cert, so the eligible set is empty and the one required slot cannot be filled. Minimal: dropping cover_picu leaves 0 required slots (feasible); dropping picu_needs_cert makes all 10 members eligible (feasible). Either removal restores feasibility, so {cover_picu, picu_needs_cert} is a minimal core.',
      },
    },
    {
      name: 'B-infeasible-fixed-conflict',
      class: 'infeasible',
      description: 'Two fixed assignments pin conflicting content into one slot.',
      frame: {
        staff: members(5),
        shiftTypes: [{ code: 'day', qualifications: [] }],
        days: ['mon'],
        demandPerDay: 1,
        qualificationHolders: {},
      },
      rules: [
        hard(
          'at_most_one_day',
          'At most one on the day shift',
          { kind: 'MaxCoverage', max: 1 },
          { shiftTypes: ['day'] },
        ),
        hard(
          'pin_m01',
          'Pin m01 to the day slot',
          { kind: 'FixedAssignment', assignmentIdentity: 'mon-day-m01' },
          { shiftTypes: ['day'], memberships: ['m01'] },
        ),
        hard(
          'pin_m02',
          'Pin m02 to the day slot',
          { kind: 'FixedAssignment', assignmentIdentity: 'mon-day-m02' },
          { shiftTypes: ['day'], memberships: ['m02'] },
        ),
      ],
      infeasibilityCertificate: {
        conflictingRules: ['at_most_one_day', 'pin_m01', 'pin_m02'],
        cause: 'fixed-assignment-conflict',
        proof:
          'MaxCoverage(1) HARD-caps the Monday day shift at one assignment. FixedAssignment pins m01 AND FixedAssignment pins m02 into that same Monday day slot — two distinct forced assignments. 2 forced > 1 permitted, unsatisfiable. Minimal: drop at_most_one_day (both pins fit) OR drop either pin (one forced <= 1). Every single removal restores feasibility, so the three rules are a minimal unsatisfiable core.',
      },
    },
    {
      name: 'B-infeasible-contradictory-rules',
      class: 'infeasible',
      description: 'One rule forces an assignment another rule forbids.',
      frame: {
        staff: members(6),
        shiftTypes: [
          { code: 'day', qualifications: [] },
          { code: 'evening', qualifications: [] },
        ],
        days: ['mon'],
        demandPerDay: 1,
        qualificationHolders: {},
      },
      rules: [
        hard(
          'cover_day',
          'Cover the day shift',
          { kind: 'RequiredCount', count: 1 },
          { shiftTypes: ['day'] },
        ),
        hard('day_implies_evening', 'A day assignment implies the evening', {
          kind: 'ImpliesAssignment',
          ifShiftType: 'day',
          thenShiftType: 'evening',
        }),
        hard('day_evening_exclusive', 'Day and evening are mutually exclusive', {
          kind: 'MutuallyExclusive',
          shiftTypes: ['day', 'evening'],
        }),
      ],
      infeasibilityCertificate: {
        conflictingRules: ['cover_day', 'day_implies_evening', 'day_evening_exclusive'],
        cause: 'contradictory-rules',
        proof:
          'RequiredCount(1) forces a member M onto the day shift. ImpliesAssignment(day -> evening) then forces M onto the evening shift; MutuallyExclusive({day, evening}) forbids any member from holding both. So M must and must not hold evening — a contradiction for every M. Minimal: drop cover_day (no forced day assignment, vacuously feasible) OR drop day_implies_evening (day no longer forces evening) OR drop day_evening_exclusive (both allowed). Each single removal restores feasibility, so the three are a minimal unsatisfiable core.',
      },
    },
  ];
}

// ─── Emission ─────────────────────────────────────────────────────────────────

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Build the canonical bytes for every fixture and the manifest. No I/O here. */
function render() {
  const entries = corpus();
  /** @type {{ name: string, bytes: string }[]} */
  const files = [];
  const manifestEntries = [];

  for (const entry of entries) {
    // Validate every rule against the typed model; a non-conforming rule cannot ship.
    for (const rule of entry.rules) {
      const problems = ruleProblems(rule);
      if (problems.length > 0) {
        throw new Error(
          `Fixture ${entry.name} rule ${String(rule.ruleKey)} is invalid: ${JSON.stringify(problems)}`,
        );
      }
    }
    // Compile to the canonical solver-input form (references the typed model; no solve).
    const compiled = compileRuleSet(entry.rules, RULE_SCHEMA_VERSION);

    const fixture = {
      name: entry.name,
      class: entry.class,
      description: entry.description,
      frame: entry.frame,
      rules: entry.rules,
      compiledRules: compiled,
      ...(entry.constructionArgument !== undefined
        ? { constructionArgument: entry.constructionArgument }
        : {}),
      ...(entry.infeasibilityCertificate !== undefined
        ? { infeasibilityCertificate: entry.infeasibilityCertificate }
        : {}),
    };

    const bytes = `${canonicalStringify(fixture)}\n`;
    files.push({ name: `${entry.name}.json`, bytes });
    manifestEntries.push({
      name: entry.name,
      class: entry.class,
      file: `fixtures/${entry.name}.json`,
      sha256: sha256(bytes),
    });
  }

  const manifest = {
    corpusVersion: 1,
    ruleSchemaVersion: RULE_SCHEMA_VERSION,
    generator: 'solver/corpus/build-corpus.mjs',
    note: 'Wholly synthetic, known-by-construction. Fixtures only — no solver, no assignment generation (M4). Regenerate with `node solver/corpus/build-corpus.mjs`; byte-identical on re-run.',
    fixtures: manifestEntries,
  };
  const manifestBytes = `${canonicalStringify(manifest)}\n`;
  return { files, manifestBytes };
}

function writeAll() {
  const { files, manifestBytes } = render();
  mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const file of files) writeFileSync(join(FIXTURES_DIR, file.name), file.bytes, 'utf8');
  writeFileSync(join(HERE, 'manifest.json'), manifestBytes, 'utf8');
  process.stdout.write(
    `Wrote ${String(files.length)} fixture(s) + manifest.json to ${FIXTURES_DIR}\n`,
  );
}

function check() {
  const { files, manifestBytes } = render();
  /** @type {string[]} */
  const drift = [];
  for (const file of files) {
    const path = join(FIXTURES_DIR, file.name);
    let onDisk = '';
    try {
      onDisk = readFileSync(path, 'utf8');
    } catch {
      drift.push(`${file.name}: missing on disk`);
      continue;
    }
    if (onDisk !== file.bytes) drift.push(`${file.name}: on-disk bytes differ from regeneration`);
  }
  const manifestOnDisk = (() => {
    try {
      return readFileSync(join(HERE, 'manifest.json'), 'utf8');
    } catch {
      return '';
    }
  })();
  if (manifestOnDisk !== manifestBytes)
    drift.push('manifest.json: on-disk bytes differ from regeneration');

  // Extra file that regeneration did not produce = tampering / stale fixture.
  const expected = new Set(files.map((f) => f.name));
  let present = [];
  try {
    present = readdirSync(FIXTURES_DIR).filter((n) => n.endsWith('.json'));
  } catch {
    present = [];
  }
  for (const name of present)
    if (!expected.has(name))
      drift.push(`${name}: present on disk but not produced by the generator`);

  if (drift.length > 0) {
    process.stdout.write(
      `FAIL  corpus regeneration is not byte-identical:\n${drift.map((d) => `  ${d}\n`).join('')}`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `PASS  corpus regeneration byte-identical — ${String(files.length)} fixture(s) + manifest\n`,
  );
}

function main() {
  if (process.argv.includes('--check')) check();
  else writeAll();
}

main();
