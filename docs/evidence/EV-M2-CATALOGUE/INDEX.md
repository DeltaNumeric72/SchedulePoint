# EV-M2-CATALOGUE — OPUS-M2-002 evidence bundle

**Task:** OPUS-M2-002 — shift-type catalogue, shift groups, staff groups, valid
combinations, per-shift-type weekday+holiday demand, the group holiday calendar,
and the product's **first UI surface**.
**Capabilities:** CAP-011, CAP-012, and the CAP-004 holiday slice (CAR-011).
**Branch:** `opus/m2-002-catalogue`, from `main` at `20b9f7f`.

---

## 1. Contents

| File | What it is |
|---|---|
| [`field-mapping.md`](field-mapping.md) | **The deliverable of record.** Every concept in the owner's observed list → its column or mechanism, with every deliberate divergence stated and justified. 31 rows, zero dropped |
| [`spec-14-matrix.md`](spec-14-matrix.md) | New SPEC-14 §2 component rows, in the spec's own format, with the evidence for each cell and an explicit list of the `M` cells that are therefore **not** claimed |
| [`check-output.txt`](check-output.txt) | `corepack pnpm check` — 12/12 gates, from clean |
| [`red-cases-output.txt`](red-cases-output.txt) | `corepack pnpm red-cases` — 14/14 proven |
| [`fixture-regression.txt`](fixture-regression.txt) | `corepack pnpm fixture-regression` — 47/47 runs, 11 fixed seeds + rotating, both shuffles, full standalone sweep, Layer-1 control |
| [`sbx-run.txt`](sbx-run.txt) | `corepack pnpm sbx` — the re-run required by packet 30 §7.2. SBX-004 observes **21 of 21** probed tables with visible rows and zero wrong-tenant. `docs/evidence/EV-M2-SBX/` is regenerated from this same run and committed (S-09) |
| [`named-proofs.txt`](named-proofs.txt) | The three named-condition proofs in **all three modes**: standalone, in-package, in the complete battery |
| [`deny-paths-and-audit.txt`](deny-paths-and-audit.txt) | Allow **and** deny for every new capability, and the ten mutations → ten audit rows |
| [`migration-cycle.txt`](migration-cycle.txt) | up → down → up → down → up, clean, with 0004 included |
| [`axe-output.txt`](axe-output.txt) | 36 e2e tests at 1280×800 and 390×844, zero axe violations |
| [`contrast.txt`](contrast.txt) | 24 computed contrast pairs, from `apps/web/scripts/contrast.mjs` |
| [`screenshots/`](screenshots/) | 12 UI states × 2 viewports = 24 files |

## 2. Commands, with results

| Command | Result |
|---|---|
| `corepack pnpm install` | clean |
| `corepack pnpm check` (baseline, before any change) | **12/12 PASS**, 585 tests |
| `corepack pnpm check` (first submission) | 12/12 PASS, 663 tests — superseded |
| `corepack pnpm check` (after the review revision) | 12/12 PASS, 695 tests / 51 files — superseded by the rebase |
| `corepack pnpm check` (**final, rebased onto M2-003**) | **12/12 PASS**, **850 tests across 61 files** |
| `corepack pnpm red-cases` | **14 case(s): 14 proven, 0 not proven** |
| `corepack pnpm fixture-regression` | **57 run(s): 57 passed, 0 failed** — "Order-independent under every seed tried. Every file also passes alone. The shared baseline was unmodified in every run" |
| `corepack pnpm sbx` | **SBX-001/002/004/005 PASS · SBX-006 EVIDENCE_BLOCKED(authn milestone)**; 0 vacuous; **25 of 25 column-probed tables observed with visible rows**, 175 readings, 0 wrong-tenant; role × route matrix 13 × 31 = 403 cells, 0 unclassified |
| migration cycle | **CLEAN — up → down → up → down → up** |
| named proofs, three modes | all three green in all three modes (§4) |

## 2.1 The merged reality (rebased onto `e6623cd`)

This branch was rebased onto main **after OPUS-M2-003 merged**, and the numbers
above are from that merged state. The migration is renumbered
`0004_shift_catalogue.sql` → **`0005_shift_catalogue.sql`** (24 §E: the second
merger rebases and renumbers); its content is otherwise identical, and it
depends on no table M2-003's 0004 creates.

