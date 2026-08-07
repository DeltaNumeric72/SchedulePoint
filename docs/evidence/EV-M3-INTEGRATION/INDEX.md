# EV-M3-INTEGRATION — OPUS-M3-008, integration and hardening

The last M3 packet. What follows is what was built, what was measured, what was
**not** done, and what needs a ruling.

| Document | What it holds |
|---|---|
| [`step-06-node-kinds.md`](step-06-node-kinds.md) | The EVALUATED / NOT-EVALUABLE table for all 30 rule-node kinds, with the reason per kind and the rulings that would move them — **the escalation list** |
| [`qa-sch-battery.md`](qa-sch-battery.md) | QA-SCH-001..016 filed per case: pass / partial-with-the-unclaimed-half-named / not-applicable-with-owner |
| [`spec-14-automatable-cells.md`](spec-14-automatable-cells.md) | The `A` cells executed; the ten `M` cells listed and **unclaimed**, owned by M6 |
| [`commands/`](commands/) | Verbatim output for every acceptance command (the red-case transcript trimmed to its verdicts — see its header) |
| [`screenshots/`](screenshots/README.md) | The M3-exit browser evidence: the three captures composition changed, plus the map of which per-packet bundle holds every other surface and state |

---

## 0. The acceptance run — measured, with exit codes

Every number below is from `commands/acceptance-run.txt` and
`commands/final-verification.txt`, both captured verbatim.

