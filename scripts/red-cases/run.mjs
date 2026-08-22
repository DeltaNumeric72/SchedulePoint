import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  evidenceDestinationBanner,
  isEvidenceRefresh,
  resolveEvidencePath,
} from '../evidence-target.mjs';
import { erroredReason } from './errored-signatures.mjs';
import { resolveTestPgPort } from '../sbx/test-port.mjs';

/** NR-14: a plain run writes to scratch; `--refresh` updates the tracked file. */
const EVIDENCE_REFRESH = isEvidenceRefresh();

/**
 * `pnpm red-cases` — proof that every gate actually fails.
 *
 * ## Why this exists
 *
 * A gate that has only ever been observed passing is not evidence of anything.
 * A regex with a typo, a config with a wrong path, a check that scans an empty
 * directory — all of them report PASS forever, and the first time anyone finds
 * out is when the thing the gate was supposed to prevent ships.
 *
 * So each gate ships with a violation that must make it fail, and this runner
 * proves both directions in one pass:
 *
 *   GREEN  the gate passes on the clean tree
 *   RED    the gate fails once the violation is introduced
 *
 * A gate that fails its GREEN check is broken. A gate that passes its RED check
 * is worse: it is decorative.
 *
 * ## How the violation is introduced
 *
 * Wherever possible the fixture is copied **into the real working tree** and the
 * **real gate command** is run against it — not a parallel copy of the config,
 * not a fixture directory the gate would never look at. Three gates cannot work
 * that way and say so explicitly:
 *
 *  - `invariant-ids` scans `docs/architecture`, which this task may not modify,
 *    so it targets a fixture directory via the gate's own `--dir` flag;
 *  - `secret-scan` would otherwise have to commit a key-shaped string into a
 *    scanned path, so it targets a fixture directory with `--no-exclude`;
 *  - `request-budget` reads recordings produced by the browser run, so it
 *    targets a fixture directory containing a copy of the budget shape.
 *
 * Everything injected is named `__red_case__*` and gitignored, and the runner
 * clears leftovers before it starts and restores every patched file afterwards.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HERE = dirname(fileURLToPath(import.meta.url));
const PM_EXECPATH = process.env['npm_execpath'];

/**
 * @typedef {{ from: string, to: string }} Injection
 * @typedef {{ file: string, find: string, replace: string }} Patch
 * @typedef {{
 *   id: string,
 *   gate: string,
 *   violation: string,
 *   greenCommand: string[],
 *   redCommand: string[],
 *   inject?: Injection[],
 *   patch?: Patch[],
 *   setup?: string[][],
 *   prepare?: string[][],
 *   restore?: string[][],
 *   invertPolarity?: boolean,
 *   erroredExempt?: boolean,
 * }} RedCase
 */