**`TENANT_TABLES` holds 26 entries** — 13 from M1, 4 from M2-003, 9 from
M2-002. The SBX-004 sweep reports **25 of 25**: `users` is `through-membership`
and is probed on its own terms rather than by a tenant column, so the
column-probed set is 25 and the registry total is 26. Stated as measured rather
than as predicted.

## 3. Packet 30 §7.2 — the new tables in the SBX-004 sweep

Every one of the nine, **observed with visible rows** under a group-scoped
context, zero wrong-tenant (from `sbx-run.txt`, "per-table visibility"):

```
shift_types: max 2 visible (app_runtime/runtime/group-one)
shift_type_weekday_demand: max 6 visible (app_runtime/runtime/group-one)
shift_groups: max 1 visible (app_runtime/runtime/group-one)
shift_group_members: max 2 visible (app_runtime/runtime/group-one)
staff_groups: max 1 visible (app_runtime/runtime/group-one)
staff_group_members: max 1 visible (app_runtime/runtime/group-one)
valid_groups: max 1 visible (app_runtime/runtime/group-one)
valid_group_shift_types: max 2 visible (app_runtime/runtime/group-one)
group_holidays: max 1 visible (app_runtime/runtime/group-one)
```

SBX-001's role × route matrix: **13 principals × 23 routes = 299 cells; 30 allow,
231 clean deny (403/404), 12 context refusal (409), 26 body refusal (422,
reachable only after an allow), 0 unclassified.**

## 4. The three named-condition proofs

| # | Proof | Standalone | In-package | In battery |
|---|---|---|---|---|
| 1 | A referenced shift type cannot be hard-deleted (database level) | 5/5 | 5/5 | 5/5 |
| 2 | Pick-position monotonicity under concurrent increase attempts | 4/4 | 4/4 | 4/4 |
| 3 | Cross-tenant catalogue sweep, zero rows — **now with a non-vacuous cross-GROUP arm** | 7/7 | 7/7 | 7/7 |
| 3b | The sweep's own mutation test: the reviewer's policy mutation makes it FAIL | 4/4 | 4/4 | 4/4 |
| 4 | The S-02..S-05 review regressions, plus the two clock-resolution defects the rebase exposed | 15/15 | 15/15 | 15/15 |

Each carries an **ALLOW control** so a pass cannot be vacuous: an unreferenced
shift type IS deletable by the owner before the referenced one is refused; a
plain increase IS accepted before a decrease is refused; both tenants really
hold catalogue rows before either sweep reports zero, and the sweep reports
`wrong > 0` when measured against the wrong expectation.

## 5. Findings from running it

Five things were found by execution rather than by reading, and each was fixed
rather than worked around.

| # | Found by | What it was |
|---|---|---|
| 1 | **SBX-001** | The catalogue routes parsed the request body **before** authorizing, so an actor holding nothing in the group could send `{}` and be told which fields the route expects, while a genuinely absent route answers 404. The body is now parsed inside the unit of work after the decision; a schema failure is a 422 rather than a 400; and the ordering is asserted in both directions |
| 2 | **`pnpm fixture-regression`** | Genuine order dependence in four of this task's own tests — 12 of 47 runs failed on the first attempt. `pick_position_count` is monotonic and cannot be reset, so every absolute expectation was an assertion about which test ran first. Every test now reads the current value and asserts a relative outcome |
| 3 | **the e2e run** | A six-column table cannot fit 320px. Below 640px the rows now render as a list — **chosen, not hidden**, so the accessibility tree holds one copy |
| 4 | **the e2e run** | `useId()` returns `:r0:`, and a colon in an id makes `href="#:r0:-code"` unusable as a CSS selector even though the browser's own fragment navigation copes |
| 5 | **the e2e run** | The skip link was 16px tall once focused |

Plus one defect found by the API suite: node-postgres parses `date` into a
`Date`, so every holiday response failed its own contract parse with a 500. The
calendar date is now rendered from local components rather than `toISOString()`,
which west of UTC would have shifted a holiday to the previous day.

### 5.1 The independent review's findings, and where each is closed