| Command | Result |
|---|---|
| `corepack pnpm check` | **13/13 PASS**, exit 0 · **1384 tests across 109 files** (the whole workspace: domain, contracts, api, web, gates) |
| `corepack pnpm red-cases` | **21/21 PROVEN**, exit 0 (the 21st is this packet's `nr14-clean-tree`) — re-run on the final tree after §3a's fixes, transcript in `commands/red-cases-output.txt` |
| `corepack pnpm fixture-regression` | **102/102 run(s) passed**, exit 0 — 13 fixed seeds + rotating seed 757688 under file- AND test-order shuffle, the per-file standalone sweep, and the baseline-immutability control. Its per-seed runs are the **api project alone** (965 tests), which is why they report a smaller count than `check`'s — an earlier version of this row mis-attributed that api-only number to `check` (N-1). **Fixed seed 8675309 passes**, which is O-1's proof |
| migration cycle | **exit 0** — `0001..0011`, up → down → up → down → up, 1058 ms |
| SBX battery | **exit 0** — 6 required, 6 executed, 6 passed, **0 blocked, 0 vacuous, 0 probe-error**; every probe `FALSIFIABLE` |
| `git status --porcelain` after a plain battery | **EMPTY** — the NR-14 end-to-end proof (§3), measured after `check`, after `fixture-regression`, and after `red-cases` |

**One failure is recorded rather than hidden.** An earlier `fixture-regression`
run reported fixed seed 531651 failing `unit-of-work.test.ts`'s T-15
two-organization concurrency storm. It did not reproduce: the same seed passes
958/958 both standalone and in a clean full run, and the failing run took 49.1 s
against a normal 37 s while a second suite was running on the machine. Recorded
as **contention, re-proven serially** — the same diagnosis and the same treatment
the runbook's port-collision note prescribes. It is named here because a
suppressed intermittent failure is worse than a documented one.

---

## 1. The deliverables, one line each

| # | Deliverable | State | Where |
|---|---|---|---|
| 1 | **SPEC-05 §6 step 06 — HARD-rule re-validation at publication** | **DONE**, red-cased both ways | `packages/domain/src/rules/hard-rule-check.ts`, `apps/api/src/schedule/hard-rule-revalidation.ts`, `publication.ts` step 06 |
| 2 | Qualification eligibility + **expiry vs assignment date** | **DONE**, mid-period-expiry fixture | `step-06-hard-rules.test.ts` §qualification expiry |
| 3 | The **audit READ API** (FAD-26) + M3-005's publication audit display completed against it | **DONE**; `audit.read` proposed for FAD ratification | `apps/api/src/audit/reader.ts`, `audit.route.ts`, `PublishedSchedulePage.tsx` |
| 4 | The audit-verification **group-scope false-alarm fix** (N-8) | **DONE**, at the SQL function, red-cased | migration `0011`, `apps/api/test/audit/read-surface.test.ts` |
| 5 | The **holiday-calendar key split** (FAD-25 / D-10) | **DONE**, proven over the real routes | `group.holiday_calendar.read`, `apps/api/test/catalogue/holiday-key-split.test.ts` |
| 6 | **Migration 0011** — the two pre-approved items only | **DONE** | `0011_period_length_and_audit_scope.sql` |
| 7 | **NR-14 redesign** | **DONE**, four writers, red-cased | `scripts/evidence-target.mjs` + three mirrors |
| 8 | **Preview-port worktree derivation** (E-2) | **DONE** | `scripts/sbx/test-port.mjs`, `apps/web/playwright.config.ts` |
| 9 | Composed-system proofs | **DONE** | `apps/api/test/schedule/composed-integration.test.ts` |
| 10 | **QA-SCH manual-path battery** | **DONE**, filed per case | [`qa-sch-battery.md`](qa-sch-battery.md) |
| 11 | **SPEC-14 automatable cells** | **DONE**; real-AT cells unclaimed | [`spec-14-automatable-cells.md`](spec-14-automatable-cells.md) |
| 12a | SBX-004 stale "coverage gap" line | **DONE** — the false hand-kept claim is removed, not replaced with a better hand-kept one |
| 12b | PostgresError→404 mapping follow-up | **DONE** — log-and-distinguish, **no disclosure change** | `classifyPgFailure` in `apps/api/src/db/pg-errors.ts` |
| 12c | Plain-anchor publication section nav → router links | **DONE** | `PublicationLayout.tsx` |
| 12d | Settings-page consolidation | **NOT DONE** — see §5 | — |
| 13 | Consolidated real-browser evidence | **DONE** | `screenshots/` and the per-packet bundles |

---

## 2. Step 06 — the thing this packet exists for

Before this packet, **a manually authored schedule could be published without any
scheduling rule being evaluated against it at all.** SPEC-05 §6 has always had a
step 06 — `assert every HARD rule re-validated` — and M3-003 left it
unimplemented on purpose, because the typed rule model was a parallel packet and
§6 forbade the join outside the integration packet. This is that packet.

**What it is:** one bounded, deterministic pass per active HARD rule over the
assignments that already exist. **What it is not:** a solver. There is no search,
no objective, no relaxation, and nothing that produces an assignment. SPEC-04
§3.3 names this component separately — "an **independent checker**" — and
building it before M4 is what makes M4's output checkable rather than trusted.

**Six** of the thirty node kinds are evaluated; twenty-four carry a stated reason
and **block** rather than pass. The full table, with the rulings that would move
each, is in [`step-06-node-kinds.md`](step-06-node-kinds.md).

`CallSpacing` is the sixth, and it is there because the independent review found
its recorded reason was **factually false** (B-2). It said "no shift-type
attribute distinguishes a call" — but `shift_types.is_on_call` shipped in
migration 0005 at M2, is typed as `isOnCall` in the domain and the contracts, and
the revalidation loader already joined `shift_types`. The gap was one unselected
column, and the falsehood had propagated into the owner-ruling document, asking
for a decision about building something that already existed. It is evaluated
now, with eleven adversarial tests (month, year, leap-day and DST boundaries; the
non-call arm and its control; per-membership scoping; input-order independence).

### The falsifiability proof

A refused publication proves nothing on its own — it could be step 03, step 05,
the period lock, a constraint, or a typo. So:

```
the SAME version, one fact apart
  · with the HARD rule active   → HardRuleBreachError, version still `approved`,
                                  zero rows in current_published_assignments
  · with the rule `disabled`     → publishes
```

and for the qualification case the falsification moves the **credential**, not
the rule: the same content under the same active rule publishes once the holding
is renewed. `apps/api/test/schedule/step-06-hard-rules.test.ts`.

---

## 3. NR-14 — and the thing it caught about itself

The redesign: a plain `pnpm check` / `pnpm red-cases` / `pnpm sbx` writes under
the git-ignored `.evidence-scratch/`; `--refresh` writes the tracked artifacts.
The relative paths are unchanged, so a refreshed run lands everything exactly
where it always did.

**The first pass was wrong and the redesign caught it.** Three transcript writers
were redirected; a plain `pnpm check` then still left **seventy-odd modified
PNGs**, because every `capture()` in `apps/web/e2e/` wrote straight into a tracked
bundle and a re-encoded PNG differs byte-for-byte even when the page is
identical. That is the redesign's own lesson arriving on schedule — a rule
enforced at three call sites is a rule the fourth does not have — and it is why
the check **scans for writers** rather than trusting a list.

Four writers now resolve through `evidence-target`:

| Writer | Artifact |
|---|---|
| `scripts/check.mjs` | `scripts/check-output.txt` |
| `scripts/red-cases/run.mjs` | `scripts/red-cases/evidence-output.txt` |
| `apps/api/test/sbx/sbx.test.ts` | every SPEC-16 `retainedArtifact` |
| `apps/web/e2e/support/evidence-target.ts` | every screenshot in every bundle |

**The writer list is DISCOVERED, not kept** (N-8). It was a hand-kept array of
four paths — the stale-list class this packet removed from SBX-004's coverage
line and then reintroduced two files later. `clean-tree.mjs` now scans
`git ls-files` for files that both name an evidence destination (or call
`page.screenshot`, the shape the first pass missed) **and** call a write
primitive, with comments stripped so a docblock citation is not mistaken for a
write, and a short allow-list whose every entry states why it is a reader. The
unit-gate test no longer duplicates the scan — it **runs** this one.

The red case (`nr14-clean-tree`) is green on the real tree and red when
`scripts/check.mjs` is patched back to its unconditional write. The discovery was
independently red-cased against a file it was never told about: pointing
`rules.spec.ts` at a hard-coded `docs/evidence/…` path makes it fail and name
that file, and restoring the resolver call makes it pass. **The end-to-end
measurement — a real battery run followed by `git status --porcelain` — is in
`commands/`, not folded into the red case**: a battery inside the red-case runner
would be a battery inside a battery, and the two claims are recorded separately
rather than one being passed off as the other.

**The restore-with-`git checkout --` discipline is retired.** It was used exactly
once more, on purpose: to restore the seventy-odd PNGs the first pass had already
dirtied.

---

## 3a. E-2's derivation, and the control that did not see it

The preview port is now derived per worktree exactly as the database port is, so
two concurrent worktrees can both run the `axe` gate. The measurement is in the
acceptance transcript: `vite preview --port 42047 --strictPort` — a derived port,
not `4173`.

**The first version of it was wrong in the way this repository has a comment
about.** `deriveTestPgPort`'s docblock says a raw NUL separator is "load-bearing
and invisible, and neither a reader nor grep can see it", and spells it `\u0000`
for that reason. The new function was written with a **literal NUL byte in the
source** while `apps/web/playwright.config.ts`'s mirror had a **space** — so the
two implementations derived different ports.

**The equality control passed anyway.** It compared the two constants and the
string `sp.test.preview.port.v1` as TEXT; both files contained that string, and
neither separator is visible. A control that exists to catch drift between two
implementations was comparing their wording.

Both halves are fixed:

  - the separator is a visible `:` in both files — greppable, and impossible to
    get wrong by copying. (The database port keeps its `\u0000`: changing it
    would move every derived database port. This one is new here and has no
    history to preserve.)
  - the test now extracts the separator from each file, compares it **byte for
    byte**, asserts it contains no `\u0000` and no leading/trailing whitespace,
    and **recomputes the config's derivation** from its own extracted separator
    to compare the derived port NUMBERS root by root.

Red-cased: with the config's separator changed back to a space, the strengthened
test fails naming "the config and the script derive different preview ports";
with it restored, 5/5.

### …and a THIRD fixed port was still there (O-1)

`apps/api/test/red-cases/gates-fail-on-violations.test.ts` spawns the whole api
project from inside a test — globalSetup, cluster daemon and all — to prove the
unit gate exits non-zero on a failing spec. That nested run had a hard-coded
`SP_TEST_PG_PORT: '55455'`.

Same class, same failure: under two concurrent batteries the nested runs
collided, that RED arm failed, and **fixed seed 8675309** reported a failure that
passes 12/12 serially. **OPUS-M3-002 had already recorded it, at the same seed.**
FAD-15 ruling 3 says a seed failure is a defect to fix; twice is once too many.

The nested port is now derived — `DERIVED_NESTED_PORT_BASE = 55900`, with the
offset taken from `deriveTestPgPort`'s **own digest**, so the two ports move
together and two worktrees collide on a nested port only when they already
collide on the main one. `SP_TEST_NESTED_PG_PORT` overrides it; a nested port
equal to the outer one throws rather than nesting a run onto its parent's
cluster. **The RED arm's assertion is untouched** — only the port it spawns on
moved.

Two controls, to the standard the preview-port fix raised: the JS and TS
derivations are compared **by value** root by root, and the test tree is
**scanned** for any remaining literal `SP_TEST_PG_PORT: '<digits>'`, with the
scan proven to fire on the exact text that stood at line 470 (and its probe
assembled from two halves, because the first version of it found itself).

### …and the NR-14 check had the same shape of weakness

Verifying the fix surfaced one more: `nr14-clean-tree` asked `git status
--porcelain` **once, after** its probe write, and failed on any dirty
`docs/evidence/…` path. So it reported a failure against an `INDEX.md` that was
simply being edited at the time — "is the tree clean?" rather than "did this
write dirty anything?", which are different questions and only the second is the
check's business.

The porcelain is now taken **before and after** and only NEWLY dirty paths count.

---

## 4. Four defects found by RUNNING rather than by reading

1. **Migration 0011 never applied its up section.** It had no `-- Up Migration`
   marker, so `node-pg-migrate` recorded it as applied while executing nothing —
   the period CHECK was absent and the audit guard was not there, and the
   migration table said everything was fine. It was caught by the audit-scope
   test **failing to be rejected**. Worth stating plainly: a migration that
   silently applies nothing is indistinguishable from one that worked, unless
   something asserts the behaviour it was supposed to install.
2. **NR-14's screenshot writer** (§3).
3. **The preview-port separator** (§3a) — found by `git diff` reporting
   `scripts/sbx/test-port.mjs | Bin 4303 -> 7190 bytes`. A source file that git
   has started calling *binary* is a source file with a byte in it that nobody
   typed on purpose.
4. **The nested cluster port** (§3a) — found by a fixed seed failing under
   concurrent load, for the second time in the project's history.

All four are the same shape as this repository's recurring finding: **the
artifact that looks correct is the one nobody executed.** In two of them the
control had even been written — it was just checking the wrong thing.

**And one more, found by READING**: a literal NUL byte at
`packages/domain/src/rules/hard-rule-check.ts:83` made the packet's most
load-bearing file binary to `git diff` — so blame and every diff-based review
tool were blind to it. It was in a docblock describing a keyed map that the
interface never had. The docblock now describes the function that exists, which
removes the falsehood and the need for any separator at all. **Every changed
file is byte-scanned for NULs and the count is zero.**

---

## 5. What was NOT done, and why

**The settings-page consolidation (docket item: two "Group settings" pages →
one).** Not done.

There are two pages titled *Group settings*: `/catalogue/group-settings` (pick
positions, holiday calendar) and `/settings/group` (request-until, picklist
access, timezone). Merging them is a UI refactor whose blast radius is the e2e
suite for **both** surfaces — the catalogue spec's two group-settings tests mock
the catalogue endpoints, the settings spec's mock the settings tree, and a merged
page needs both sets on every test in both files. Verifying it means another full
axe cycle (≈3 minutes per arm, both viewports) with a real chance of the same
class of breakage the blocker-schema change caused earlier in this packet.

It was deprioritised against the load-bearing deliverables and is recorded rather
than attempted-and-half-finished. **Recommendation:** merge into `/settings/group`
as a third panel group, delete the catalogue route and its nav entry, and move
the two e2e tests into `settings.spec.ts` with the catalogue mocks added to that
file's happy path. No capability changes — each panel already renders its own
denial state independently, which is the property that makes the merge safe.

---

## 6. Ratifications this packet needs

| # | Proposal | Why it is a FAD and not a decision I may make |
|---|---|---|
| 1 | **`audit.read`** — a new group-scoped, **grant-only** action key, in `core_scheduling` | It is an additive vocabulary change (the established class), and its MODULE deliberately diverges from `audit.export`'s `reporting_documents`: an organization that runs schedules but buys no reporting module must still be able to see who published its own rota, and ruling otherwise would be making a PO-DEC-04 packaging decision. **No CAP-### is added; the 58-capability baseline is unchanged** |
| 2 | **`group.holiday_calendar.read`** — the FAD-25-assigned split | Additive; role-implied for scheduler and group_admin. It NARROWS one population, stated rather than hidden: a grant-holder of `schedule.catalogue.administer` who holds neither role no longer reads holidays through that grant. Nobody is constructed that way today, and leaving reads on the catalogue key is what FAD-25 forbids |
| 3 | **An unevaluable HARD rule BLOCKS publication** | It is the reading of SPEC-04 §3.3 I believe is correct — "skipped by any code path" admits no exception — but it is a product-visible refusal, and it cost one fixture change. Put forward for ruling with its blast radius measured ([`step-06-node-kinds.md`](step-06-node-kinds.md) §1) |
| 4 | **The 25 NOT-EVALUABLE kinds** | Eleven are one ruling away each. The list, with the ruling each needs, is §5 of [`step-06-node-kinds.md`](step-06-node-kinds.md) |
| 5 | **`publicationBlockerSchema` gains `ruleKey`** | A required contract field, so a blocker names the rule a scheduler must go and open rather than burying it in prose |

---

## 7. Limitations, stated

- **The step-06 review preview is not the control.** `computeBlockers` runs the
  same checker so the scheduler sees what the server will do, but the control is
  step 06 inside the transaction, which re-runs afterwards and can refuse a
  publication this preview passed. A credential expiring between the two is
  exactly that case, and the surface says so.
- **`audit.read` is held by no role.** The publication audit display therefore
  renders a stated not-authorized panel until somebody grants it. That is the
  deny-by-default posture working, not an oversight.
- **The audit read is not a verification.** It is group-scoped and its sequence
  numbers have gaps by construction; the wire says so on every response. Chain
  verification stays organization-scoped and the SQL function now refuses a
  group-scoped call outright.
- **QA-SCH-001's acknowledgement half, QA-SCH-005's non-manual paths,
  QA-SCH-010's delivery-status surface, QA-SCH-013's archived marker and
  QA-SCH-014's PERF fixture are NOT claimed.** Each names its owner in
  [`qa-sch-battery.md`](qa-sch-battery.md).
- **Ten SPEC-14 manual cells are unclaimed and no AT combination is claimed as
  supported.** axe green at two viewports says the markup lacks the violations
  axe knows about; it does not say a screen-reader user can schedule a rota.