/** @type {RedCase[]} */
const CASES = [
  {
    id: 'lint',
    gate: 'lint (eslint)',
    violation: 'a SET LOCAL tenant-context statement in API source',
    inject: [
      { from: 'lint/fixture/set-local.ts', to: 'apps/api/src/http/__red_case__set-local.ts' },
    ],
    greenCommand: ['run', 'gate:lint'],
    redCommand: ['run', 'gate:lint'],
  },
  {
    id: 'typecheck',
    gate: 'typecheck (tsc -b)',
    violation: 'a string returned from a function declared to return number',
    inject: [
      { from: 'typecheck/fixture/type-error.ts', to: 'packages/contracts/src/__red_case__type.ts' },
    ],
    greenCommand: ['run', 'gate:typecheck'],
    redCommand: ['run', 'gate:typecheck'],
  },
  {
    id: 'unit',
    gate: 'unit tests (vitest)',
    violation: 'a failing assertion in the domain package',
    inject: [
      { from: 'unit/fixture/failing.test.ts', to: 'packages/domain/test/__red_case__.test.ts' },
    ],
    greenCommand: ['run', 'gate:unit'],
    redCommand: ['run', 'gate:unit'],
  },
  {
    id: 'import-boundary',
    gate: 'import boundary (dependency-cruiser)',
    violation: 'packages/domain importing from apps/api',
    inject: [
      {
        from: 'import-boundary/fixture/infra-import.ts',
        to: 'packages/domain/src/__red_case__infra.ts',
      },
    ],
    greenCommand: ['run', 'gate:import-boundary'],
    redCommand: ['run', 'gate:import-boundary'],
  },
  {
    id: 'route-policy',
    gate: 'route-without-policy (I-02)',
    violation: 'POST /red-case/undeclared registered with no config.policy',
    inject: [
      {
        from: 'route-policy/fixture/undeclared.route.ts',
        to: 'apps/api/src/http/routes/__red_case__undeclared.route.ts',
      },
    ],
    greenCommand: ['run', 'gate:route-policy'],
    redCommand: ['run', 'gate:route-policy'],
  },
  {
    id: 'migration-rls',
    gate: 'migration + RLS pairing (I-15)',
    violation: 'CREATE TABLE with organization_id and no RLS policy',
    inject: [
      {
        from: 'migration-rls/fixture/001_no_rls.sql',
        to: 'apps/api/migrations/__red_case__001_no_rls.sql',
      },
    ],
    greenCommand: ['run', 'gate:migration-rls'],
    redCommand: ['run', 'gate:migration-rls'],
  },
  {
    id: 'invariant-ids',
    gate: 'invariant-ID uniqueness (CAR-023)',
    violation: 'I-05 defined with two different meanings in two documents',
    greenCommand: ['run', 'gate:invariant-ids'],
    redCommand: [
      'exec',
      'node',
      'scripts/gates/invariant-id-uniqueness.mjs',
      '--dir',
      'scripts/red-cases/invariant-ids/fixture',
    ],
  },
  {
    id: 'rule-node-mapping',
    gate: 'rule-node → compiler-mapping closure (SPEC-04 §3.2)',
    violation: 'an AST node kind declared with no compiler mapping',
    // Add a node to the declared closed set without a compiler `case` for it.
    // TypeScript exhaustiveness would also catch this, but the point of the gate
    // is an independent build-failing check: it must fire on its own. The gate
    // scans source, so no rebuild is needed and the red arm is self-contained.
    patch: [
      {
        file: 'packages/domain/src/rules/ast.ts',
        find: "  'ProtectedRange',\n] as const satisfies readonly RuleNodeKind[];",
        replace:
          "  'ProtectedRange',\n  'UnmappedProbe',\n] as const satisfies readonly RuleNodeKind[];",
      },
    ],
    greenCommand: ['run', 'gate:rule-node-mapping'],
    redCommand: ['run', 'gate:rule-node-mapping'],
  },
  {
    id: 'solver-kind-parity',
    gate: 'solver/checker HARD-kind parity (doc 35 §6d)',
    violation: 'a HARD kind the checker evaluates that the model does not build',
    /* The direction chosen is the one that actually happened. FAD-42 R-1 was a
     * WINDOW-level version of exactly this: the model failed to constrain
     * something the checker enforced, so candidates came back and were refused
     * after the fact, and the engine said "worker output rejected" where the
     * honest answer was INFEASIBLE. At kind level the same divergence is
     * invisible until a rule of that kind appears in a real build.
     *
     * The patch removes `MinimumRestBetween` from the Python tuple — the very
     * kind R-1 was about — leaving the checker still evaluating it. The gate
     * parses source, so no rebuild and no interpreter are needed and the arm is
     * self-contained.
     *
     * Anchored on the two neighbouring entries rather than the line alone, so a
     * reordering of the tuple breaks the anchor loudly (`anchor not found`)
     * instead of silently patching a different kind. */
    patch: [
      {
        file: 'solver/schedulepoint_solver/model.py',
        find: '    "MaxConsecutive",\n    "MinimumRestBetween",\n    "CallSpacing",',
        replace: '    "MaxConsecutive",\n    "CallSpacing",',
      },
    ],
    greenCommand: ['run', 'gate:solver-kind-parity'],
    redCommand: ['run', 'gate:solver-kind-parity'],
  },
  {
    id: 'rule-kind-registry',
    gate: 'rule-kind registry is generated (doc 34 §4-D)',
    violation: 'a count in the committed registry edited by hand',
    /* The registry exists because the PREVIOUS register was prose with the
     * counts typed into its headings, and three of them were wrong. The claim
     * "the registry is generated" is a claim about this gate, so the gate has to
     * be seen failing: one number, edited by hand, in the committed artifact.
     *
     * ── RE-ANCHORED at OPUS-M4-002, and the re-anchoring is the finding ──
     *
     * The anchor read `| One owner ruling away, nothing else needed | 11 |`.
     * That row is GENERATED, and this packet is what moved it: the eleven
     * RK-RULINGs answered every open ruling, so the label became "Still ONE OPEN
     * owner ruling away…" and the count became 0. The anchor stopped matching
     * and the runner threw `anchor not found` — which is a BROKEN case, not a
     * failing one, and a broken case proves nothing at all.
     *
     * It went unnoticed because `pnpm check` and `pnpm red-cases` are different
     * batteries: the registry gate stayed green throughout (the committed
     * artifact and the generated one agreed), and only the arm that tampers with
     * the artifact could see the row had moved.
     *
     * Re-anchored to `| Unique node kinds | 30 |` — the ONE count in this
     * artifact that no ruling, no owner assignment and no milestone can change,
     * because it counts the closed AST node set. An arm anchored to a number the
     * next packet will legitimately move is an arm that breaks again. Nothing is
     * weakened: the violation is still exactly one number edited by hand in the
     * committed artifact, and the gate must still catch it. */
    patch: [
      {
        file: 'packages/domain/src/rules/rule-kind-registry.generated.md',
        find: '| Unique node kinds | 30 |',
        replace: '| Unique node kinds | 29 |',
      },
    ],
    greenCommand: ['run', 'gate:rule-kind-registry'],
    redCommand: ['run', 'gate:rule-kind-registry'],
  },
  {
    id: 'provider-boundary-unguarded',
    gate: 'provider outside unit of work (SPEC-12 U-07) — unguarded entry point',
    violation: 'a declared provider module whose entry point does not open with the guard',
    inject: [
      {
        from: 'provider-boundary/fixture/unguarded-provider.ts',
        to: 'apps/api/src/db/__red_case__unguarded-provider.ts',
      },
    ],
    greenCommand: ['run', 'gate:provider-boundary'],
    redCommand: ['run', 'gate:provider-boundary'],
  },
  {
    id: 'provider-boundary-in-transaction',
    gate: 'provider outside unit of work (SPEC-12 U-07) — provider inside a transaction',
    violation: 'a provider called from inside a runner.run(...) callback',
    inject: [
      {
        from: 'provider-boundary/fixture/provider-in-transaction.ts',
        to: 'apps/api/src/db/__red_case__provider-in-transaction.ts',
      },
    ],
    greenCommand: ['run', 'gate:provider-boundary'],
    redCommand: ['run', 'gate:provider-boundary'],
  },
  {
    id: 'provider-boundary-owns-connection',
    gate: 'provider outside unit of work (SPEC-12 U-07) — provider owns a connection',
    violation: 'a declared provider module that imports the unit-of-work runner',
    /* Gate class 3, which had no red case while classes 1 and 2 did (independent
     * review N-1).
     *
     * It is not decoration. A provider that can OPEN a transaction can put
     * itself inside one, and once it does, class 2 has nothing left to see —
     * the illegal call is no longer at a call site in some other module's
     * unit-of-work callback, it has been folded into the provider. Class 3 is
     * what keeps classes 1 and 2 meaningful, so it needs its own proof.
     *
     * The fixture's guard is present and correctly placed, so the gate must fail
     * on the RUNNER IMPORT alone. */
    inject: [
      {
        from: 'provider-boundary/fixture/provider-owns-connection.ts',
        to: 'apps/api/src/db/__red_case__provider-owns-connection.ts',
      },
    ],
    greenCommand: ['run', 'gate:provider-boundary'],
    redCommand: ['run', 'gate:provider-boundary'],
  },
  {
    id: 'provider-boundary-runtime-mutation',
    gate: 'provider outside unit of work (SPEC-12 U-07) — the RUNTIME arm',
    violation: 'the runtime guard neutered, so only the static gate is left',
    /* THE FALSIFIABILITY CASE, and the one that matters most here.
     *
     * The static gate above cannot see a closure captured outside a transaction
     * and invoked inside it, a dynamic import, or a provider reached through a
     * lookup table — and all three are reachable. So the runtime guard is what
     * makes the rule true rather than tidy, and a runtime guard that has only
     * ever been observed passing is not evidence of anything.
     *
     * This turns `assertOutsideUnitOfWork` into a no-op — leaving the marker, the
     * probe and the static gate all intact and green — and
     * `apps/api/test/providers/boundary.test.ts` must go red. If it does not, its
     * refusals were coming from something else and the guard is decorative. */
    patch: [
      {
        file: 'apps/api/src/db/provider-boundary.ts',
        find: '  assertProviderOutsideUnitOfWork(providerName, unitOfWorkBoundaryProbe);',
        replace: '  void providerName; // red case: the runtime guard is neutered',
      },
    ],
    greenCommand: ['run', 'gate:unit'],
    redCommand: ['run', 'gate:unit'],
  },
  {
    id: 'nr14-clean-tree',
    gate: 'NR-14 evidence destination (a plain run leaves the tree clean)',
    violation: 'an evidence writer restored to writing its TRACKED path unconditionally',
    /* The regression this closes, expressed exactly: `scripts/check.mjs` writing
     * `scripts/check-output.txt` no matter what the run asked for. With the patch
     * applied the writer bypasses the resolver, and the check must notice. */
    patch: [
      {
        file: 'scripts/check.mjs',
        find:
          "  const transcriptPath = resolveEvidencePath(REPO_ROOT, 'scripts/check-output.txt', REFRESH);",
        replace: "  const transcriptPath = resolve(REPO_ROOT, 'scripts/check-output.txt');",
      },
    ],
    greenCommand: ['exec', 'node', 'scripts/red-cases/nr14/clean-tree.mjs'],
    redCommand: ['exec', 'node', 'scripts/red-cases/nr14/clean-tree.mjs'],
  },
  {
    id: 'corpus-tamper',
    gate: 'B-* corpus regeneration byte-identity (SPEC-04 §8)',
    violation: 'a committed corpus fixture edited away from its generated form',
    // Tamper with a committed fixture; regeneration produces the original bytes,
    // so the on-disk/regenerated diff must be caught. corpus:check rebuilds the
    // domain dist first so the comparison runs against the real generator.
    patch: [
      {
        file: 'solver/corpus/fixtures/B-feasible-small.json',
        find: '"count":1',
        replace: '"count":2',
      },
    ],
    greenCommand: ['run', 'corpus:check'],
    redCommand: ['run', 'corpus:check'],
  },
  {
    id: 'secret-scan',
    gate: 'secret scan',
    violation: 'AWS key, GitHub token, Stripe key and a DSN password in one file',
    greenCommand: ['run', 'gate:secret-scan'],
    redCommand: [
      'exec',
      'node',
      'scripts/gates/secret-scan.mjs',
      '--dir',
      'scripts/red-cases/secret-scan/fixture',
      '--no-exclude',
    ],
  },
  {
    id: 'network-guard-source',
    gate: 'network-assertion guard (SP-HR-1) — source scan',
    violation: 'fetch() to analytics.example.com in apps/web/src',
    inject: [{ from: 'network-guard/fixture/beacon.ts', to: 'apps/web/src/__red_case__beacon.ts' }],
    greenCommand: ['run', 'gate:network-guard'],
    redCommand: ['run', 'gate:network-guard'],
  },
  {
    id: 'network-guard-bundle',
    gate: 'network-assertion guard (SP-HR-1) — built-bundle scan',
    violation: 'a minified third-party beacon present only in apps/web/dist',
    inject: [
      {
        from: 'network-guard-bundle/fixture/tracker.js',
        to: 'apps/web/dist/assets/__red_case__tracker.js',
      },
    ],
    greenCommand: ['run', 'gate:network-guard'],
    redCommand: ['run', 'gate:network-guard'],
  },
  {
    id: 'build',
    gate: 'production build (vite build)',
    violation: 'an unresolvable import reachable from the entry point',
    inject: [{ from: 'build/fixture/broken.tsx', to: 'apps/web/src/__red_case__broken.tsx' }],
    patch: [
      {
        file: 'apps/web/src/main.tsx',
        find: "import './styles/index.css';",
        replace: "import './styles/index.css';\nimport './__red_case__broken.js';",
      },
    ],
    greenCommand: ['run', 'gate:build'],
    redCommand: ['run', 'gate:build'],
    // The clean bundle has to come back: later gates scan apps/web/dist.
    restore: [['run', 'gate:build']],
  },
  {
    id: 'axe',
    gate: 'axe-core via Playwright (CAP-066)',
    violation: 'an <img> with no alt attribute in the rendered shell',
    patch: [
      {
        file: 'apps/web/src/shell/ShellPage.tsx',
        find: '<main id="main" className="flex flex-col gap-4">',
        replace:
          '<main id="main" className="flex flex-col gap-4">\n          <img src="/red-case.png" width={1} height={1} />',
      },
    ],
    // The gate runs against the production build, so the violation has to be
    // built before it can be observed.
    prepare: [['run', 'gate:build']],
    greenCommand: ['run', 'gate:axe'],
    redCommand: ['run', 'gate:axe'],
    restore: [['run', 'gate:build']],
  },
  {
    id: 'i13-schedule-authoring',
    gate: 'I-13 zero-requests-before-Save, on the schedule surface',
    violation: 'the "New period" control issues a request when it is clicked',
    // I-13 exists because a control labelled New once created a live record on
    // click. The e2e records the requests that one click produces and asserts
    // the list is EMPTY, and the budget for the interaction is 0. This injects
    // exactly the shape the invariant forbids — a click that talks to the
    // server before any form is completed — and the assertion must catch it.
    patch: [
      {
        file: 'apps/web/src/schedule/PeriodsPage.tsx',
        find:
          '            // I-13: local state only. Nothing is created, nothing is fetched.\n' +
          '            setProblems([]);\n' +
          '            setIsAuthoring(true);',
        replace:
          '            void fetch(\'/api/health\');\n' +
          '            setProblems([]);\n' +
          '            setIsAuthoring(true);',
      },
    ],
    // The gate runs against the production build, so the violation has to be
    // built before it can be observed.
    prepare: [['run', 'gate:build']],
    greenCommand: ['run', 'gate:axe'],
    redCommand: ['run', 'gate:axe'],
    // The RED arm leaves a VIOLATING recording on disk — the whole point is that
    // the click issued a request — and the two request-budget cases that follow
    // read those recordings. So the restore rebuilds the clean bundle AND
    // re-measures, or this case silently fails the next two.
    restore: [
      ['run', 'gate:build'],
      ['run', 'gate:axe'],
    ],
  },
  {
    id: 'publish-idempotency-key-retained',
    gate: 'publish-once: the client RETAINS its idempotency key across retries (D-17)',
    violation: 'the publication key is re-minted on every render, so a retry publishes again',
    // A retry of a publication must carry the SAME key, so the server finds its
    // own `publication_records` row and REPLAYS: no second outbox event, no
    // second audit row, no second supersession. A client that mints a fresh key
    // per attempt instead publishes a SECOND time and instantly supersedes the
    // publication that had just happened — history gains a version nobody
    // authored and every affected member is notified twice.
    //
    // The defect is invisible in the browser: both attempts return 200 and the
    // screen looks correct. So the retention is injected-out here, and
    // `apps/web/e2e/publication.spec.ts` ("a RETRY carries the same idempotency
    // key") must fail. One line, in the one module that owns the decision.
    patch: [
      {
        file: 'apps/web/src/publication/idempotency.ts',
        find: '  return { key: current.key, renew };',
        replace: '  return { key: newPublicationIdempotencyKey(), renew };',
      },
    ],
    // The gate runs against the production build, so the violation has to be
    // built before it can be observed.
    prepare: [['run', 'gate:build']],
    greenCommand: ['run', 'gate:axe'],
    redCommand: ['run', 'gate:axe'],
    // The RED arm leaves recordings from a failed run on disk, and the two
    // request-budget cases below read them — so the restore rebuilds the clean
    // bundle AND re-measures, exactly as `i13-schedule-authoring` does.
    restore: [
      ['run', 'gate:build'],
      ['run', 'gate:axe'],
    ],
  },
  {
    id: 'stale-edit-cas',
    gate: 'server-authoritative compare-and-set (PO-DEC-18)',
    violation: 'the advisory lock removed, leaving the compare-and-set read unserialized',
    // "A stale edit is refused and re-fetched, never silently merged."
    //
    // The violation targets ATOMICITY, not the comparison. An earlier version of
    // this case disarmed the `!==` test, which a sequential test catches — and a
    // sequential test is exactly what missed the real defect. Every unit of work
    // is READ COMMITTED, so removing the lock leaves two concurrent writers
    // reading the same pre-state, both finding their token current, and both
    // writing. That is invisible to any test that does not actually race.
    //
    // `apps/api/test/schedule/authoring-concurrency.test.ts` is what fails here,
    // and it fails with the reviewer's own words: "both writers were accepted".
    patch: [
      {
        file: 'apps/api/src/http/routes/schedule-authoring.route.ts',
        find: '    await lockAnchor(uow, `cell:${versionId}:${date}:${shiftTypeId}`);',
        replace: '    // red case: the cell lock is removed, leaving the CAS read unserialized',
      },
      {
        // OPUS-M4-000A: the requirement editor's CAS moved from a per-cell
        // lock in the route to the AGGREGATE lock in `acquireStaffingSet`
        // (the whole-set replacement's serialization point, shared by the
        // demand editors). Removing it leaves the aggregate compare-and-set
        // read unserialized, and the 12-round races in
        // `apps/api/test/catalogue/demand-replacement.test.ts` and
        // `apps/api/test/schedule/authoring-concurrency.test.ts` (B-1) must fail.
        file: 'apps/api/src/catalogue/staffing-set-version.ts',
        find: '  await sql`select pg_advisory_xact_lock(${key}::bigint)`.execute(uow.query);',
        replace: '  // red case: the aggregate lock is removed, leaving the CAS read unserialized',
      },
    ],
    greenCommand: ['run', 'gate:unit'],
    redCommand: ['run', 'gate:unit'],
  },
  {
    id: 'draft-invisibility',
    gate: 'a draft schedule version is invisible to staff (doc 07 §1)',
    violation: 'the published-only predicate removed from the staff schedule read',
    // Doc 07 §1: a draft version "is not visible to staff". The control is a
    // two-clause predicate on the version join, so the rows are never selected
    // — a filter applied after the read would be a line somebody can move above
    // a `return`, and this is not.
    //
    // Removing the clauses makes the draft's rows selectable, which
    // `apps/api/test/schedule/views-http.test.ts` proves directly in SQL, and
    // then makes the read fail: a draft has no `version_number` (D-9 allocates
    // it inside the publication transaction) and the contract requires a
    // positive one. The suite goes red either way, which is the point; the
    // route's docblock records that the first of the two controls is what
    // reports.
    patch: [
      {
        file: 'apps/api/src/http/routes/schedule-views.route.ts',
        find:
          "    .where('schedule_versions.state', '=', 'published')\n" +
          "    .where('schedule_versions.is_current', '=', true);",
        replace: '    ; // red case: the published-only predicate is removed',
      },
    ],
    greenCommand: ['run', 'gate:unit'],
    redCommand: ['run', 'gate:unit'],
  },
  {
    id: 'noop-audit-emission',
    gate: 'FAD-24: a no-op demand save emits NO audit event (OPUS-M4-000A)',
    violation: 'the changed-only condition removed, so every save is audited as a change',
    // The load-bearing emission control: open-then-save-unchanged must emit
    // nothing, and a real save must still emit. This patch makes the route
    // emit UNCONDITIONALLY, and the emission-control test in
    // `demand-replacement.test.ts` — which counts audit rows after the exact
    // editor round trip — must fail on its no-op arm.
    patch: [
      {
        file: 'apps/api/src/http/routes/catalogue.route.ts',
        find:
          '        (result) =>\n' +
          '          result.changed\n' +
          '            ? {\n' +
          '                eventName: CATALOGUE_AUDIT_EVENTS.shiftTypeDemandSet,',
        replace:
          '        (result) =>\n' +
          '          true // red case: the no-op condition is removed\n' +
          '            ? {\n' +
          '                eventName: CATALOGUE_AUDIT_EVENTS.shiftTypeDemandSet,',
      },
    ],
    greenCommand: ['exec', 'vitest', 'run', 'apps/api/test/catalogue/demand-replacement.test.ts'],
    redCommand: ['exec', 'vitest', 'run', 'apps/api/test/catalogue/demand-replacement.test.ts'],
  },
  {
    id: 'requires-expiry-service',
    gate: 'requires_expiry enforced at the SERVICE layer (OPUS-M4-000A)',
    violation: 'the service-side requires-expiry refusal removed, leaving only the trigger',
    // The packet requires enforcement at the service AND the database, each
    // red-cased. The DB trigger's red case suspends the trigger; this one
    // removes the SERVICE check and the service-layer test — which asserts the
    // TYPED error class, not merely "some refusal" — must fail, because the
    // refusal now arrives as a raw SQLSTATE from the trigger instead.
    patch: [
      {
        file: 'apps/api/src/profiles/qualifications.ts',
        find:
          '    if (\n' +
          '      qualification.requires_expiry &&\n' +
          '      (input.validUntil === undefined || input.validUntil === null)\n' +
          '    ) {\n' +
          "      throw new QualificationRuleError(\n" +
          "        'QUALIFICATION_REQUIRES_EXPIRY',\n" +
          "        'this qualification requires an expiry; the holding must carry validUntil',\n" +
          '      );\n' +
          '    }',
        replace: '    // red case: the service-side requires-expiry refusal is removed',
      },
    ],
    greenCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/profiles/staffing-integrity-red-cases.test.ts',
    ],
    redCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/profiles/staffing-integrity-red-cases.test.ts',
    ],
  },
  {
    id: 'retired-verdict',
    gate: 'the shared verdict: retirement confers nothing (OPUS-M4-000A)',
    violation: 'the retirement-first rule removed — a retired qualification evaluates as active',
    // The verdict's rule 1 (fail-closed retirement) is what makes "existing
    // holdings retained, verdict reflecting retirement" true on every
    // consumer at once. Removing it must fail the domain property tests AND
    // the manual-vs-publication convergence proof.
    /* ── REPAIRED at the 000C integration (FAD-33(1) decorative-arm standing rule) ──
     *
     * As authored, this arm was HALF decorative and the half was the
     * interesting one. It patches `packages/domain/src/eligibility/verdict.ts`
     * — SOURCE — and listed two tests. The domain test imports the source and
     * saw the patch; the api convergence test imports `@schedulepoint/domain`,
     * which resolves to `dist/`, and `dist` was never rebuilt. Measured at the
     * integration, with the patch applied and no rebuild:
     *
     *     packages/domain/test/eligibility/verdict.test.ts   3 failed  (observed)
     *     apps/api/test/profiles/verdict-convergence.test.ts 7 PASSED  (blind)
     *
     * So the case reported PROVEN on the domain test alone while listing the
     * convergence proof beside it — asserting a falsifiability that had never
     * been demonstrated. The convergence proof is the whole point of a SHARED
     * verdict, so shrinking the claim would have been the weaker repair.
     *
     * Two changes make both halves real:
     *
     *  1. the violation is spelled COMPILE-CLEAN (`void lifecycle;` rather than
     *     deleting the only read of it). The first spelling left `lifecycle`
     *     unused, so the rebuild below would fail to compile — and a failed
     *     `prepare` makes the runner record the case as NOT PROVEN, which would
     *     have traded a half-decorative arm for a broken one;
     *  2. `prepare` rebuilds `packages/domain` BETWEEN the patch and the red
     *     command, so `dist` carries the violation and the api test can see it.
     *     `restore` rebuilds clean, so no later case inherits a patched `dist`.
     *
     * Verified standalone before the battery: rebuild clean, domain 3 failed,
     * convergence 1 failed — both now observe.
     *
     * ── EXTENDED by OPUS-M4-001R (doc 35 §6b clause 3, FAD-35(c)) ──
     *
     * `granted-while-retiring-inertness.test.ts` is added to both arms. It pins
     * the FAD-28 contract this arm's rule actually supplies: the
     * granted-while-retiring interleaving is ADMITTED at the 0012 trigger, and
     * the holding it produces is inert only because the verdict evaluates the
     * lifecycle first. Remove rule 1 and the raced holding confers again on all
     * three consumers (manual read, publication gate, canonical solver input),
     * so the file fails — verified in both directions standalone before the
     * battery. It is an api-side test, so it depends on the rebuild above. */
    patch: [
      {
        file: 'packages/domain/src/eligibility/verdict.ts',
        find: "  if (lifecycle !== 'active') return 'retired';",
        replace: '  void lifecycle; // red case: the retirement-first rule is removed',
      },
    ],
    greenCommand: [
      'exec',
      'vitest',
      'run',
      'packages/domain/test/eligibility/verdict.test.ts',
      'apps/api/test/profiles/verdict-convergence.test.ts',
      'apps/api/test/profiles/granted-while-retiring-inertness.test.ts',
    ],
    prepare: [['exec', 'tsc', '-b', 'packages/domain', '--force']],
    redCommand: [
      'exec',
      'vitest',
      'run',
      'packages/domain/test/eligibility/verdict.test.ts',
      'apps/api/test/profiles/verdict-convergence.test.ts',
      'apps/api/test/profiles/granted-while-retiring-inertness.test.ts',
    ],
    restore: [['exec', 'tsc', '-b', 'packages/domain', '--force']],
  },
  {
    id: 'enforcement-read-plane',
    gate: 'the publication gate computes on the TRUTH, not the publisher\'s visibility (OPUS-M4-000A)',
    violation: 'the enforcement-read purpose token misspelled, so the gate under-reads holdings',
    // Migration 0012's `qualification_holdings_enforcement_read` policy opens
    // for exactly the span of the verdict computation. With the token wrong,
    // the gate sees a credentialed member as `missing` and refuses a valid
    // publication — `qualification-requirement-gate.test.ts`'s read-plane arm
    // must fail.
    patch: [
      {
        file: 'apps/api/src/schedule/hard-rule-revalidation.ts',
        find:
          "  await sql`select set_config('app.enforcement_read', 'qualification_requirements', true)`.execute(",
        replace:
          "  await sql`select set_config('app.enforcement_read', 'red_case_wrong_token', true)`.execute(",
      },
    ],
    greenCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/schedule/qualification-requirement-gate.test.ts',
    ],
    redCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/schedule/qualification-requirement-gate.test.ts',
    ],
  },
  {
    id: 'work-profile-delete-capability',
    gate: 'a work-profile cancellation is capability-gated at the DATABASE (OPUS-M4-000A C1 / F-1)',
    violation: 'the capability check removed from both 0013 delete guards, leaving futureness alone',
    // The independent review's finding F-1: 0012 narrowed the two work-profile
    // DELETE guards to admit a strictly-future cancellation and granted
    // `app_runtime` the DELETE to carry it, but the narrowed bodies asked only
    // whether the window was future. Migration 0013 adds
    // `app_require_capability('staffing.work_profile.administer', …)` — the
    // same capability `AUTHOR_WORK_PROFILE_CONFIG` makes the cancel route
    // require — to both bodies, AFTER the retention check so 0012's
    // owner-bound `WORK_PROFILE_RETAINED` proof stays observable.
    //
    // The violation is applied to the MIGRATION, and the api project's global
    // setup runs the migration cycle against a freshly initialised cluster on
    // every `vitest run` — so the guards under test are literally the patched
    // ones. With the two `PERFORM` lines gone, an `app_runtime` principal
    // holding no staffing capability deletes a strictly-future row and its
    // weekday target, and the 0013 arms of
    // `apps/api/test/profiles/staffing-integrity-red-cases.test.ts` must fail.
    patch: [
      {
        file: 'apps/api/migrations/0013_work_profile_delete_capability.sql',
        find:
          '    -- F-1, the parent half: cancelling a strictly-future window is a WRITE on\n' +
          '    -- this table and is gated like every other write on it (0004).\n' +
          "    PERFORM app_require_capability('staffing.work_profile.administer', OLD.organization_id);",
        replace: '    -- red case: the parent guard no longer asks the capability question',
      },
      {
        file: 'apps/api/migrations/0013_work_profile_delete_capability.sql',
        find:
          "    -- F-1, the child half: the same gate, on the child's own tenant column.\n" +
          "    PERFORM app_require_capability('staffing.work_profile.administer', OLD.organization_id);",
        replace: '    -- red case: the child guard no longer asks the capability question',
      },
    ],
    greenCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/profiles/staffing-integrity-red-cases.test.ts',
      'apps/api/test/profiles/work-profile-cancellation.test.ts',
    ],
    redCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/profiles/staffing-integrity-red-cases.test.ts',
      'apps/api/test/profiles/work-profile-cancellation.test.ts',
    ],
  },
  {
    id: 'requires-expiry-flip-serialization',
    gate: 'the requires_expiry flip is SERIALIZED against an in-flight grant (OPUS-M4-001S / FAD-36(2))',
    violation: 'migration 0017 reverted to the 0012 bodies — both locking clauses removed',
    /* The M4-001R review's finding R-1, reproduced as probe D3: under READ
     * COMMITTED a `requires_expiry` flip committing beside an in-flight
     * open-ended grant produced `requires_expiry = true` with an open-ended live
     * holding — the exact state FAD-28 R5's sequential trigger refuses with
     * 23001, and the one state with NO read-side backstop (`requires_expiry` is
     * not an input to the shared verdict, so the race-admitted holding reads
     * `satisfied` for ever, including in canonical solver input).
     *
     * Migration 0017 closes it with one lock object in two conflicting modes:
     * the holding guard reads the qualification FOR KEY SHARE, the flip guard
     * takes FOR UPDATE before it looks for open-ended holdings. The violation
     * removes exactly those two clauses, which restores 0012's bodies verbatim
     * — so the case asks the only question worth asking: is the locking what
     * refuses, or was the refusal coming from somewhere else all along?
     *
     * The violation is applied to the MIGRATION, and the api project's global
     * setup runs the migration cycle against a freshly initialised cluster on
     * every `vitest run` — so the guards under test are literally the patched
     * ones, with no rebuild needed (FAD-33(1) is satisfied by the schema being
     * re-derived, not by a `dist`). Both listed files then fail: the
     * serialization proof's (A) and (B) admit the forbidden final state, and the
     * populated-cycle file's post-re-up arm no longer blocks or refuses. */
    patch: [
      {
        file: 'apps/api/migrations/0017_requires_expiry_flip_serialization.sql',
        find: '     WHERE q.id = NEW.qualification_id\n       FOR KEY SHARE;',
        replace: '     WHERE q.id = NEW.qualification_id; -- red case: the read is unlocked again',
      },
      {
        file: 'apps/api/migrations/0017_requires_expiry_flip_serialization.sql',
        find: '        PERFORM 1 FROM qualifications WHERE id = OLD.id FOR UPDATE;',
        replace: '        -- red case: the flip no longer waits for an in-flight grant',
      },
    ],
    greenCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/profiles/requires-expiry-flip-serialization.test.ts',
      'apps/api/test/profiles/migration-0017-populated-cycle.test.ts',
    ],
    redCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/profiles/requires-expiry-flip-serialization.test.ts',
      'apps/api/test/profiles/migration-0017-populated-cycle.test.ts',
    ],
  },
  {
    id: 'graph-participant-fk',
    gate: 'the schedule participant belongs to the group (OPUS-M4-000B, doc 34 §4-C)',
    violation: 'the composite participant FK removed from migration 0014',
    /* Migration 0014 proves at the DATABASE that a snapshot's membership is a
     * member of the snapshot's own group. The api project's global setup runs
     * the migration cycle against a freshly initialised cluster on every
     * `vitest run`, so patching the migration file is patching the schema the
     * probes actually meet.
     *
     * The trigger is left in place deliberately: `graph-invariants.test.ts` has
     * an arm that suspends the trigger and requires the FK to refuse on its own,
     * and THAT arm is what this red case falsifies. With the FK gone, the
     * trigger still catches the ordinary path and every other test stays green —
     * which is exactly how a decorative FK ships. */
    patch: [
      {
        file: 'apps/api/migrations/0014_schedule_graph_locations_time.sql',
        find:
          'ALTER TABLE assignment_snapshots\n' +
          '    ADD CONSTRAINT assignment_snapshots_participant_in_group_fk\n' +
          '        FOREIGN KEY (membership_id, organization_id, group_id)\n' +
          '        REFERENCES memberships (id, organization_id, group_id);',
        replace: '-- red case: the composite participant FK is not created',
      },
    ],
    greenCommand: ['exec', 'vitest', 'run', 'apps/api/test/schedule/graph-invariants.test.ts'],
    redCommand: ['exec', 'vitest', 'run', 'apps/api/test/schedule/graph-invariants.test.ts'],
  },
  {
    id: 'graph-reality-deferred-guard',
    gate: 'reality names only the CURRENT published version (V-15c arm, OPUS-M4-000B)',
    violation: 'the DEFERRED constraint trigger removed, so a retired version can orphan its rows',
    // V-15c proved the EQUALITY by reading both sides. 0014 adds the control:
    // a transaction that retires a current version while its reality rows
    // survive fails at COMMIT. Without the trigger the orphaning UPDATE is
    // accepted and the drift is real.
    patch: [
      {
        file: 'apps/api/migrations/0014_schedule_graph_locations_time.sql',
        find:
          'CREATE CONSTRAINT TRIGGER schedule_versions_reality_retired_guard\n' +
          '    AFTER UPDATE ON schedule_versions\n' +
          '    DEFERRABLE INITIALLY DEFERRED\n' +
          '    FOR EACH ROW\n' +
          '    WHEN (OLD.is_current AND NOT NEW.is_current)\n' +
          '    EXECUTE FUNCTION app_guard_retired_version_has_no_reality();',
        replace: '-- red case: the deferred reality guard is never attached',
      },
    ],
    greenCommand: ['exec', 'vitest', 'run', 'apps/api/test/schedule/graph-invariants.test.ts'],
    redCommand: ['exec', 'vitest', 'run', 'apps/api/test/schedule/graph-invariants.test.ts'],
  },
  {
    id: 'location-archived-guard',
    gate: 'an archived location takes no NEW shift reference (OPUS-M4-000B, doc 34 §4-F)',
    violation: 'the archived-location refusal removed from the 0014 shift guard',
    // Archiving must refuse NEW references while RETAINING existing ones. With
    // the refusal gone, a decommissioned place keeps accumulating rota and the
    // retention half still passes — so only the refusal arm can catch this.
    patch: [
      {
        file: 'apps/api/migrations/0014_schedule_graph_locations_time.sql',
        find:
          "        IF v_location_state <> 'active' THEN\n" +
          '            RAISE EXCEPTION\n' +
          "                'SCHEDULE_SHIFT_LOCATION_ARCHIVED: location % is archived and cannot take a NEW '\n" +
          "                'shift reference; existing references are retained (doc 34 §4-F)', NEW.location_id\n" +
          "                USING ERRCODE = 'restrict_violation';\n" +
          '        END IF;',
        replace: '        -- red case: an archived location accepts new shift references',
      },
    ],
    greenCommand: ['exec', 'vitest', 'run', 'apps/api/test/schedule/locations.test.ts'],
    redCommand: ['exec', 'vitest', 'run', 'apps/api/test/schedule/locations.test.ts'],
  },
  {
    id: 'timezone-basis-stale-gate',
    gate: 'a stale timezone basis refuses publication (OPUS-M4-000B, doc 34 §4-F)',
    violation: 'the publication-time basis check removed',
    // Without it, a group timezone change silently re-times every unpublished
    // draft and they publish with instants nobody authored. The staleness is
    // still REPORTED by the settings surface, so a suite that only checked the
    // report would stay green — the refusal arm is what this falsifies.
    patch: [
      {
        file: 'apps/api/src/schedule/publication.ts',
        find: '  const timezoneState = await assertTimezoneBasisFresh(uow, input.versionId);',
        replace:
          '  const timezoneState = await timezoneBasisState(uow, input.versionId); // red case: no refusal',
      },
      {
        file: 'apps/api/src/schedule/publication.ts',
        find: "import { assertTimezoneBasisFresh } from './timezone.js';",
        replace: "import { timezoneBasisState } from './timezone.js';",
      },
    ],
    greenCommand: ['exec', 'vitest', 'run', 'apps/api/test/schedule/timezone-basis.test.ts'],
    redCommand: ['exec', 'vitest', 'run', 'apps/api/test/schedule/timezone-basis.test.ts'],
  },
  {
    id: 'dst-fold-resolution',
    gate: 'R-B5 — a DST fold has TWO occurrences and the role picks one (OPUS-M4-000B)',
    violation: 'the fold restored to the naive single-probe resolution',
    /* The implementation the authoring route used before this packet. It is
     * wrong in exactly one way — both of its probes land on the same offset on a
     * fall-back day, so the second occurrence of the repeated hour is invisible
     * and "ambiguous" and "unique" become the same answer. Restoring it must
     * fail the domain rulings AND the route-level assertions, which is what
     * proves those assertions are about the fold and not about arithmetic in
     * general. */
    patch: [
      {
        file: 'packages/domain/src/time/zoned-time.ts',
        find:
          '  const probeBefore = offsetMillisAt(zone, new Date(nominal - MS_PER_DAY));\n' +
          '  const probeAfter = offsetMillisAt(zone, new Date(nominal + MS_PER_DAY));',
        replace:
          '  // red case: the naive single-probe resolution, which cannot see a fold\n' +
          '  const probeBefore = offsetMillisAt(zone, new Date(nominal));\n' +
          '  const probeAfter = offsetMillisAt(zone, new Date(nominal - probeBefore));',
      },
    ],
    /* The DOMAIN test only, and deliberately not the api one.
     *
     * `apps/api/test/schedule/authoring-time.test.ts` asserts the same two
     * rulings at the route surface and is genuinely valuable — but it reaches
     * `@schedulepoint/domain` through the package's `exports` entry, which is
     * `dist/`, and this runner patches SOURCE with no build in between. Listing
     * it here would add a file that CANNOT observe the violation, which reads as
     * corroboration and is not. (This is the same mechanism that left
     * `calendar-date-shape-only` NOT PROVEN on its first run; the fix there was
     * the same — point the arm at a test that imports the patched source.)
     *
     * `packages/domain/test/time/zoned-time.test.ts` imports
     * `../../src/time/index.js`, source-relative inside its own package, so the
     * patch is the code that runs. */
    greenCommand: ['exec', 'vitest', 'run', 'packages/domain/test/time/zoned-time.test.ts'],
    redCommand: ['exec', 'vitest', 'run', 'packages/domain/test/time/zoned-time.test.ts'],
  },
  {
    id: 'calendar-date-shape-only',
    gate: 'dates are REAL calendar dates on the wire (OPUS-M4-000B, doc 34 §4-F)',
    violation: 'the contract validator restored to the shape-only regex',
    // The exact code this packet replaces. A shape-only rule accepts
    // 2027-02-29 and 2027-13-01, and `Date.UTC` then rolls them over silently.
    // The agreement sweep is what catches the divergence.
    patch: [
      {
        file: 'packages/contracts/src/schedule/calendar-date.ts',
        find: "  .refine(isCalendarDate, 'that date does not exist in the calendar');",
        replace: '  ; // red case: the calendar refinement is removed, leaving shape only',
      },
    ],
    /* TARGETED AT THE CONTRACTS PACKAGE'S OWN TEST, and that is the whole
     * repair.
     *
     * The first version of this arm ran `apps/api/test/schedule/
     * calendar-agreement.test.ts`, and it was NOT PROVEN: the arm passed with
     * the violation in the tree. The cause was measured, not guessed —
     * `apps/api` resolves `@schedulepoint/contracts` through the package's
     * `exports` entry, which is `dist/`, and this runner patches SOURCE and
     * invokes vitest with no build in between. So the api test imported the
     * unpatched build and the violation never reached the code under test.
     * Patching source and rebuilding first turned that same file red
     * immediately, which is what proves the CONTROL was never the problem.
     *
     * `packages/contracts/test/schedule/calendar-date.test.ts` imports
     * `../../src/schedule/calendar-date.js` — source-relative, inside its own
     * package — so the patch is the code that runs. One layer, the wire
     * validator, whose loss is precisely the defect this case exists to catch.
     *
     * The agreement sweep keeps its own job (comparing what SHIPS, dist against
     * dist) and the DATABASE half is asserted separately in the same file. */
    greenCommand: [
      'exec',
      'vitest',
      'run',
      'packages/contracts/test/schedule/calendar-date.test.ts',
    ],
    redCommand: [
      'exec',
      'vitest',
      'run',
      'packages/contracts/test/schedule/calendar-date.test.ts',
    ],
  },
  {
    id: 'membership-state-gate',
    gate: 'only an ACTIVE membership is a new assignment target (R-B1, OPUS-M4-000B)',
    violation: 'the active-membership refusal removed from the 0014 snapshot guard',
    // The service check is left in place on purpose: it produces the readable
    // error and would keep the ordinary path green. The DATABASE arm of
    // `membership-semantics.test.ts` — raw SQL as app_runtime — is what this
    // falsifies, which is the arm that matters for an invariant.
    patch: [
      {
        file: 'apps/api/migrations/0014_schedule_graph_locations_time.sql',
        find:
          '        -- R-B1.\n' +
          "        IF v_status <> 'active' THEN",
        replace: "        -- red case: the active-membership rule is removed\n        IF false THEN",
      },
    ],
    greenCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/schedule/membership-semantics.test.ts',
    ],
    redCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/schedule/membership-semantics.test.ts',
    ],
  },

  /* ── OPUS-M4-001 — the solver runtime boundary (doc 35 §6a) ────────────────
   *
   * Five cases. The first is the STATIC gate extended to the real solver port —
   * 000C built the boundary before any provider existed, and this is the first
   * time the gate's population is the thing it was built for rather than a
   * probe. The rest attack the controls the packet's test row names, and each
   * one is chosen so that **only the intended assertion fails**: a violation
   * that breaks everything proves nothing about which control was load-bearing.
   * ────────────────────────────────────────────────────────────────────────── */
  {
    id: 'solver-provider-in-transaction',
    gate: 'the SOLVER port is refused inside a unit of work (SPEC-12 U-07, statically)',
    violation: 'the solver dispatch moved INSIDE the assembly transaction in build-input.ts',
    /* `build-input.ts` is the one place the two phases meet, and the seam is a
     * line: assemble inside `runner.run(...)`, dispatch after it returns. Moving
     * the dispatch into the callback is the exact defect SPEC-12 U-07 exists to
     * prevent — a ninety-second solve holding a period-wide lock — and it is the
     * shape the static gate CAN see, which is why it is the gate's arm.
     *
     * The runtime arm has its own proof (`provider-boundary-solver.test.ts`
     * refuses a deferred call the scan cannot follow) and its own mutation
     * control, so the two halves are falsified independently. */
    patch: [
      {
        file: 'apps/api/src/solver/build-input.ts',
        find:
          '  const snapshot = await createBuildInput(runner, context, options);\n' +
          '  const outcome = await dispatchBuild(context, snapshot, options);',
        replace:
          '  const snapshot = await runner.run(context, async () => {\n' +
          '    const inner = await createBuildInput(runner, context, options);\n' +
          '    await solveOnWorker(\n' +
          '      {\n' +
          '        protocolVersion: 1,\n' +
          '        organizationId: context.organizationId,\n' +
          "        groupId: context.groupId ?? '',\n" +
          '        buildRunId: options.buildRunId,\n' +
          '        correlationId: context.correlationId,\n' +
          '        snapshotId: inner.snapshotId,\n' +
          '        canonicalInputHash: inner.canonicalInputHash,\n' +
          '        snapshotPayload: inner.document,\n' +
          '        parameters: options.parameters,\n' +
          '      },\n' +
          '      options,\n' +
          '    );\n' +
          '    return inner;\n' +
          '  });\n' +
          '  const outcome = await dispatchBuild(context, snapshot, options);',
      },
    ],
    greenCommand: ['run', 'gate:provider-boundary'],
    redCommand: ['run', 'gate:provider-boundary'],
  },
  {
    id: 'solver-snapshot-immutability',
    gate: 'a solver input snapshot cannot be rewritten by ANYONE (0016, doc 35 §6a)',
    violation: 'the append-only guard never attached, and UPDATE granted to the runtime roles',
    /* Both halves at once, deliberately. The packet asks for "no runtime UPDATE/
     * DELETE grant **and** a guard trigger", and removing only one of them would
     * leave the other still refusing — the case would go red for the wrong
     * reason and would say nothing about whether both controls are load-bearing.
     *
     * The api project's global setup runs the migration cycle against a freshly
     * initialised cluster on every `vitest run`, so patching the migration file
     * patches the schema the probes actually meet. */
    patch: [
      {
        file: 'apps/api/migrations/0016_solver_input_snapshots.sql',
        find:
          'CREATE TRIGGER solver_input_snapshots_append_only\n' +
          '    BEFORE UPDATE OR DELETE ON solver_input_snapshots\n' +
          '    FOR EACH ROW EXECUTE FUNCTION app_guard_append_only();',
        replace: '-- red case: the append-only guard is never attached',
      },
      {
        file: 'apps/api/migrations/0016_solver_input_snapshots.sql',
        find: 'GRANT SELECT, INSERT ON solver_input_snapshots TO app_runtime, app_worker;',
        replace:
          'GRANT SELECT, INSERT, UPDATE, DELETE ON solver_input_snapshots TO app_runtime, app_worker;',
      },
    ],
    greenCommand: ['exec', 'vitest', 'run', 'apps/api/test/solver/snapshot-immutability.test.ts'],
    redCommand: ['exec', 'vitest', 'run', 'apps/api/test/solver/snapshot-immutability.test.ts'],
  },
  {
    id: 'solver-outcome-honesty',
    gate: 'a cancelled solve is CANCELLED, never a misreported timeout (EV-M0-SPC H-6)',
    violation: 'the status/termination honesty rule always agrees',
    /* The most consequential control in the boundary, and the one a reviewer
     * would most expect to be decorative. Every other refusal protects the
     * process; this one protects the scheduler's judgement — a worker reporting
     * `CANCELLED` with reason `deadline` is not malformed, it is a *plausible
     * lie*, and a scheduler told their cancel timed out raises the budget.
     *
     * With the rule always true, the ten impossible pairs are accepted and the
     * hostile `dishonest` worker's response is believed. */
    patch: [
      {
        file: 'packages/domain/src/ports/solver-port.ts',
        find:
          'export function isTerminalOutcomeHonest(\n' +
          '  status: SolverStatus,\n' +
          '  reason: TerminationReason,\n' +
          '): boolean {\n' +
          '  switch (status) {',
        replace:
          'export function isTerminalOutcomeHonest(\n' +
          '  status: SolverStatus,\n' +
          '  reason: TerminationReason,\n' +
          '): boolean {\n' +
          '  if (String(status) !== String(reason)) return true; // red case\n' +
          '  switch (status) {',
      },
    ],
    /* The domain is consumed from `dist/`, so the patched source must be BUILT
     * before the arm runs — the rebuild-between-patch-and-run lesson 000C's
     * composition recorded. Both arms build, so the GREEN arm is equally honest. */
    greenCommand: [
      'exec',
      'sh',
      '-c',
      'tsc -b packages/domain && vitest run apps/api/test/solver/response-refusals.test.ts',
    ],
    redCommand: [
      'exec',
      'sh',
      '-c',
      'tsc -b packages/domain && vitest run apps/api/test/solver/response-refusals.test.ts',
    ],
    /* Reverting the SOURCE is not enough: the RED arm compiled the violation
     * into `packages/domain/dist`, which every later case consumes. Without this
     * the patched decision would survive the revert and silently weaken the rest
     * of the run — a red case leaving a live violation behind is strictly worse
     * than no red case. */
    restore: [['exec', 'tsc', '-b', 'packages/domain', '--force']],
  },
  {
    id: 'solver-rpc-request-auth',
    gate: 'the WORKER refuses a request it cannot authenticate (SPEC-04 §1.1)',
    violation: 'the request MAC comparison removed from the Python worker',
    /* SPEC-04 §1.1 requires mutual authentication and that "the worker rejects
     * unauthenticated requests". Without the comparison, anyone who can reach
     * the channel can spend a solve or feed one a problem — and every other
     * solver proof stays green, because they all sign correctly. */
    /* RE-ANCHORED after the B-1 repair. The arm used to neuter
     * `sign(request, secret, response=False)` — a function that no longer
     * exists, because the MAC now covers the received BYTES rather than a
     * re-derived canonical form. The violation must remove the equivalent check
     * in the NEW code or the arm stops proving what its name says, so it now
     * neuters the raw-byte comparison itself. */
    patch: [
      {
        file: 'solver/schedulepoint_solver/auth.py',
        find:
          '    if not hmac.compare_digest(expected, presented):\n'
          + '        raise AuthenticationError()\n'
          + '    return envelope',
        replace: '    # red case: the request MAC is computed and never compared\n    return envelope',
      },
    ],
    greenCommand: ['exec', 'vitest', 'run', 'apps/api/test/solver/rpc-auth.test.ts'],
    redCommand: ['exec', 'vitest', 'run', 'apps/api/test/solver/rpc-auth.test.ts'],
  },
  {
    id: 'solver-response-auth',
    gate: 'the PLATFORM refuses a response it cannot authenticate (SPEC-04 §1.1)',
    violation: 'the response MAC verification always agrees',
    /* The other direction, and the one a bearer token would never have had. A
     * substituted worker answers and its schedule is believed; a captured
     * response is replayed against a later solve of the same problem, where the
     * canonical input hash matches and nothing else notices. */
    /* RE-ANCHORED after the B-1 repair, same reason: `verifyResponse` became
     * `verifyResponseFrame` and now compares a MAC over the received body bytes.
     * Neutering the final comparison keeps every shape check in place — so the
     * arm falsifies the AUTHENTICATION specifically, not the parsing around it. */
    patch: [
      {
        file: 'apps/api/src/solver/rpc-envelope.ts',
        find:
          "  return timingSafeEqual(Buffer.from(presented, 'utf8'), Buffer.from(expected, 'utf8'));",
        replace:
          '  return expected.length > 0; // red case: the response MAC is computed and never compared',
      },
    ],
    greenCommand: ['exec', 'vitest', 'run', 'apps/api/test/solver/rpc-auth.test.ts'],
    redCommand: ['exec', 'vitest', 'run', 'apps/api/test/solver/rpc-auth.test.ts'],
  },
  {
    id: 'solver-model-constraint-dropped',
    gate: 'the independent checker catches a MODEL that lost a constraint (SPEC-04 §3.3)',
    violation: 'the linkage constraint family dropped from the CP-SAT model builder',
    /* THE INDEPENDENCE CASE (OPUS-M4-002, doc 35 §6d).
     *
     * `corpus-agreement` asserts the solver and the checker AGREE. Necessary,
     * and not sufficient: two implementations that share a defect agree
     * perfectly. What must be shown is that the checker would DISAGREE if the
     * model were wrong, and the only honest way to show it is to make the model
     * wrong.
     *
     * The violation drops the whole linkage family — `LinkedShifts`,
     * `ImpliesAssignment`, `MutuallyExclusive` — from the model builder alone.
     * The checker is untouched, which is the point: it is TypeScript over
     * finished rows and shares no line with the Python that built the model.
     *
     * `B-infeasible-contradictory-rules` then becomes solvable, and EVERY
     * solution to it breaches one of its two rules by construction: any
     * candidate places `AUX` somewhere, and that membership either also has
     * `EVE` on that date (breaching the exclusion) or does not (breaching the
     * implication). So the catch does not depend on which solution CP-SAT
     * finds — it is certain, not likely.
     *
     * Python, so no rebuild is needed between the patch and the run. */
    patch: [
      {
        file: 'solver/schedulepoint_solver/cpsat_adapter.py',
        find:
          '    if kind in ("LinkedShifts", "ImpliesAssignment", "MutuallyExclusive"):\n' +
          '        if kind == "ImpliesAssignment":',
        replace:
          '    if kind in ("LinkedShifts", "ImpliesAssignment", "MutuallyExclusive"):\n' +
          '        return  # red case: the linkage constraint family is dropped\n' +
          '        if kind == "ImpliesAssignment":',
      },
    ],
    greenCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/solver/model-independence.test.ts',
      'apps/api/test/solver/corpus/corpus-agreement.test.ts',
    ],
    redCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/solver/model-independence.test.ts',
      'apps/api/test/solver/corpus/corpus-agreement.test.ts',
    ],
  },
  {
    id: 'solver-checker-disabled',
    gate: 'the independent checker is LOAD-BEARING (SPEC-04 §3.3, FAD-33(1))',
    violation: 'the LinkedShifts arm of the linkage checker never reports a breach',
    /* The inverse of the case above, and the reason both are needed: a checker
     * that never disagrees is decorative, and it looks exactly like a checker
     * that agrees.
     *
     * `LinkedShifts` is the kind chosen because a lone `EVE` row in the
     * rule-heavy fixture breaches NOTHING else — no rest pair, no coverage
     * ceiling, no adjacency. Disabling `MutuallyExclusive` instead would have
     * been caught incidentally by `MinimumRestBetween`, and the arm would have
     * reported PROVEN while proving something else.
     *
     * Compile-clean, on the retired-verdict lesson: `present` is still read by
     * the detail string, so the rebuild below succeeds and the api-side test
     * genuinely observes the patched `dist`. */
    patch: [
      {
        file: 'packages/domain/src/rules/hard-rule-check.ts',
        find: '        breached = present.length > 0 && present.length < names.length;',
        replace: '        breached = false; // red case: the LinkedShifts arm never breaches',
      },
    ],
    greenCommand: [
      'exec',
      'vitest',
      'run',
      'packages/domain/test/rules/ruled-kinds.test.ts',
      'apps/api/test/solver/incorrect-worker-output.test.ts',
    ],
    /* `dist` carries the violation, or the api-side arm is blind to it. */
    prepare: [['exec', 'tsc', '-b', 'packages/domain', '--force']],
    redCommand: [
      'exec',
      'vitest',
      'run',
      'packages/domain/test/rules/ruled-kinds.test.ts',
      'apps/api/test/solver/incorrect-worker-output.test.ts',
    ],
    restore: [['exec', 'tsc', '-b', 'packages/domain', '--force']],
  },
  {
    id: 'solver-fail-closed-kind-skipped',
    gate: 'a later-milestone HARD kind can NEVER be silently ignored (FAD-27, SPEC-04 §3.3)',
    violation: 'the owner block removed, the kind admitted, and the unmapped fall-through silenced',
    /* SPEC-04 §3.3 is absolute: a HARD rule is never "relaxed, downgraded,
     * weighted, or skipped by any code path". `LocumRestriction` has no input in
     * the canonical snapshot — the locum slice owns it — so the worker refuses
     * to model the problem at all rather than solving it without the rule.
     *
     * Making that silently ignorable takes THREE removals, and that is the
     * finding rather than an inconvenience: the fail-closed property is enforced
     * at three independent points, and the arm has to defeat all of them to
     * show a silent skip. Any two left standing still refuse.
     *
     *   1. the FAD-27 owner block in `check_modellable`;
     *   2. the "HARD kind with no constraint mapping" refusal, defeated by
     *      admitting the kind into `HARD_KINDS`;
     *   3. the fall-through `raise` at the end of `_hard`, which catches a kind
     *      that is declared modellable and then has no branch.
     *
     * With all three gone `B-locum-shaped` SOLVES — a build produced while an
     * active HARD rule was ignored — and `corpus-agreement` fails on it. */
    patch: [
      {
        file: 'solver/schedulepoint_solver/model.py',
        find: '    if kind in FAIL_CLOSED_OWNERS:\n        raise ModelError(',
        replace: '    if False:  # red case: the FAD-27 owner block is removed\n        raise ModelError(',
      },
      {
        file: 'solver/schedulepoint_solver/model.py',
        find: 'HARD_KINDS = (\n    "RequiredCount",',
        replace: 'HARD_KINDS = (\n    "LocumRestriction",  # red case: a later-milestone kind admitted\n    "RequiredCount",',
      },
      {
        file: 'solver/schedulepoint_solver/cpsat_adapter.py',
        find:
          '    raise M.ModelError(\n' +
          '        "rule_kind_not_modelled",\n' +
          '        "rule %s of kind %s reached the model with no branch" % (rule_key, kind),\n' +
          '    )',
        replace: '    return  # red case: an unmapped kind is silently ignored',
      },
    ],
    greenCommand: ['exec', 'vitest', 'run', 'apps/api/test/solver/corpus/corpus-agreement.test.ts'],
    redCommand: ['exec', 'vitest', 'run', 'apps/api/test/solver/corpus/corpus-agreement.test.ts'],
  },
  {
    id: 'request-budget-over',
    gate: 'requests per interaction (SP-HR-2)',
    violation: 'one click recorded as three requests, against a budget of one',
    greenCommand: ['run', 'gate:request-budget'],
    redCommand: [
      'exec',
      'node',
      'scripts/gates/request-budget.mjs',
      '--dir',
      'scripts/red-cases/request-budget/fixture',
    ],
  },
  {
    id: 'request-budget-missing',
    gate: 'requests per interaction (SP-HR-2) — missing measurement',
    violation: 'a budgeted interaction with no recording at all',
    greenCommand: ['run', 'gate:request-budget'],
    redCommand: [
      'exec',
      'node',
      'scripts/gates/request-budget.mjs',
      '--dir',
      'scripts/red-cases/request-budget-missing/fixture',
    ],
  },
  {
    id: 'builds-fencing-trigger',
    gate: 'build result fencing (doc 35 §6e (3)) — the DATABASE arm',
    violation: 'the fencing trigger neutered, so only the service check is left',
    /* THE FALSIFIABILITY CASE for the fence, and the one that matters.
     *
     * The service refuses a stale-epoch result first, and it should — a route
     * needs a typed error and a refused worker needs a recorded reason. But a
     * worker writing through ANY other path meets only the trigger: a psql
     * session, a repair script, an ORM write, a future service that forgets.
     * A trigger that has only ever been observed passing is not evidence.
     *
     * This makes `app_guard_build_result_fencing` return `NEW` unconditionally —
     * leaving the service check, the epoch column and every other constraint
     * intact — and `apps/api/test/builds/lifecycle.test.ts`'s arm "the DATABASE
     * refuses a stale-epoch result row with the service bypassed entirely" must
     * go red. If it does not, its refusal was coming from something else and the
     * trigger is decorative.
     *
     * FAD-33(1) is satisfied structurally rather than by rebuilding: the patched
     * file is a MIGRATION, applied by `globalSetup`'s up -> down -> up before
     * every run, so the patched SQL is what the assertions meet. There is no
     * `dist/` in the path at all. */
    patch: [
      {
        file: 'apps/api/migrations/0018_build_lifecycle.sql',
        find: "    IF NEW.claim_epoch <> v_epoch THEN",
        replace: "    IF false THEN -- red case: the fence is neutered",
      },
    ],
    greenCommand: ['run', 'gate:unit:builds'],
    redCommand: ['run', 'gate:unit:builds'],
  },
  {
    id: 'builds-validation-gate',
    gate: 'no hard-violating candidate reaches `approved` (doc 35 §6e (4), FAD-27)',
    violation: 'the approve guard no longer counts unresolved hard findings',
    /* The gate the whole lifecycle exists to protect. `reviewed -> approved`
     * requires zero unresolved hard findings, and the count is taken in the
     * DATABASE precisely so that a caller who lies about a candidate's usability
     * — a translation defect, a hand-built response, a compromised worker — is
     * refused anyway.
     *
     * This removes the count and leaves everything else standing, so
     * `apps/api/test/builds/lifecycle.test.ts`'s arm "a hard-violating candidate
     * can NEVER reach approved, even claimed usable" must go red. Its own
     * MUTATION CONTROL (the identical flow with the finding removed, which must
     * stay green) is what proves the arm is not passing for some other reason;
     * this proves the arm is not passing because nothing was ever checked. */
    patch: [
      {
        file: 'apps/api/migrations/0018_build_lifecycle.sql',
        find: "        IF v_blocking > 0 THEN",
        replace: "        IF false THEN -- red case: the validation gate is neutered",
      },
    ],
    greenCommand: ['run', 'gate:unit:builds'],
    redCommand: ['run', 'gate:unit:builds'],
  },
  {
    id: 'builds-transition-guard',
    gate: 'illegal build transitions refused at the DATABASE (doc 35 §6e (1))',
    violation: 'the transition guard admits every edge',
    /* The service refuses an illegal edge with a typed error a route can map.
     * The database refuses it for every writer including a psql session, and the
     * whole reason the rule is written twice is that the second spelling is the
     * one that still holds when somebody writes a repair script.
     *
     * This makes `app_build_run_transition_is_legal` return `true` for every
     * ordered pair. Two things must then go red, and both are asserted:
     * `transition-matrix.test.ts`'s 256-pair agreement check (the two spellings
     * have drifted) and `lifecycle.test.ts`'s raw-SQL arm (the database no
     * longer refuses `draft_configuration -> approved`). */
    patch: [
      {
        file: 'apps/api/migrations/0018_build_lifecycle.sql',
        find: "    SELECT\n        -- report 21 §4, edge for edge.",
        replace: "    SELECT true OR -- red case: every edge is admitted\n        -- report 21 §4, edge for edge.",
      },
    ],
    greenCommand: ['run', 'gate:unit:builds'],
    redCommand: ['run', 'gate:unit:builds'],
  },
  {
    id: 'raw-nul-scan',
    gate: 'raw U+0000 scan (FAD-45(1))',
    violation: 'a raw NUL byte reintroduced into a source file',
    /* The gate mandated after the THIRD recurrence of this class. Its whole
     * value is that it fires on a byte no reviewer can see, so a green run tells
     * you nothing on its own — this is what tells you it can fail at all.
     *
     * The violation is spelled with `\u0000` in THIS file so that `run.mjs`
     * itself stays clean: the patch writes a real zero byte into the target, the
     * gate finds it, and the revert removes it. A red case that had to carry the
     * defect it tests would be caught by the gate it is testing. */
    patch: [
      {
        file: 'apps/api/src/builds/readiness.ts',
        find: 'const findings: BuildFinding[] = [];',
        replace: `const findings: BuildFinding[] = []; // red case:\u0000raw NUL`,
      },
    ],
    greenCommand: ['run', 'gate:raw-nul'],
    redCommand: ['run', 'gate:raw-nul'],
  },
  {
    id: 'builds-fencing-state-clause',
    gate: 'build result fencing — the SETTLED-RUN clause (FAD-45(3), review R-3)',
    violation: 'the fencing trigger no longer checks that the run is still running',
    /* THE reviewer's serious one, and the arm the first round did not have.
     *
     * `app_guard_build_result_fencing` refuses on two conditions, and they catch
     * different attacks. The EPOCH clause catches a worker whose claim was
     * superseded. The STATE clause is the sole refusal for a different and worse
     * case: injecting candidate rows, violations or a result into a run that has
     * already SETTLED — a `failed` build acquiring a usable candidate, or an
     * `approved` one acquiring extra assignments after the gate that checked it.
     * The epoch would still match, because nothing about settling changes it.
     *
     * This neuters ONLY the state clause and leaves the epoch clause standing,
     * so the arm cannot pass on the other one's behalf. */
    patch: [
      {
        file: 'apps/api/migrations/0018_build_lifecycle.sql',
        find: "    IF v_state <> 'running' THEN",
        replace: '    IF false THEN -- red case: the settled-run clause is neutered',
      },
    ],
    greenCommand: ['run', 'gate:unit:builds'],
    redCommand: ['run', 'gate:unit:builds'],
  },

  /* ──────────────────────────────────────────────────────────────────────────
   * OPUS-M4-004 — E2. Four arms, each falsifying one claim the packet makes.
   *
   * All four patch either the Python worker or the TypeScript SOURCE that the
   * api-side tests resolve through `dist/`. The Python ones need no rebuild
   * (the interpreter reads the file); the domain one carries the
   * `prepare`/`restore` rebuild pair for the reason the `retired-verdict` arm
   * records in full — without it the api-side test observes the OLD `dist` and
   * the arm reads PROVEN while proving nothing.
   * ────────────────────────────────────────────────────────────────────────── */
  {
    id: 'solver-objective-scale-drift',
    gate: 'the integer scaling factor is SINGLE-SOURCED (doc 08 §3.4, doc 35 §6f)',
    violation: 'the worker scales weights by 10^3 while the platform scales by 10^4',
    /* The packet's scaling-constant mutation, in its purest form: change the
     * factor in ONE place. Nothing about the resulting build looks wrong — the
     * solver still solves, the schedule is still valid, the objective value is
     * simply a tenth of what every other result recorded, and it would sit in a
     * comparison column beside them looking comparable.
     *
     * Two independent things catch it, and the arm runs both: the digest the
     * worker echoes stops matching (every solve refuses at the boundary), and
     * the Python↔TypeScript parity test compares the rendered profiles
     * directly. Either alone would be enough; having both is what makes the
     * single-sourcing a property rather than a convention. */
    patch: [
      {
        file: 'solver/schedulepoint_solver/model.py',
        find: 'OBJECTIVE_SCALE = 10000',
        replace: 'OBJECTIVE_SCALE = 1000  # red case: the factor drifts on one side only',
      },
    ],
    greenCommand: ['exec', 'vitest', 'run', 'apps/api/test/solver/e2-objective.test.ts'],
    redCommand: ['exec', 'vitest', 'run', 'apps/api/test/solver/e2-objective.test.ts'],
  },
  {
    id: 'solver-t2-false-minimality',
    gate: 'EXPLAINED_MINIMAL is EARNED (SPEC-04 §5, doc 35 §6f behaviour 3)',
    violation: 'the T2 loop reports a completed pass without running one',
    /* The minimality-claim mutation. `_minimise` returns `minimal = True` from
     * its first line, so every T1 subset is relabelled minimal — the strongest
     * thing an explanation can say, applied to a set nobody narrowed.
     *
     * A scheduler who acts on a false minimality claim relaxes a rule for
     * nothing and is left with an infeasible period and less protection than
     * they started with. That is why the claim is checked on BOTH sides: the
     * loop must earn it, and `readExplanation` downgrades it if the record does
     * not support it — so the violation has to defeat both, and it does not.
     *
     * The `iterations` counter stays 0 under the patch, which is exactly what
     * the corpus arm and the E2 proof assert against. */
    patch: [
      {
        file: 'solver/schedulepoint_solver/cpsat_adapter.py',
        find: '    remaining = list(subset)\n    iterations = 0',
        replace:
          '    return True, list(subset), 0, 0, 0  # red case: minimality claimed, never established\n'
          + '    remaining = list(subset)\n    iterations = 0',
      },
    ],
    greenCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/solver/e2-objective.test.ts',
      'apps/api/test/solver/corpus/corpus-agreement.test.ts',
    ],
    redCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/solver/e2-objective.test.ts',
      'apps/api/test/solver/corpus/corpus-agreement.test.ts',
    ],
  },
  {
    id: 'solver-progressive-pin-unfixed',
    gate: 'a protected assignment is HARD-FIXED in the model (doc 08 §5, SBX-017)',
    violation: 'the model stops fixing pinned fixed inputs to 1',
    /* SBX-017: protected assignments are "preserved **exactly** — not
     * approximately, not usually". The patch removes the model's fix, and the
     * `would-have-moved` fixture is built precisely so that removing it CHANGES
     * THE ANSWER: an unprotected twin is strictly cheaper, so the optimizer
     * moves the assignment and improves its objective.
     *
     * Without that fixture this arm could not exist. An assignment that was
     * never going to move cannot demonstrate that anything held it, and a pin
     * over a forced choice would keep passing with the constraint gone. */
    patch: [
      {
        file: 'solver/schedulepoint_solver/cpsat_adapter.py',
        find: '        if key in built.cells:\n            m.Add(built.cells[key] == 1)',
        replace: '        if False:  # red case: the pin is no longer an input\n            m.Add(built.cells[key] == 1)',
      },
    ],
    greenCommand: ['exec', 'vitest', 'run', 'apps/api/test/solver/e2-objective.test.ts'],
    redCommand: ['exec', 'vitest', 'run', 'apps/api/test/solver/e2-objective.test.ts'],
  },
  {
    id: 'builds-comparability-unenforced',
    gate: 'comparison is refused across snapshots or weight sets (doc 35 §6f behaviour 1)',
    violation: 'every pair of results is declared comparable',
    /* "two results are comparable iff same snapshot + same weights, and the
     * comparison service enforces exactly that". The patch makes the domain
     * verdict unconditionally `true`, which is the shape the feature had before
     * this packet: a difference list across two different problems, in one
     * table, one careless read away from a conclusion.
     *
     * Compile-clean by construction — the parameter is still read by the length
     * guard above it — so the `prepare` rebuild succeeds and the api-side arm
     * genuinely observes the patched `dist`. That is the `retired-verdict`
     * lesson applied: a violation that fails to compile makes the arm read NOT
     * PROVEN, which proves nothing at all. */
    patch: [
      {
        file: 'packages/domain/src/rules/objective.ts',
        find: '  if (results.length < 2) return { comparable: true };',
        replace:
          '  if (results.length < 2) return { comparable: true };\n'
          + '  if (results.length >= 2) return { comparable: true }; // red case: nothing is refused',
      },
    ],
    greenCommand: [
      'exec',
      'sh',
      '-c',
      'vitest run packages/domain/test/rules/e2-objective-and-quality.test.ts apps/api/test/builds/e2-quality-and-credits.test.ts',
    ],
    /* `dist` carries the violation, or the api-side half of this arm is blind. */
    prepare: [['exec', 'tsc', '-b', 'packages/domain', '--force']],
    redCommand: [
      'exec',
      'sh',
      '-c',
      'vitest run packages/domain/test/rules/e2-objective-and-quality.test.ts apps/api/test/builds/e2-quality-and-credits.test.ts',
    ],
    restore: [['exec', 'tsc', '-b', 'packages/domain', '--force']],
  },
  {
    id: 'result-reproducibility-derivation-removed',
    gate: 'a wall-clock-truncated run never claims reproducibility (SPEC-04 §4 amended, FAD-49)',
    violation: 'the result verdict stops reading the wall clock and trusts the dispatch mode',
    /* **The claim this protects is a NEGATIVE one, which is why it needs an arm.**
     *
     * Every other reproducibility proof in this repository checks that something
     * IS reproducible. This one guards the refusal: EV-M4-005 §20 measured a
     * build posed under the full pinned set whose search the WALL CLOCK ended —
     * 9.497948s of a 10s limit, 12-22 of 100 deterministic units spent — which
     * reproduces nothing, and which the product reported as `deterministic`
     * because `reproducibilityMode` reads the REQUEST. The build detail screen
     * turned that into "the same problem run again … produces the same
     * schedule".
     *
     * The patch is the defect exactly as it stood: the wall-clock comparison
     * stops happening, so every deterministic-mode run is called reproducible
     * again. It is compile-clean by construction — `threshold` is still
     * computed and still read by the disabled branch — so the `prepare` rebuild
     * succeeds and the api-side and web-side halves genuinely observe the
     * patched `dist`, which is the `retired-verdict` lesson applied.
     *
     * The arm points at the domain proof alone, and that is a deliberate scope
     * rather than a convenience: the predicate and the SENTENCE it hands the
     * screen are both there, so this one file fails on the verdict, on the
     * boundary, and on the wording. The client-side labels are static strings
     * and cannot detect this mutation — `build-vocabulary` guards them from a
     * different direction and is not named here, because an arm that lists a
     * file it does not actually depend on reads as coverage it has not got. */
    patch: [
      {
        file: 'packages/domain/src/ports/solver-port.ts',
        find: '  if (wallTimeSeconds >= threshold) {',
        replace:
          '  if (wallTimeSeconds >= threshold && false) {'
          + ' // red case: the wall clock is no longer read',
      },
    ],
    greenCommand: [
      'exec',
      'vitest',
      'run',
      'packages/domain/test/ports/result-reproducibility.test.ts',
    ],
    prepare: [['exec', 'tsc', '-b', 'packages/domain', '--force']],
    redCommand: [
      'exec',
      'vitest',
      'run',
      'packages/domain/test/ports/result-reproducibility.test.ts',
    ],
    restore: [['exec', 'tsc', '-b', 'packages/domain', '--force']],
  },
  {
    id: 'result-reproducibility-units-branch-removed',
    gate: 'a completed FEASIBLE run with its deterministic budget UNSPENT never claims reproducibility (FAD-52)',
    violation: 'the result verdict stops reading the deterministic units and falls back to the wall clock alone',
    /* **The sibling of the arm above, and it exists because that arm was not
     * enough.**
     *
     * `result-reproducibility-derivation-removed` guards the wall-clock half of
     * FAD-49(1)'s derivation — "wall time vs wall budget". The other half,
     * "deterministic units vs deterministic budget", was never implemented, and
     * the gap between them is reachable: a pinned run of the B-fairness-shaped
     * class under a 10s clock completes FEASIBLE at wall 8.6-9.1s having spent
     * **8.076904 of 100** deterministic units. 8.7 of 10 is BELOW the 0.9
     * wall-clock fraction, so that arm's rule says nothing, and the verdict was
     * `reproducible` with the promise sentence attached. Raising the budget 36x
     * or unpinning it changes the units not at all: the wall clock is the sole
     * stop, and the wall-clock rule cannot see it. Measured 15+ times by two
     * independent reviewers.
     *
     * The patch is that defect exactly as it stood: the units-aware branch stops
     * being entered, so a feasible run that left its budget nearly untouched is
     * called reproducible again — and the `unrecorded` fail-closed for a run
     * that recorded no deterministic time goes with it, since both live behind
     * this one condition. Compile-clean by construction — `status` is still
     * compared and the block still type-checks — so the `prepare` rebuild
     * succeeds, which is the `retired-verdict` lesson applied.
     *
     * The arm points at the domain proof alone, deliberately and for the reason
     * its sibling gives: the predicate, the boundary and the SENTENCE it hands
     * the screen are all in that one file, so this fails on the verdict, on the
     * threshold and on the wording. The static client labels cannot detect a
     * predicate mutation, and naming a file the arm does not depend on would
     * read as coverage it has not got. */
    patch: [
      {
        file: 'packages/domain/src/ports/solver-port.ts',
        find: '  if (status === \'FEASIBLE\') {',
        /* The mutation redirects the branch at a status no real completed run
         * on this path carries, rather than the ` && false` spelling its
         * sibling uses. That spelling makes the block UNREACHABLE, and TypeScript
         * discards flow narrowing inside unreachable code — the patched file
         * then fails to compile (TS18047 on both nullable reads), the `prepare`
         * rebuild does not produce the artifact the arm is supposed to observe,
         * and the arm would be reporting on a build that never happened. The
         * `retired-verdict` lesson: a violation that does not compile proves
         * nothing. This form keeps the branch reachable and compile-clean while
         * making it fire on nothing the platform can produce here. */
        replace:
          '  if (status === \'MODEL_INVALID\') {'
          + ' // red case: the units-aware branch no longer fires on a feasible result',
      },
    ],
    greenCommand: [
      'exec',
      'vitest',
      'run',
      'packages/domain/test/ports/result-reproducibility.test.ts',
    ],
    prepare: [['exec', 'tsc', '-b', 'packages/domain', '--force']],
    redCommand: [
      'exec',
      'vitest',
      'run',
      'packages/domain/test/ports/result-reproducibility.test.ts',
    ],
    restore: [['exec', 'tsc', '-b', 'packages/domain', '--force']],
  },
  {
    id: 'solver-demand-not-independently-checked',
    gate: 'demand coverage is measured by the INDEPENDENT checker (SPEC-04 §7, FAD-46 F-03)',
    violation: 'the MODEL stops posting demand as a hard equality',
    /* The D-4 lesson, applied to demand. Before FAD-46's repair, demand was
     * enforced in exactly one place — the model's `sum(cells) == required` — and
     * the metric that was supposed to notice a shortfall counted assignments
     * without matching them to cells, so it scored a candidate that staffed
     * nothing but the wrong dates a flawless 1.
     *
     * This arm removes the constraint from the MODEL ONLY. Nothing in the
     * checker is touched. If the checker's demand measurement were ever deleted,
     * weakened, or quietly made to read the model's own word for it, this arm
     * would go green while the solver returned candidates that staffed nothing —
     * which is the whole failure this repair exists to make impossible.
     *
     * Python, so no rebuild is needed; the worker is re-executed per solve. */
    patch: [
      {
        file: 'solver/schedulepoint_solver/cpsat_adapter.py',
        find: '            enforce(m.Add(sum(variables) == required), "__demand__")',
        replace:
          '            if False:  # red case: the model stops posting demand as hard\n'
          + '                enforce(m.Add(sum(variables) == required), "__demand__")',
      },
    ],
    greenCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/solver/e2-objective.test.ts',
      'apps/api/test/solver/corpus/corpus-agreement.test.ts',
    ],
    redCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/solver/e2-objective.test.ts',
      'apps/api/test/solver/corpus/corpus-agreement.test.ts',
    ],
  },
  {
    id: 'builds-optimality-wording',
    gate: 'no surface claims optimality for a merely feasible result (SPEC-04 §7)',
    violation: 'the completed-state label calls the schedule optimal',
    /* The status-conflation arm, at the place the conflation actually happens:
     * the copy. `OPTIMAL` is a proof the solver either produced or did not, and
     * it is already carried beside the state as `solverStatus`. The moment the
     * word enters a STATE label it applies to every result that reaches that
     * branch — including every merely feasible one — and no API change is needed
     * for the product to start making a claim it cannot support.
     *
     * The patched wording is the one somebody would actually write: it reads
     * better than the true sentence, which is what makes it dangerous. */
    patch: [
      {
        file: 'apps/web/src/builds/BuildsLayout.tsx',
        find: "  completed: 'Completed — all preferences met',",
        replace: "  completed: 'Completed — optimal schedule found',",
      },
    ],
    greenCommand: ['exec', 'vitest', 'run', 'apps/web/test/build-vocabulary.test.ts'],
    redCommand: ['exec', 'vitest', 'run', 'apps/web/test/build-vocabulary.test.ts'],
  },

  /* ── OPUS-M4-005 — the hardening register's own controls (doc 35 §6g (E)) ───
   *
   * Four arms over four repairs. Each one exists because the repair it guards is
   * a control that would otherwise only ever be seen passing, and three of the
   * four are repairs to the CONTROLS THEMSELVES — the runner's ERRORED
   * detection, the NUL gate's magic-byte sniff, the fixture-regression capture.
   * A defect in any of those does not fail a build; it makes a build stop being
   * able to fail, which is strictly worse.
   * ────────────────────────────────────────────────────────────────────────── */
  {
    id: 'red-case-runner-errored-signatures',
    gate: "the runner tells 'this arm did not RUN' from 'this gate failed' (OPUS-M4-005)",
    violation: 'the ERRORED signature list emptied',
    /* The most self-referential arm here and the one with the most leverage. An
     * arm whose test path is misspelled exits NON-ZERO — `vitest run typo.test.ts`
     * does — so before this the runner recorded "gate failed as required" and
     * printed PROVEN. Every other case's falsifiability rests on the runner being
     * able to tell those apart. */
    patch: [
      {
        file: 'scripts/red-cases/errored-signatures.mjs',
        find: 'export const ERRORED_SIGNATURES = [',
        replace: 'export const ERRORED_SIGNATURES = [].length === 0 ? [] : [',
      },
    ],
    greenCommand: ['exec', 'node', 'scripts/red-cases/runner-signature/check.mjs'],
    redCommand: ['exec', 'node', 'scripts/red-cases/runner-signature/check.mjs'],
    /* This arm's RED output QUOTES the signatures it is asserting about — that is
     * what makes it a control — so the runner's own ERRORED detector matched it
     * and recorded the arm as never having run. Exempt, with the reason stated. */
    erroredExempt: true,
  },
  {
    id: 'raw-nul-magic-bytes',
    gate: 'the NUL gate cannot be evaded by RENAMING a file (OPUS-M4-005; M4-003 §6f D-3)',
    violation: 'the magic-byte sniff removed, leaving the extension allowlist alone',
    /* M4-003 recorded the bypass and left it: "a text file deliberately renamed
     * to `.png` would be skipped. Magic-byte sniffing would close it… recorded as
     * an M4-005 candidate". This is the close and its proof.
     *
     * The violation file is WRITTEN by `prepare` rather than committed, because
     * the gate under test scans `git ls-files` — a committed fixture carrying a
     * raw NUL would fail the gate on every ordinary run, the same trap the
     * `raw-nul-scan` arm's own note describes. The RED command uses `--dir` for
     * the reason `secret-scan` and `invariant-ids` do. */
    patch: [
      {
        file: 'scripts/gates/raw-nul-scan.mjs',
        find: '  if (magic === null) return true;',
        replace: '  return true; // red case: extension-only, the pre-hardening behaviour',
      },
    ],
    /* `setup`, NOT `prepare`: the fixture must exist for the GREEN run too, or
     * the gate scans an empty directory and passes for the wrong reason. */
    setup: [['exec', 'node', 'scripts/red-cases/raw-nul-magic/write-misnamed.mjs']],
    greenCommand: [
      'exec',
      'node',
      'scripts/gates/raw-nul-scan.mjs',
      '--dir',
      'scripts/red-cases/raw-nul-magic/fixture',
    ],
    redCommand: [
      'exec',
      'node',
      'scripts/gates/raw-nul-scan.mjs',
      '--dir',
      'scripts/red-cases/raw-nul-magic/fixture',
    ],
    /* GREEN and RED are the SAME command, and the arms differ only by the patch —
     * which is the point: with the sniff in place the misnamed file is scanned
     * and FAILS, so the ordinary green/red polarity is inverted here. It is
     * spelled explicitly below rather than left to a reader to notice. */
    invertPolarity: true,
    restore: [['exec', 'node', 'scripts/red-cases/raw-nul-magic/clean.mjs']],
  },
  {
    id: 'nr15-capture-widening',
    gate: 'a failing fixture-regression run retains its FULL output (NR-15)',
    violation: 'the capture restored to the filtered summary lines',
    /* NR-15 stayed open for five packets for one reason the register names
     * exactly: "the gate truncates assertion output so the actual failure was
     * never captured". The repair is a widening, and a widening nobody can
     * falsify is a claim — a truncation nobody notices looks exactly like a
     * capture. This restores the truncation and requires the control to see it. */
    patch: [
      {
        file: 'scripts/sbx/capture.mjs',
        find: '      run.output,',
        replace:
          "      run.output.split('\\n').filter((line) => / FAIL /.test(line)).slice(0, 12).join('\\n'), // red case: truncated again",
      },
    ],
    greenCommand: ['exec', 'node', 'scripts/red-cases/nr15-capture/check.mjs'],
    redCommand: ['exec', 'node', 'scripts/red-cases/nr15-capture/check.mjs'],
  },
  {
    id: 'nr16-bare-line-scanner',
    gate: 'the I-15 scanner sees a tenant query written across LINES (NR-16)',
    violation: 'the bare-line detector removed, leaving the quoted-literal one alone',
    /* FAD-33's finding: the tenant-table detector requires a quote earlier on the
     * same line, so the same direct query became invisible by pressing Enter.
     * The connection detectors are unaffected, which is why the gap scored low
     * and why only an arm aimed at the bare-line detector can falsify it —
     * everything else in that file stays green. */
    patch: [
      {
        file: 'apps/api/test/support/tenant-access-scan.ts',
        find: '    ...bareLineTenantTableDetectors(),',
        replace: '    // red case: the bare-line detector is removed',
      },
    ],
    greenCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/architecture/no-tenant-access-outside-unit-of-work.test.ts',
    ],
    redCommand: [
      'exec',
      'vitest',
      'run',
      'apps/api/test/architecture/no-tenant-access-outside-unit-of-work.test.ts',
    ],
  },
];

