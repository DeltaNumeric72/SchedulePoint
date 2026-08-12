import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  evidenceDestinationBanner,
  isEvidenceRefresh,
  resolveEvidencePath,
} from '../evidence-target.mjs';
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
 *   prepare?: string[][],
 *   restore?: string[][],
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
    id: 'rule-kind-registry',
    gate: 'rule-kind registry is generated (doc 34 §4-D)',
    violation: 'a count in the committed registry edited by hand',
    /* The registry exists because the PREVIOUS register was prose with the
     * counts typed into its headings, and three of them were wrong. The claim
     * "the registry is generated" is a claim about this gate, so the gate has to
     * be seen failing: one number, edited by hand, in the committed artifact. */
    patch: [
      {
        file: 'packages/domain/src/rules/rule-kind-registry.generated.md',
        find: '| One owner ruling away, nothing else needed | 11 |',
        replace: '| One owner ruling away, nothing else needed | 10 |',
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
    /* ── REPAIRED at the 000C integration (FAD-30 decorative-arm standing rule) ──
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
     * convergence 1 failed — both now observe. */
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
    ],
    prepare: [['exec', 'tsc', '-b', 'packages/domain', '--force']],
    redCommand: [
      'exec',
      'vitest',
      'run',
      'packages/domain/test/eligibility/verdict.test.ts',
      'apps/api/test/profiles/verdict-convergence.test.ts',
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

function revertViolation() {
  for (const [target, original] of patchBackups) writeFileSync(target, original, 'utf8');
  patchBackups.clear();
  for (const target of injectedPaths) rmSync(target, { force: true });
  injectedPaths.length = 0;
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

  /** @type {{ id: string, gate: string, violation: string, green: boolean, red: boolean }[]} */
  const results = [];

  for (const testCase of CASES) {
    process.stdout.write(`\n=== ${testCase.id} — ${testCase.gate} ===\n`);
    transcript.push(
      `## ${testCase.id} — ${testCase.gate}`,
      '',
      `Violation: ${testCase.violation}`,
      '',
    );

    const green = run(testCase.greenCommand);
    process.stdout.write(`  GREEN (clean tree): ${green.ok ? 'gate passed' : 'GATE FAILED'}\n`);
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
      process.stdout.write(
        `  RED   (violation in tree): ${red.ok ? 'GATE STILL PASSED — decorative' : 'gate failed as required'}\n`,
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
      green: green.ok,
      red: !red.ok,
    });
  }

  const failures = results.filter((r) => !r.green || !r.red);

  const width = Math.max(...results.map((r) => r.id.length), 4);
  const table = [
    '',
    `${'CASE'.padEnd(width)}  GREEN  RED    VERDICT`,
    `${'-'.repeat(width)}  -----  -----  -------`,
    ...results.map(
      (r) =>
        `${r.id.padEnd(width)}  ${(r.green ? 'pass' : 'FAIL').padEnd(5)}  ${(r.red ? 'fail' : 'PASS').padEnd(5)}  ${
          r.green && r.red ? 'PROVEN' : 'NOT PROVEN'
        }`,
    ),
    `${'-'.repeat(width)}  -----  -----  -------`,
    `${String(results.length)} case(s): ${String(results.length - failures.length)} proven, ${String(failures.length)} not proven`,
    '',
    'GREEN "pass" = the gate passes on the clean tree.',
    'RED   "fail" = the gate fails when the violation is present. That is the desired outcome.',
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
  process.stdout.write(`${evidenceDestinationBanner(EVIDENCE_REFRESH)}\n${transcriptPath}\n`);

  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
