# 38 — Post-M4 internal review plan (the replacement gate)

**Status: PLAN COMMITTED. Review execution NOT begun until the Fable ratification record
in §10 reads PASS on every item.** Provenance: the owner's decision of 2026-08-22
superseding doc 37's Codex-specific requirement. The recorded disposition, verbatim:

- Codex review: **NOT PERFORMED**
- Codex-specific requirement: **SUPERSEDED BY OWNER DECISION**
- replacement gate: **FABLE-PLANNED, MULTI-OPUS-EXECUTED INTERNAL REVIEW**

This is an **internal** review and is never to be described as an external review. The
external architecture re-review that blocks beta entry (V-04) is unaffected and still
stands. Model separation is binding throughout: Fable plans, adjudicates, controls
independence, and decides the gate; fresh high-effort Opus agents execute review
packets, probes, and repairs; no reviewer implements a fix; Fable implements nothing.

---

## §1 Exact review baseline

| Ref | Commit |
| --- | --- |
| `milestone/M4` (frozen; verified remote tag) | `cc9f3f92583565e540a4a3b682303675ba8b6a70` |
| `origin/main` at plan commit | `93a71f52a16c60d99fecd6c862ba952b170cfb3a` |

**The complete delta `milestone/M4..origin/main`, by commit:** `1593b06` CLAUDE.md
standing-delegation record (owner-directed, docs-only) · `0f187f4` + `16000d2`
reconciliation records (run ledger, tag verification, review disposition — control docs
only) · `9729e07` OPUS-GH-001 (ci.yml; scripts/check.mjs; scripts/red-cases/run.mjs;
packages/domain/test/time/zoned-time.test.ts — timeout only) · `ceeb48d` OPUS-GH-002
(ci.yml only) · `912646d` OPUS-GH-003 (apps/web/src/catalogue/{GroupingPages,
GroupSettingsPage,ShiftTypesPage}.tsx — tabIndex + comments) · `dbee625` OPUS-GH-005
(apps/api/test/solver/e2-objective.test.ts — two timeouts) · `9a6a62a` OPUS-GH-007 /
FAD-52 (packages/domain/src/ports/solver-port.ts and domain tests;
packages/contracts/src/builds/lifecycle.ts; apps/api/src/builds + route; apps/web
builds label + vocabulary test; apps/api/test/solver + builds tests;
apps/api/test/support/solver.ts; scripts/red-cases/run.mjs new arm; docs/dev-setup.md
count; ARCHITECTURE-DECISIONS.md FAD-52) · `90ad3d1` OPUS-GH-006
(apps/web/src/publication/VersionComparisonPage.tsx; apps/web/e2e/publication.spec.ts
— window strengthening) · `332603e` OPUS-GH-010 (ci.yml matrix; run.mjs shard filter)
· `93a71f5` merge commit (tree byte-identical to `332603e`).

**Review rule:** M1–M4 claims are reviewed at `milestone/M4`. The delta is reviewed for
(a) not altering any M4 claim it does not explicitly supersede (FAD-52 explicitly
supersedes the reproducibility-verdict vocabulary; doc 36 and EV-M4-005 remain frozen
records accurate as of the tag), and (b) its own correctness. Each delta commit carries
its packet's implementer/reviewer/delta process record in its commit message.

## §2 The requirements surface being tested

1. **All 58 production capabilities** — authoritative list in research report 19;
   traceability in architecture doc 18 and control FEATURE-PARITY-MATRIX (at M4 exit:
   18 verified · 3 in-progress · 37 not-started). The review verifies the 18+3 claims
   and that none of the 37 was silently dropped, renamed, or narrowed.
2. **Architectural invariants I-01..I-22** (architecture doc 01 §4) — with I-02, I-07,
   I-10, I-11, I-12, I-13, I-14/15, I-16, I-18, I-19 having landed code.
3. **Specifications** SPEC-01..SPEC-16; ADR-0001..0023; FAD-1..52
   (control/ARCHITECTURE-DECISIONS.md).
4. **QA cases and SBX-001..017** per research report 21 and TEST-TRACEABILITY.md.
5. **M1–M4 acceptance claims** — exit reports 29, 31, 33, 36 and the EV-M1-* .. EV-M4-*
   evidence bundles; the M4-005 close battery figures (EV-M4-005 §24).
6. **Every M4 exit limitation** (doc 36 §§3/10) — each verified real and honestly sized.
7. **Carried risks and decisions** — RISK-REGISTER (NR-*), architecture doc 19,
   21-decision-resolution, the M3R registered findings, and the registered follow-up
   packets GH-004 / GH-008 / GH-009 (whose contents are review input, not settled).

