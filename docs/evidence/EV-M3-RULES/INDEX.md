# EV-M3-RULES — OPUS-M3-002 evidence index

Typed scheduling-rule AST, compiler, canonical serialization, the unmapped-node
CI gate, the B-* benchmark corpus, migration `0008`, the authoring API and the
accessible authoring UI. **Complete** — the mandatory pre-migration escalation
was ruled **FAD-21** (2026-08-04, ruling commit `18237aa`) and implemented as
ruled.

## Read first

- **`ESCALATION-pattern-staff-rules.md`** — the mandatory pre-migration proposal, kept as the record of what was asked and why. **RULED FAD-21: option (a) accepted** — `pattern_rules`/`staff_rules` are categories of the one typed model, not separate free-form tables (which would re-open the CAR-006 escape-hatch defect). doc 06 §3.2 amended; migration `0008` creates `rules` + `rule_sets` only, with the CHECK-constrained `category ∈ {general, pattern, staff}` discriminator.

## What was implemented (table-independent, all green)

| Deliverable | Location |
|---|---|
| Typed rule AST — closed node set (30 nodes, 10 families, SPEC-04 §3.1) | `packages/domain/src/rules/ast.ts` |
| Pure field-addressed validation (SPEC-04 §3.2 authoring validation) | `packages/domain/src/rules/validate.ts` |
| Deterministic canonical serialization (stable key order) | `packages/domain/src/rules/serialize.ts` |
| Compiler `RuleAST → canonical solver-input form`; structural hard/soft invariant; versioned | `packages/domain/src/rules/compile.ts` |
| Wire shapes (zod, `.strict()`, discriminated union — no escape hatch) | `packages/contracts/src/rules/index.ts` |
| **New build-failing gate** — unmapped-node closure check | `scripts/gates/rule-node-mapping-check.mjs` (wired into `pnpm check` and `pnpm red-cases`) |
| B-* benchmark corpus generator + committed fixtures + manifest | `solver/corpus/build-corpus.mjs`, `solver/corpus/fixtures/`, `solver/corpus/manifest.json` |
| Domain proofs (round trip, determinism, hard/soft, closure, validation) | `packages/domain/test/rules/` |
| Cross-package contract↔domain parity | `apps/api/test/rules/contract-parity.test.ts` |
| **Migration `0008`** — `rules` + `rule_sets`, FAD-21 `category`, CAR-006 CHECK, closed-node CHECK, RLS ENABLE+FORCE+policy, FAD-17(2) capability predicate, `rule_key` immutability, delete prohibition | `apps/api/migrations/0008_typed_rules.sql` |
| Authoring API — create/edit/state, rule sets, FAD-12 ordering, `rules.*` audit | `apps/api/src/rules/`, `apps/api/src/http/routes/rules.route.ts` |
| Kysely types + `TENANT_TABLES` registration (now **33**) | `apps/api/src/db/schema.ts` |
| Accessible authoring UI (axe both viewports, keyboard, I-13, I-10, five states, 320px list alternative) | `apps/web/src/rules/RulesPage.tsx`, `apps/web/src/api/rules.ts` |
| UI journeys + a11y + budget recordings | `apps/web/e2e/rules.spec.ts` |
| Test fixtures / sweep seeding (this packet's own support file) | `apps/api/test/support/rules.ts` |
| DB-backed proofs: round trip, authorization allow/deny, audit chain, isolation, schema | `apps/api/test/rules/` |

## Named-condition proofs

| # | Proof | Evidence file | Standalone | In package | Full battery |
|---|---|---|---|---|---|
| 1 | Round-trip equality — in-memory over the AST | `proof-roundtrip.txt` | ✓ | ✓ (domain project) | ✓ (`pnpm check` unit gate) |
| 1b | **Round trip against a REAL database** — author → persist → load → re-validate → re-serialize, canonical-equal for all 30 node kinds × HARD/SOFT, plus compiled-form equality and a mutation control | `proof-roundtrip-db.txt` | ✓ | ✓ (api project) | ✓ (`pnpm check` unit gate) |
| 2 | Compiler determinism (byte-identical) | `proof-compile.txt` | ✓ | ✓ | ✓ |
| 3 | Unmapped-node CI failure (green + red + adversarial "delete all mappings") | `proof-gate-and-corpus.txt`, `proof-unmapped-node-gate.txt` | ✓ | ✓ (gate + red-case harness) | ✓ (`pnpm check` gate `rule-node-mapping`) |
| 4 | Hard/soft invariant — compiler never maps HARD→objective | `proof-compile.txt` | ✓ | ✓ | ✓ |
| 5 | Corpus regeneration byte-identity (green + red tamper) | `proof-gate-and-corpus.txt`, `proof-corpus-regeneration.txt` | ✓ | ✓ (`corpus:check` + red-case harness) | n/a (not a `check` gate) |

The **database half** of the hard/soft invariant (the CAR-006 CHECK) is now
proven directly: `apps/api/test/rules/authorization.test.ts` inserts a
`HARD`-with-weight and a `SOFT`-without-weight row as the table owner and both
are refused. The closed node set is proven at the database the same way (a
`{"kind":"RawJson"}` predicate is refused), and
`apps/api/test/rules/schema.test.ts` reads the CHECK out of `pg_constraint` and
asserts its thirty members equal `RULE_NODE_KINDS`.

## Migration, isolation and audit

- **Migration `0008` up/down/up clean** — `proof-migration-cycle.txt`; `0008_typed_rules` appears in both the `down` and the `up2` lists.
- **SBX-004 sweep extended** — `rules` and `rule_sets` registered in `TENANT_TABLES` (**33 tables**, floor raised 17 → 33) and seeded in three groups through the production write path. Sweep **PASS**, falsifiability **FALSIFIABLE**, **0 wrong-tenant rows**, no vacuous table. SBX battery **5/5 PASS**, 0 vacuous.
- **Audit chain verifies clean** after the suite and after the SBX run (`0 / N≥1 / 0` per organization).
- **`app_readonly_support` is narrowed to 42501 on `rules`** by the FAD-17(2) capability predicate — the INTERNAL classification working, recorded distinctly by the sweep as `qualification_holdings` already is.

## Gate battery

- `corepack pnpm check` — **13/13 PASS** (was 12; the 13th is the new
  `rule-node-mapping` closure gate this packet adds — the packet requires a *new*
  build-failing gate, "never modify an existing one"). Transcript regenerates to
  `scripts/check-output.txt`.
- `corepack pnpm red-cases` — **16/16 proven** (was 14; +`rule-node-mapping`,
  +`corpus-tamper`).

## Corpus construction arguments and infeasibility certificates

Recorded per fixture inside each `solver/corpus/fixtures/*.json` and summarised in
`ESCALATION`-adjacent form. Feasible fixtures carry a **counting argument** (never
a computed assignment — no solver here, M4 boundary); infeasible fixtures carry a
**minimal infeasibility certificate** (the smallest already-unsatisfiable rule
subset plus a minimality proof):

| Fixture | Class | Basis |
|---|---|---|
| `B-feasible-small` | feasible | 7 slots ≤ 15 eligible staff, one HARD RequiredCount, no other HARD rule ⇒ a satisfying injection exists (counting) |
| `B-feasible-eligibility` | feasible | 5 slots ≤ 6 ACLS holders, HARD RequiresQualification + RequiredCount, one SOFT (cannot cause infeasibility) |
| `B-infeasible-overdemand` | infeasible | 5 staff, 3 senior. RequiredCount(4) ∧ MemberOfStaffGroup(senior): 4 > 3. **Minimal, both removals checked** — drop the count rule and 0 slots are required; drop the eligibility rule and 4 ≤ 5 is feasible. (Corrected at second review: the fixture previously had 3 staff who were ALL senior, which made the eligibility rule inert and `{cover_day_4}` alone already unsatisfiable — a non-minimal core.) |
| `B-infeasible-missing-qualification` | infeasible | RequiredCount(1) ∧ RequiresQualification(picu_cert), 0 holders |
| `B-infeasible-fixed-conflict` | infeasible | MaxCoverage(1) ∧ two FixedAssignments into one slot: 2 > 1 |
| `B-infeasible-contradictory-rules` | infeasible | RequiredCount(1) forces day ⇒ ImpliesAssignment forces evening ⇒ MutuallyExclusive forbids it |

## Non-bypass / clean-room posture

- **No solver, optimization, or assignment-generation code** anywhere (M4
  boundary, non-bypass rule 7). `solver/corpus/` is fixtures only; the "canonical
  solver-input form" is a declarative description, not a search.
- **Closed AST, no escape hatch** — an unknown predicate `kind` is rejected by
  domain validation and by the contracts discriminated union (proven).
- **Synthetic data only** — corpus uses `m01..mNN`, generic shift/qualification
  codes; no source-product or real names.
- No existing test, gate, or invariant weakened; no existing gate modified.