/** @param {string[]} args */
function pm(args) {
  if (PM_EXECPATH !== undefined && /\.(mjs|cjs|js)$/.test(PM_EXECPATH)) {
    return { command: process.execPath, args: [PM_EXECPATH, ...args] };
  }
  return { command: PM_EXECPATH ?? 'pnpm', args };
}

/** @param {string} text */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * @param {string[]} args
 * @returns {{ ok: boolean, output: string }}
 */
function run(args) {
  const invocation = pm(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  /* FAD-50 N-1(ii). `spawnSync` reports a failure to START the process in
   * `result.error`, NOT in `status` — an ENOENT leaves `status: null`, empty
   * stdout and empty stderr. That read as `ok: false` with no output at all, so
   * an arm whose command could not be spawned reported "GATE FAILED" and was
   * indistinguishable from a gate that ran and correctly failed. The reviewer
   * hit exactly that, silently.
   *
   * Rendered into the output as an ERRORED signature instead, so the detector
   * that already exists for "this arm did not RUN" catches it. A missing binary
   * is not evidence about a gate. */
  if (result.error !== undefined && result.error !== null) {
    const reason = /** @type {{ message?: unknown }} */ (result.error).message ?? String(result.error);
    return {
      ok: false,
      output:
        `RED-CASE RUNNER: the command could not be spawned (${String(reason)}).\n` +
        `  command: ${invocation.command} ${invocation.args.join(' ')}\n` +
        'vitest matched no test file (a filter or a path is wrong)\n',
    };
  }

  return {
    ok: result.status === 0,
    output: stripAnsi(`${result.stdout ?? ''}${result.stderr ?? ''}`),
  };
}

/** @type {Map<string, string>} */
const patchBackups = new Map();
/** @type {string[]} */
const injectedPaths = [];

/** @param {RedCase} testCase */
function applyViolation(testCase) {
  for (const injection of testCase.inject ?? []) {
    const target = resolve(REPO_ROOT, injection.to);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(HERE, injection.from), target);
    injectedPaths.push(target);
  }

  for (const patch of testCase.patch ?? []) {
    const target = resolve(REPO_ROOT, patch.file);
    const original = readFileSync(target, 'utf8');
    if (!original.includes(patch.find)) {
      throw new Error(
        `red case "${testCase.id}": anchor not found in ${patch.file}.\nLooking for: ${patch.find}`,
      );
    }
    // The FIRST reading of a file is the one restored. A case with two patches
    // to one file used to back up the already-patched content on the second
    // pass, so `revertViolation` wrote back a half-patched file and left the
    // working tree dirty — observed with `stale-edit-cas`, which disarms the
    // compare-and-set in two places.
    if (!patchBackups.has(target)) patchBackups.set(target, original);
    writeFileSync(target, original.replace(patch.find, patch.replace), 'utf8');
  }
}