## §3 Review packets

Execution is sequential: REV-A, then REV-B, then REV-C. Each reviewer is a fresh
high-effort Opus agent receiving only its packet text.

### REV-A — architecture and domain correctness (read-only; implements nothing)

- **Packet ID** REV-A. **Reviewer role:** architecture/domain reviewer.
- **Scope (owner-enumerated, binding):** capability traceability · domain boundaries ·
  tenancy and RLS · authorization and entitlements · transaction boundaries · schedule
  versioning and publication immutability · audit-chain behavior · solver lifecycle and
  reproducibility (incl. FAD-52's delta semantics) · cancellation and termination ·
  concurrency and stale writes · state machines · migrations 0001–0019 · date,
  time-zone and overnight behavior · M1–M4 cross-module composition · every M4 exit
  limitation.
- **Allowed:** read everything; execute batteries and author probes in the worktree;
  local probe commits on branch `review/rev-a` (pushed for durability, never merged);
  evidence written ONLY under `docs/evidence/EV-REVIEW-A/`.
- **Prohibited:** modifying `main` or any tracked file outside its evidence directory;
  implementing fixes; weakening anything; the clean-room and data rules of CLAUDE.md.
- **Claims requiring verification (minimum):** I-14/15 unit-of-work fail-closed as every
  role; I-18 immutability at the database as every role; I-19 freshness re-evaluation;
  FAD-34 termination vocabulary honesty; FAD-49/50/52 result-reproducibility derivation
  (incl. the knife-edge case measured in the GH-007 record); the 16-state lifecycle's
  illegal-edge refusals; epoch fencing and stale-result refusal; per-organization cap
  non-starvation; solver/checker evaluation independence; migration populated cycle
  0001–0019; R-B4/R-B5 gap/fold behavior; audit chain 0/1/0 per organization; the
  capability parity rows for the 18 verified + 3 in-progress capabilities.
- **Required probes (minimum — author more):** reproduce `corepack pnpm check`,
  `red-cases` (sharded or serial), `fixture-regression`, `sbx`, and the migration cycle,
  comparing figures against EV-M4-005 §24 with divergences reported as findings;
  mutation probes on at least one RLS predicate, one lifecycle guard, one checker rule,
  and one audit-chain link (each restored); hand-crafted invalid candidates for at
  least six M4-evaluable HARD kinds; stale-epoch, double-selection, and two-builds
  races; cross-tenant and cross-group probes as every role over the M4 tables.
- **Evidence:** every command with exit code; transcripts under EV-REVIEW-A;
  findings in §5's format. **Completion:** every scope area either covered with
  executed evidence or explicitly declared not-executable with the reason; findings
  filed; a could-not-falsify list naming what was attacked and how it held.

### REV-B — implementation and evidence (read-only; implements nothing; BLIND to REV-A)

- **Packet ID** REV-B. **Independence:** REV-B must file its report before being shown
  REV-A's report or evidence; its packet contains nothing derived from REV-A.
- **Scope (owner-enumerated, binding):** API enforcement · UI/backend agreement ·
  direct-request denial · database consistency · jobs and queue recovery · idempotency
  and duplicate operations · error handling · privacy boundaries (I-07/I-17: no
  delivery material or free text in logs, errors, traces, payloads) · browser network
  behavior (client third-party allowlist is EMPTY) · form and interface states ·
  desktop, mobile and 320-pixel behavior · keyboard and accessibility behavior ·
  request budgets · skipped or zero-test suites · vacuous assertions · fixture and
  order coupling · red cases · rotating seeds · SBX non-vacuity · validator
  falsifiability · CI and retained evidence accuracy.
- **Allowed/prohibited:** as REV-A, with evidence under `docs/evidence/EV-REVIEW-B/`
  and probe branch `review/rev-b`.
- **Required probes (minimum):** re-run the batteries and diff every figure against the
  claimed records; pick at least six red-case arms — including
  `result-reproducibility-derivation-removed`, `result-reproducibility-units-branch-removed`,
  a fencing arm, and the NR-16 scanner — and verify each bites in BOTH directions;
  sweep for `test.skip`/`todo`/zero-test files and the vitest zero-match-exits-0
  hazard (GH-008's registered finding); assertion-mutation sampling for vacuity;
  real-browser runs at both standing viewports plus 320px and keyboard journeys;
  request-budget re-measurement; evidence-transcript spot-checks against re-execution.
- **Completion:** as REV-A.

### REV-C — cross-check and consolidation (after A and B have both filed)

- **Packet ID** REV-C. **Inputs:** both reports and both evidence directories.
- **Scope (owner-enumerated, binding):** independently recheck consequential claims;
  compare A and B; identify disagreements; identify shared omissions; detect reliance
  on documentation instead of execution; evaluate probe quality and test non-vacuity;
  author additional bounded probes where either report is thin; produce the
  consolidated findings register; recommend **ACCEPT or REVISE**.
- **Allowed/prohibited:** as REV-A, evidence under `docs/evidence/EV-REVIEW-C/`,
  probe branch `review/rev-c`; implements nothing; does not adjudicate (that is
  Fable's) and does not decide the gate.

> **AMENDMENT 2026-08-24 (FAD-53, repair packet R-9; findings REV-B-005 and REV-C-011,
> plus the results-cache confound routed here at the R-6 acceptance).** As committed,
> this section told every reviewer to "execute batteries and author probes in the
> worktree", to make "local probe commits" on a branch that is "never merged", and to
> write evidence "ONLY under `docs/evidence/EV-REVIEW-{A,B,C}/`" — and said nothing
> about what a probe file may be **named**, or about where it may be left **while
> something else is running**, or about the cache state a composed run inherits. Three
> rules are added. **Nothing above is retracted and nothing is relaxed:** the packet
> texts are the texts the three executed reviews actually received, and they stand as
> that record. These rules bind the probes that come **next** — any remaining review
> round, every delta verification, and the evidence discipline behind §7's battery.
>
> **R-9.1 — a probe source committed under `docs/` carries a `.txt` suffix.** Both
> documentation validators forbid application-code extensions anywhere under `docs/`,
> and §7 then requires both of them green; so a probe source filed into its own evidence
> directory under a code extension makes the review's own final battery fail. REV-B-005
> established this by execution, not by reading: "The two validators forbid
> application-code extensions anywhere under `docs/`. `docs/fable/validate.py:166`
> rejects `.ts .tsx .js .sql .tf .dockerfile` and `.py`; `docs/architecture/validate.py`
> assertion 52a rejects the same class and `.sh`. A reviewer who writes a probe source
> into its own evidence directory — which is where §3 says probe sources go — turns §7's
> own battery red." What it measured, and what it did about it:
>
> ```
> 52a. Documentation and research trees contain no application code  FAIL
>      <- ['docs/evidence/EV-REVIEW-B/probes/red-case-arms.sh',
>           'docs/evidence/EV-REVIEW-B/probes/privacy-log-leak.probe.test.ts']
> 10a. Docs tree contains no application code                        FAIL   (fable 35/36)
> ```
>
> — "probe sources carry a non-code suffix … After the rename: architecture **95/95**,
> fable **36/36**." REV-C then adopted it as a stated convention: "REV-B-005 established
> that `.ts`/`.sh` under `docs/` turns the architecture and fable validators red. REV-C's
> probe sources therefore carry `.txt` suffixes", re-verified green both from a fresh
> clone with the bundle absent and on its own branch with it present. **The rule is the
> suffix, not a gap to aim at.** `.mjs` happens to sit in neither validator's list today,
> and `ALLOWED_IMPL_ROOTS` in `docs/architecture/validate.py` names `docs/evidence` while
> assertion 52a never consults it (REV-C-008, filed attached to REV-B-005) — a convention
> resting on either of those would be resting on a hole. R-9 re-ran both validators over
> all three probe branches' trees to size what the missing rule cost: `review/rev-a`,
> filed before the finding existed, is **architecture 94/95 · fable 35/36** — its two failures
> being 52a, on three `.ts` probe sources plus one `.sh` driver inside its own evidence
> bundle, and 10a, on the same three `.ts` sources (the fable list does not carry `.sh`);
> `review/rev-b` and `review/rev-c` are **95/95 · 36/36**. No probe branch is ever merged,
> which is the only reason this never reached `main`.
>
> **R-9.2 — a probe is composed-run-safe, or it is not left in the tree.** Three parts,
> each binding: (a) **a probe file never lands where a runner collects it** — anything
> authored inside a collected test root participates in every composed run from the
> moment it exists, tracked or not; (b) **a temporary in-repo probe is removed before any
> composed validation starts**, with the tree verified clean beforehand rather than
> inspected afterwards; (c) **a code-modifying probe is applied, measured, and
> byte-restored, with the applied diff recorded** in the reviewer's bundle. REV-C-011:
> "REV-A's `p2-audit-and-termination` probe is **not composed-run-safe**: it tampers with
> the audit chain as superuser with triggers disabled, so leaving it in the tree reddens
> `test/audit/chain.test.ts`. REV-C proved this the hard way by contaminating its own
> composed run #2 … and re-running it clean as #2R." And why it is a rule rather than a
> note: "the NR-14 clean-tree discipline covers **tracked** files, and an **untracked**
> probe under `apps/api/test/` is invisible to it while participating in every run." The
> practice already existed on both sides — REV-A's "Every probe this reviewer authored
> under `apps/api/test/rev-a/` was **removed** after the final run" and REV-C's "Every
> code-modifying probe was applied, measured, and restored, with the restore verified" —
> and it is REV-C's own declared hygiene failure that turns it from an assumption into a
> written requirement. **A composed run that collected a probe is invalidated, not
> interpreted:** it is re-run on a verified-clean tree, and both runs are reported.
>
> **R-9.3 — composed validation runs with the vitest results cache disabled, and evidence
> citing a composed green states that it did.** vitest's results cache schedules
> previously-**failed** files first, so the file ordering of a composed run is
> path-dependent on what happened to fail earlier on that particular machine — and
> therefore so is any green obtained on an order-dependent defect. Discovered in the
> **R-6 review (2026-08-23)** and routed here at R-6's acceptance: "the reviewer's
> discovery that vitest's results cache schedules previously-failed files first
> (composed-run greens are path-dependent; use `--no-cache`)". The cache is per-machine
> and concrete — `node_modules/.vite/vitest/<hash>/results.json`, carrying one `failed`
> flag per test file — so the requirement is satisfiable two ways: pass `--no-cache`, or
> begin from a verifiably clean cache state with that file absent. A composed green whose
> cache state is unrecorded is an unqualified claim and is to be reported as one, not
> read as a reproduction.
>
> **Checked against the packet texts above, sentence by sentence: none of them is
> falsified by these rules, and none is rewritten.** §3 never named a file extension and
> never named a directory called `probe-sources/` — that is REV-A's own bundle
> convention, not an instruction of this plan — so R-9.1 corrects no wording; it supplies
> the constraint that the composition of "author probes" with "evidence … ONLY under
> `docs/evidence/…`" always needed and never carried. "Local probe commits … pushed for
> durability, never merged" is unchanged, and its never-merged half is precisely why the
> omission cost `main` nothing. R-9.2 and R-9.3 likewise add to "execute batteries and
> author probes in the worktree" rather than replace it. The three reviews above were
> executed under the text as it stands; this amendment governs what is required of every
> probe after it.

## §4 Reviewer-independence rules

1. Each reviewer is a fresh high-effort Opus agent with no shared conversational
   context, launched from its packet text alone.
2. REV-B is blind to REV-A until REV-B's report is filed (enforced by launch order and
   packet content).
3. No reviewer implements any fix, ever.
4. Repair implementers are fresh Opus agents, never the reviewer who found the issue.
5. Delta verification of a repair returns to the original reviewer — the same agent
   continued where possible; where continuation is impossible, a fresh agent given the
   original report, the finding, and the repair diff, with which form was used recorded.
6. Fable executes no substantive review and no repair; Opus neither adjudicates
   findings nor decides the gate.

## §5 Finding format and adjudication procedure

**Format (per finding):** ID (`REV-A-001`…) · severity **BLOCKING / MAJOR / MINOR /
NOTE** · the claim attacked · exact reproduction (commands, outputs, exit codes) ·
affected capabilities / invariants / SPECs · evidence path.

**Adjudication (Fable, per finding, recorded as FADs in the control registers):**
accept or reject with exact evidence (rejection requires reproduced counter-evidence,
never preference); the reviewer's severity is preserved verbatim in the record —
no downgrade, no omission, no combining-away; affected capabilities and invariants
identified; the required regression proof defined; accepted findings assigned to
bounded repair packets with declared scope, allowed paths, and acceptance criteria.

## §6 Repair-packet procedure

For every accepted finding's packet: a fresh high-effort Opus implementer (never the
finding's reviewer) executes, in order: (1) reproduce or falsify the defect; (2) add a
failing regression test or equivalent load-bearing proof FIRST; (3) implement the
smallest correct repair; (4) run focused validation; (5) return to the original
reviewer; (6) delta verification by that reviewer; (7) the complete affected acceptance
battery. **At most two repair rounds with one implementer**; if a blocking finding
remains, the branch is preserved, Fable re-plans the packet, and a fresh implementer is
assigned.

## §7 Required final validation battery (serial, on the final candidate)

Fable docs validators (plan 36/36 · architecture 95/95 · research PASS) · `corepack
pnpm check` (17/17 gates) · the complete red-case battery (65/65 arms, both
directions — sharded in CI, with the union guard green; a serial local run is
equivalent evidence) · `fixture-regression` (fixed seeds + rotating) · `sbx` (9/9,
371 readings, 0 wrong-tenant, 53/53 tables) · **migration schema cycle on an empty
database, 0001–0020** · **the migration populated-cycle tests (six: 0014, 0016, 0017,
0018, 0019, 0020)** · real-stack e2e at both viewports · **fresh-clone validation
against `origin/main`** · **GitHub CI fully green on `main`** (gate battery + all
shards + shard completeness).

> **AMENDMENT 2026-08-23 (FAD-53, repair packet R-3; finding REV-A-002).** As
> committed, this section's sixth battery item read "migration populated cycle
> 0001–0019". That wording was inherited verbatim from doc 36 §6 row 5 / EV-M4-005 §24
> row 5, and REV-A falsified it: the transcript behind it executes
> `test/support/migrate-cycle-cli.ts`, which "destroys and re-initialises the data
> directory and seeds nothing — its own docblock says 'the up migration applies to an
> **empty** database'". One item has therefore become two, naming what is actually
> executed: (a) the **schema** cycle on an empty database, and (b) the
> **populated**-cycle tests, which exist for six migrations only — 0014, 0016, 0017,
> 0018 and 0019 at the M4 baseline, plus 0020 added by repair packet R-5. The range is
> also updated from 0001–0019 to **0001–0020**, migration 0020 having been added by
> R-5. Nothing is relaxed: the schema cycle's scope is unchanged and the populated
> cycles are now demanded by name rather than implied. The frozen milestone records
> (doc 36, EV-M4-005) are **not** retro-edited — FAD-53 rules them record-only and
> carries the correction, and this amendment is the plan-side half of that ruling.

## §8 GitHub branch, pull-request and evidence strategy

- Plan, reports, evidence indexes, adjudications, and control-doc updates land through
  `claude/*` task branches → draft PR → green CI → merge (the repository's
  acceptance-per-commit convention; merge commit preserving packet commits).
- Probe branches `review/rev-{a,b,c}` are pushed for durability and never merged.
- Review evidence bundles are committed under `docs/evidence/EV-REVIEW-{A,B,C}/`.
- Each repair packet gets its own commit with its acceptance record; merges are serial.
- AUTO-RUN-STATE is updated at every stage transition; findings and rulings are
  recorded as FADs in ARCHITECTURE-DECISIONS.md.

## §9 Exit criteria — the replacement gate passes only when ALL hold

1. This plan is committed (with the §10 ratification recorded).
2. All three Opus reports (REV-A, REV-B, REV-C) are complete per their completion
   criteria.
3. REV-C recommends **ACCEPT**.
4. Every valid finding is resolved through §6.
5. No confirmed functional defect remains.
6. Original reviewers have delta-verified their findings' corrections.
7. The complete serial validation battery (§7) passes.
8. GitHub CI passes on `main`.
9. All required pull requests are merged.
10. Fresh-clone validation passes against `origin/main`.
11. Control and evidence documents accurately reflect the outcome.

On gate pass: M3R reconciliation completes (per the continuous authorization §C, fed by
these findings), then the prototype-enablement checkpoint, then M5 — automatically,
under the continuous GitHub authorization.

## §10 Fable ratification record

| Check | Verdict |
| --- | --- |
| Complete — every section the owner's protocol requires is present (baseline, surface, packets, independence, adjudication, repairs, battery, GitHub strategy, exit criteria) | **PASS** |
| Internally consistent — packet scopes are disjoint where they must be and jointly cover the owner's enumerations; the delta rule cannot contradict the frozen-record rule; §6's two-round cap composes with §5's no-downgrade rule | **PASS** |
| Non-vacuous — every packet names executable probes with pass/fail consequences; completion criteria demand executed evidence or an explicit not-executable declaration, never silence | **PASS** |
| Mapped to the complete M1–M4 surface — 58 capabilities, I-01..I-22, SPEC-01..16, ADRs, FADs 1–52, QA + SBX-001..017, all four exit reports and evidence bundles, doc 36 limitations, carried risks, M3R findings, registered follow-ups GH-004/008/009 | **PASS** |

**Ratified by the Fable orchestrator 2026-08-23, under the 2026-08-22 owner direction.
Review execution may begin: REV-A first.**