| # | Finding | Closed by |
|---|---|---|
| **S-01** *(blocking)* | The sweep's cross-GROUP arm was **vacuous** — one group per organization meant "zero rows from the sibling" measured an empty table, and a CAR-001-class policy mutation left all six tests green | The fixture seeds a sibling group; the sweep asserts per table, from ground truth, that the measurement CAN be non-zero; the false docblock is corrected; `sweep-mutation.test.ts` runs the reviewer's exact mutation rolled back, sees all nine tables report violations, and verifies the policies came back from a fresh connection |
| **S-02** | `groups_guard_pick_position_count` was `BEFORE UPDATE` only — an INSERT with `pick_position_count = 500` was accepted ungated, and monotonicity made it permanent | `BEFORE INSERT OR UPDATE`, gating a non-zero INSERT; both paths regression-tested with a control proving default group creation stays ungated |
| **S-03** | Effective dating was `created_at` in disguise | Windows authorable on create and update with validation; in-force read filtering carried to M4 by ruling; field-mapping row 20 states the split |
| **S-04** | `readPickPositionCount` was an **arbitrary-row read** — a random group's count under an organization context (the M1 S-01 class) | Both read and write pin the tenant; the organization-scoped call now refuses with a named error rather than guessing; the write is proven to move exactly one group |
| **S-05** | `version` was carried but was not a control — settable by `app_runtime`, and a lost update was demonstrated | Database-maintained by trigger, out of every UPDATE grant, and the service UPDATE carries `WHERE version = what it read`; the lost update is reproduced at the layer the predicate defends and refused, with a sequential-edit control |
| **S-06** *(+ delta U-05)* | `ON DELETE RESTRICT` was claimed in **three** places, not two — the migration header, this bundle's field-mapping row 19, and the archive proof's own docblock. The constraints are `NO ACTION` | All three corrected, each stating why the behaviour is equivalent here: both raise `23503`, and they differ only in when the check runs — nothing defers a constraint. The third instance was not itemised in the review; it is corrected and disclosed rather than left because nobody named it |
| **S-07** | INDEX test counts did not match the evidence | Corrected throughout §2 |
| **S-08** | `heading-order` (moderate) on the authoring form and validation state | Headings corrected to `h2`; the axe run includes `best-practice`; the run **asserts `heading-order` was actually selected**, so a mis-spelled tag cannot buy a weaker check behind a stronger claim |
| **S-09** | The committed EV-M2-SBX bundle described a 13-table sweep | Regenerated from a final `pnpm sbx` on this branch — 21 of 21 tables observed with visible rows, 147 readings, 0 wrong-tenant |
| **S-10** | Scheduler cannot read holidays | No fix; recorded as D-10, a product question for the integration packet |
| **S-11 / S-12** | — | Stand as recorded; no action |

One further order dependence was found **by the harness rather than by reading**
during this revision: the new S-04 control asserted an absolute pick-position
count, which is an assertion about which test ran first. Made relative;
`fixture-regression` went from 43/49 to 49/49.

### 5.2 Two defects the REBASE exposed, found by the shuffled run

The first shuffled full-suite run after the rebase failed one test under one
seed, and passed that same seed on re-run — a timing failure, not order
dependence. Chased rather than retried, it was two real defects, both from
mixing a **microsecond** database timestamp with a **millisecond** JavaScript
`Date` across `shift_types_window`:

| # | Defect | Why it matters beyond the test |
|---|---|---|
| 1 | The retirement instant came from the application | A type created and retired inside the same millisecond truncated to at-or-before its own start. **And deterministically**, once S-03 made windows authorable, a definition coming into force next year **could not be retired at all** |
| 2 | Every update rewrote `effective_from`/`effective_to` from values it had just read | A lossy round trip. Retiring a future-dated type produces a one-microsecond window; rewriting it truncated it onto its own start, so **an edit that never mentioned the window made a valid row invalid** |

Fixed at the source: the retirement instant is
`greatest(now(), effective_from + 1 microsecond)` — the database's clock, never
before the window opened — and untouched window columns are no longer written at
all. Both are regression-tested **deterministically**, because a future-dated
retirement always produces the sub-millisecond window; neither test depends on
two statements landing in the same millisecond.