/**
 * Everything named `__red_case__*` under a `dist` directory, however it got
 * there.
 *
 * OPUS-M4-004 §8.2 measured the gap this closes, and the measurement is the
 * point: after a **successful** run `git status` read clean while four compiled
 * artifacts survived —
 *
 * ```
 * packages/contracts/dist/src/__red_case__type.{js,d.ts,js.map,d.ts.map}
 * ```
 *
 * The `typecheck` arm injects `packages/contracts/src/__red_case__type.ts`;
 * `revertViolation` deleted the SOURCE, but `tsc` had already emitted into
 * `dist`, and `dist` is gitignored. So the tree looked clean and a stale
 * compiled artifact was left for whatever ran next to import.
 *
 * The sweep is by NAME rather than by a list of the four extensions, because the
 * next injection will emit a set nobody predicted.
 */
function sweepDistArtifacts() {
  /** @type {string[]} */
  const swept = [];
  /** @param {string} directory */
  const walk = (directory) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // a dist that has never been built
    }
    for (const entry of entries) {
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.startsWith('__red_case__')) {
        rmSync(full, { force: true });
        swept.push(full);
      }
    }
  };
  for (const workspace of ['packages', 'apps']) {
    /** @type {import('node:fs').Dirent[]} */
    let members;
    try {
      members = readdirSync(resolve(REPO_ROOT, workspace), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const member of members) {
      if (!member.isDirectory()) continue;
      walk(resolve(REPO_ROOT, workspace, member.name, 'dist'));
    }
  }
  return swept;
}

function revertViolation() {
  for (const [target, original] of patchBackups) writeFileSync(target, original, 'utf8');
  patchBackups.clear();
  for (const target of injectedPaths) rmSync(target, { force: true });
  injectedPaths.length = 0;
  const swept = sweepDistArtifacts();
  if (swept.length > 0) {
    process.stdout.write(
      `  swept ${String(swept.length)} compiled red-case artifact(s) from dist/ ` +
        '(invisible to git status — OPUS-M4-004 §8.2)\n',
    );
  }
}

/** Clears anything a previous interrupted run may have left behind. */
function clearStaleInjections() {
  /** @type {string[]} */
  const stale = [];
  for (const testCase of CASES) {
    for (const injection of testCase.inject ?? []) {
      const target = resolve(REPO_ROOT, injection.to);
      if (existsSync(target)) {
        rmSync(target, { force: true });
        stale.push(injection.to);
      }
    }
  }
  if (stale.length > 0) {
    process.stdout.write(
      `Cleared stale red-case injections:\n${stale.map((s) => `  ${s}\n`).join('')}\n`,
    );
  }
}

/**
 * Is anything listening on `127.0.0.1:port` right now?
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function portIsHeld(port) {
  return new Promise((resolveProbe) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (held) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(held);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Waits until this worktree's embedded-postgres port is free again (U-04).
 *
 * ## The transient this removes
 *
 * The `unit` red case's **GREEN arm** runs the real `gate:unit`, which starts the
 * embedded cluster on this worktree's port. Running `pnpm red-cases` immediately
 * after `pnpm check` therefore raced the previous run's shutdown: the port was
 * still held for a moment, the cluster failed to start, and the GREEN arm failed
 * — reporting "the gate is broken" when nothing was broken. OPUS-M2-002's delta
 * review saw it as finding U-04.
 *
 * A wait, not a retry: retrying the gate would mask a genuine GREEN failure,
 * which is the one thing this runner exists to detect. If the port is still held
 * when the budget runs out the run proceeds anyway and says so, so a genuinely
 * stuck cluster surfaces as the failure it is rather than as a hang.
 *
 * @param {number} port
 * @param {number} budgetMs
 */