## 6. Deviations and limitations, recorded rather than implied

| # | Item | Status |
|---|---|---|
| **D-1** | **Catalogue fixture seeding is per-file, not in `provisionMulti`.** Packet §7.2 requires the nine new tables to be non-vacuous in the SBX-004 sweep and in every probe that iterates `TENANT_TABLES`; packet §5/§7.6 forbids mutating the MULTI provisioning script. Both cannot be satisfied by the structurally correct fix. `apps/api/test/support/catalogue-fixture.ts` is additive and per-file, `multi.ts` is untouched, and nothing is weakened — but the right home for this is `provisionMulti`, and it needs a ruling. **ESCALATED in the return report** |
| **D-2** | **Four M1/M2-001 test files gained a one-line seeding call** (`unit-of-work`, `probe-is-not-vacuous`, `sbx.test.ts`) plus `scenarios.ts`'s fourth outcome class and `sbx.test.ts`'s registry-derived table count. Each addition strengthens the assertion; none weakens one. Disclosed here and in the return report |
| **D-3** | **No request-budget ledger entry for the catalogue interactions.** `scripts/gates/request-budget/budgets.json` is under `scripts/gates/**`, a prohibited path, and an unbudgeted recording fails the gate. I-10 is instead asserted inline in `e2e/catalogue.spec.ts` (one Save, one request; zero requests on New). The ledger entry belongs in the integration packet |
| **D-4** | **No `schedule.catalogue.read` capability.** Reads are gated by the same key as writes. Inventing a read capability means inventing which roles hold it, and doc 08 §6 has no "view catalogue" row. Deny-by-default is the correct direction to be wrong in (I-02); the surfaces that later need to READ shift types declare their own actions |
| **D-5** | **The e2e run intercepts the API at the browser's network boundary.** There is no authentication subsystem, so the browser cannot reach the real API as a real principal. The component tree, router, contracts, zod parses and rendering are all real; only the bytes are supplied. What the server actually produces is proven separately, over HTTP against the real database, in `apps/api/test/catalogue/` |
| **D-6** | **Request eligibility is DATA, not behaviour.** `allow_on_request`, `allow_off_request` and `shift_groups.allow_request` are stored, constrained and audited; the request lifecycle is M5 |
| **D-7** | **Every `M` cell in the SPEC-14 rows is unclaimed.** No screen-reader session has been recorded for these components; `G-BETA`/`G-PROD` remain not passed for CAP-066 |
| **D-8** | **`shift_type_qualifications` is not created and not referenced** — integration-packet scope, per packet §5 |
| **D-9** *(S-03(b) ruling)* | **In-force READ filtering is carried forward to M4.** The windows are authorable here; selecting the row in force at an instant belongs where the catalogue becomes engine input, using OPUS-M2-003's shared in-force loader rather than a second implementation. The authoring list deliberately returns future-dated and expired definitions — hiding them would make them uneditable. Field-mapping row 20 states the split |
| **D-10** *(S-10, no fix)* | **A scheduler cannot read the group holiday calendar.** `group.holiday_calendar.administer` is a group-administrator key (doc 08 §6 "Group settings"), and reads are gated by the same key as writes (D-4), so a scheduler authoring shift-type demand cannot see which dates the `holiday` demand row applies to. That may well be wrong as product design — it is recorded as a **product question for the integration packet**, not decided here |
| **D-11** *(S-05 follow-up)* | **`expectedVersion` is not on the wire.** Optimistic concurrency is enforced within one unit of work: the service's own read and write. A client that read a row minutes ago and submits a stale edit still merges onto current state. Putting `expectedVersion` in the contracts is the fix, and it belongs to the UI slice that needs to show "someone else changed this" — recorded as a follow-up under Fable's ruling rather than added speculatively here |

## 7. What this bundle does NOT claim

* No gate is marked passed. Only evidence closes a gate, and the evidence here is
  what it is.
* No ADR is accepted, no decision approved, no capability moved to a new
  disposition. The parity-matrix update for CAP-011/CAP-012/CAP-004 is the
  orchestrator's to make at acceptance, against this evidence.
* No compliance claim of any kind.