async function waitForPortRelease(port, budgetMs = 30_000) {
  const deadline = Date.now() + budgetMs;
  let announced = false;
  while (await portIsHeld(port)) {
    if (!announced) {
      process.stdout.write(
        `Waiting for the embedded-postgres port ${String(port)} to be released ` +
          '(a previous `pnpm check` may still be shutting down)...\n',
      );
      announced = true;
    }
    if (Date.now() >= deadline) {
      process.stdout.write(
        `Port ${String(port)} is STILL held after ${String(budgetMs / 1000)}s. Continuing anyway — ` +
          'a GREEN-arm failure below is then a real finding, not this transient. See the runbook\n' +
          'standing port-hygiene discipline for how to identify and clear the holder.\n',
      );
      return;
    }
    await delay(500);
  }
  if (announced) process.stdout.write(`Port ${String(port)} released.\n`);
}

async function main() {
  await waitForPortRelease(resolveTestPgPort());

  clearStaleInjections();

  const transcript = [
    `# pnpm red-cases — ${new Date().toISOString()}`,
    '',
    'GREEN = the gate passes on the clean tree.',
    'RED   = the gate fails once the violation is introduced.',
    'A gate that passes its RED check is decorative and the run fails.',
    '',
  ];

  /** @type {{ id: string, gate: string, violation: string, green: boolean, red: boolean, errored: string | null }[]} */
  const results = [];

  /* ── R-2: the built bundle exists BEFORE any arm reads it ──────────────────
   *
   * `network-guard-bundle` injects into `apps/web/dist/assets/` and
   * `gate:network-guard` scans that directory. On a FRESH worktree there is no
   * `dist` until `gate:build` has run, and the arm's GREEN then passes over an
   * empty scan — a pass that means "there was nothing to look at". M4-002 §28
   * worked around it by hand ("run after `check` so `dist/` existed for the
   * network-guard arm"), which is a discipline nobody can enforce.
   *
   * Built once, here, so the ordering is a property of the runner rather than of
   * the order somebody happened to run two batteries in. */
  process.stdout.write('\n=== preflight: building apps/web so the bundle arms have a bundle ===\n');
  const preflight = run(['run', 'gate:build']);
  process.stdout.write(`  ${preflight.ok ? 'built' : 'BUILD FAILED — bundle arms will be unreliable'}\n`);
  transcript.push(
    '## preflight — production build (R-2 ordering)',
    '',
    '```',
    preflight.output.trimEnd().slice(-4000),
    '```',
    '',
  );

  for (const testCase of CASES) {
    process.stdout.write(`\n=== ${testCase.id} — ${testCase.gate} ===\n`);
    transcript.push(
      `## ${testCase.id} — ${testCase.gate}`,
      '',
      `Violation: ${testCase.violation}`,
      '',
    );

    /* `setup` runs BEFORE the GREEN command; `prepare` runs after the violation
     * is applied and therefore only on the RED side. The distinction is not
     * cosmetic — `raw-nul-magic-bytes` put its fixture write in `prepare`, so its
     * GREEN run scanned an EMPTY directory ("0 text file(s) scanned"), passed for
     * the most boring possible reason, and — being an inverted-polarity arm that
     * requires GREEN to fail — reported NOT PROVEN on every complete run. The
     * first complete 63-arm battery is what surfaced it (OPUS-M4-005). */
    for (const setupCommand of testCase.setup ?? []) run(setupCommand);

    const green = run(testCase.greenCommand);
    /* One arm's output legitimately CONTAINS the ERRORED signatures, because it
     * is the signatures' own control: `red-case-runner-errored-signatures` prints
     * the strings it is asserting about. The detector detecting its own control
     * is a self-reference, not a broken arm, and it made that arm report ERRORED
     * on every complete run. Exempted explicitly rather than by weakening a
     * pattern every other arm depends on. */
    let errored = testCase.erroredExempt === true ? null : erroredReason(green.output);
    /* FAD-50 N-1(i). An `invertPolarity` arm EXPECTS its green command to fail
     * on the clean tree — that failure IS the proof (the magic-byte fixture is
     * supposed to be rejected). The inline line said a flat "GATE FAILED", the
     * summary table then scored the same arm `pass`, and the retained artifact
     * contradicted itself on every run. The reading is annotated here so the two
     * halves of the same file agree. */
    const inverted = testCase.invertPolarity === true;
    const greenReading =
      errored !== null
        ? `ERRORED — ${errored}`
        : inverted
          ? green.ok
            ? 'GATE PASSED — and this arm requires it to FAIL (inverted polarity)'
            : 'gate failed, AS THIS ARM REQUIRES (inverted polarity)'
          : green.ok
            ? 'gate passed'
            : 'GATE FAILED';
    process.stdout.write(`  GREEN (clean tree): ${greenReading}\n`);
    transcript.push('### GREEN — clean tree', '', '```', green.output.trimEnd(), '```', '');

    let red = { ok: true, output: '(not run)' };
    try {
      applyViolation(testCase);

      let prepareFailed = false;
      for (const prepareCommand of testCase.prepare ?? []) {
        const prepared = run(prepareCommand);
        if (!prepared.ok) {
          prepareFailed = true;
          transcript.push('### PREPARE FAILED', '', '```', prepared.output.trimEnd(), '```', '');
        }
      }

      red = prepareFailed ? { ok: true, output: 'prepare step failed' } : run(testCase.redCommand);
      /* The RED direction is where this matters most: a misspelled test path
       * exits non-zero and would otherwise read as "the gate failed as
       * required". */
      if (testCase.erroredExempt !== true) errored ??= erroredReason(red.output);
      process.stdout.write(
        `  RED   (violation in tree): ${
          errored !== null
            ? `ERRORED — ${errored}`
            : inverted
              ? red.ok
                ? 'gate passed, AS THIS ARM REQUIRES (inverted polarity)'
                : 'GATE FAILED — and this arm requires it to PASS (inverted polarity)'
              : red.ok
                ? 'GATE STILL PASSED — decorative'
                : 'gate failed as required'
        }\n`,
      );
      transcript.push('### RED — violation introduced', '', '```', red.output.trimEnd(), '```', '');
    } finally {
      revertViolation();
      for (const restoreCommand of testCase.restore ?? []) run(restoreCommand);
    }

    results.push({
      id: testCase.id,
      gate: testCase.gate,
      violation: testCase.violation,
      /* `invertPolarity` is for an arm whose GREEN command is expected to FAIL
       * on the clean tree — the magic-byte case, whose green command scans a
       * fixture the hardening is supposed to reject. Spelled as a flag rather
       * than left implicit, so the table reads the same way for every row. */
      green: testCase.invertPolarity === true ? !green.ok : green.ok,
      red: testCase.invertPolarity === true ? red.ok : !red.ok,
      errored,
    });
  }

  const failures = results.filter((r) => r.errored !== null || !r.green || !r.red);

  const width = Math.max(...results.map((r) => r.id.length), 4);
  const table = [
    '',
    `${'CASE'.padEnd(width)}  GREEN  RED    VERDICT`,
    `${'-'.repeat(width)}  -----  -----  -------`,
    ...results.map(
      (r) =>
        `${r.id.padEnd(width)}  ${(r.green ? 'pass' : 'FAIL').padEnd(5)}  ${(r.red ? 'fail' : 'PASS').padEnd(5)}  ${
          r.errored !== null ? 'ERRORED' : r.green && r.red ? 'PROVEN' : 'NOT PROVEN'
        }`,
    ),
    `${'-'.repeat(width)}  -----  -----  -------`,
    `${String(results.length)} case(s): ${String(results.length - failures.length)} proven, ${String(failures.length)} not proven`,
    '',
    'GREEN "pass" = the gate passes on the clean tree.',
    'RED   "fail" = the gate fails when the violation is present. That is the desired outcome.',
    'ERRORED    = the arm did not RUN. Never counted as proven, however its exit code read.',
    ...results
      .filter((r) => r.errored !== null)
      .map((r) => `  ERRORED ${r.id}: ${String(r.errored)}`),
    '',
  ].join('\n');

  process.stdout.write(table);
  transcript.push('## summary', '', '```', table.trim(), '```', '');

  const transcriptPath = resolveEvidencePath(
    REPO_ROOT,
    'scripts/red-cases/evidence-output.txt',
    EVIDENCE_REFRESH,
  );
  mkdirSync(dirname(transcriptPath), { recursive: true });
  writeFileSync(transcriptPath, transcript.join('\n'), 'utf8');
  /* Exit from the LAST stdout write's callback, not before it.
   *
   * `process.exit()` does not drain pending stdout writes, and on CI stdout is a
   * pipe, where writes are buffered and asynchronous rather than immediate. The
   * first hosted-runner CI run lost the tail of `pnpm check` that way — every
   * gate's output after `unit`, and the summary table, truncated mid-line. This
   * runner ends the same way and carries the same hazard: the summary table
   * above is the one thing a reader actually needs, and it is written last.
   *
   * The bare `process.exitCode` fix that `scripts/check.mjs` uses is NOT safe
   * here. That script is a straight line of `spawnSync` calls; this one probes a
   * TCP port and spawns vitest, Playwright and an embedded-postgres cluster
   * through its arms. If any handle outlives `main()`, letting Node exit on its
   * own turns a truncated transcript into a hung job, which is worse. Writing
   * the last chunk and exiting from its callback keeps `exit()`'s
   * kill-whatever-lingers behaviour, and because writes to one stream complete
   * in order, every earlier line has flushed by the time the callback runs.
   * Nothing here writes to stderr — every child's stderr is captured by
   * `spawnSync` and re-emitted onto stdout above — so this one stream is the
   * whole transcript. */
  const code = failures.length === 0 ? 0 : 1;
  process.stdout.write(
    `${evidenceDestinationBanner(EVIDENCE_REFRESH)}\n${transcriptPath}\n`,
    () => {
      process.exit(code);
    },
  );
}

await main();
