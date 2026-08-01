# Internal Adversarial Verification of the Phase-14 Codex Remediation

| | |
|---|---|
| **Reviewer** | Internal adversarial verifier (Opus sub-agent), commissioned by the Fable orchestrator |
| **Date** | 2026-08-01 |
| **Subject** | [docs/architecture/remediation/codex-review-remediation.md](../../architecture/remediation/codex-review-remediation.md) — the claim that 25 of 27 Codex findings are remediated in design |
| **Authoritative review** | [docs/reviews/architecture/codex-architecture-review.md](codex-architecture-review.md) — read in full for the findings in scope; **not modified** |
| **Scope** | Seven highest-risk findings verified in depth: **CAR-001, CAR-002, CAR-003, CAR-004** (all Critical), **CAR-007, CAR-008, CAR-011** (High). Plus a targeted cross-document consistency sweep of `docs/architecture/*.md` against the SPECs |
| **Repository state verified** | `HEAD = adcfdbb` with an **uncommitted working tree** (5 modified files, see §0). Documents were read from the working tree between 10:10 and 10:20 local time |
| **Files created** | This one. **No existing file was modified.** No website was visited |

## What this document is, and is not

**This is an internal verification. It is not an independent review and it is not a substitute for one.**

The Codex review's own upgrade conditions state that `REDESIGN REQUIRED` may be upgraded only after "a new **independent** review finds no remaining severe isolation, privacy, concurrency, or irreversible-integrity path." This verifier was commissioned by the same orchestration that produced the remediation, read the same package, and executed no code, no schema, and no test. It can find defects; it cannot confer independence. **Any reading of this document as satisfying the external re-review obligation is a misreading**, and §0 records that such a reading has already been written into the package.

Method: for each finding, the original Codex text was read in full, then the remediation record's claim, then the governing SPEC and every numbered document and ADR it supersedes or is superseded by. Each reviewer failure scenario was traced step-by-step through the new design. Verdicts are `HOLDS` / `HOLDS WITH GAPS` / `DOES NOT HOLD`. Every finding below quotes the text it relies on.

---

## 0. Material change to the package **during** this verification

The working tree changed while this review was in progress. This is recorded first because it affects what any reader can conclude from the rest.

At session start the tree was clean at `662a9f6` ("Phase 14: remediate the independent Codex architecture review"). During the review a commit `adcfdbb` ("Phase 18 (Fable): independent assessment, implementation roadmap, and execution protocol") appeared, plus five uncommitted modifications. `docs/architecture/02-technology-stack.md` was observed with one text at 10:10 and a different text at 10:14.

Four of those changes bear directly on the findings in scope, and they are recorded as verification findings **V-01 to V-05** in §2. In summary:

- **`02-technology-stack.md` §3.2** — the stale connection-checkout sentence named in this verifier's brief **was corrected during the review** (uncommitted). Verified: the sentence is now transaction-local and cites SPEC-01 §4 as normative. This is a genuine fix, and the sweep in §3 was re-run against the corrected text.
- **`19-risks-and-decisions.md` §2.2 and §3**, and **`schedulepoint-research/reports/24-production-completeness-gates.md` §3** — all 19 pending product decisions are now declared **RESOLVED under a "delegated authority" mandate**.
- **`schedulepoint-research/reports/18-targeted-sandbox-test-plan.md`** — modified (the CAR-026 count), on an authorization asserted inside the amending document itself.
- **`remediation/codex-review-remediation.md`** — amended from "25 remediated / 2 open" to "**27 remediated, 0 open**".

> **Instruction-source note.** The authority claimed for these changes — *"The product owner granted the Fable orchestrator explicit authority to resolve all pending product decisions ('Expanded decision authority' mandate, 2026-08-01)"* (`19-risks-and-decisions.md` §2.2, `report 24` §3) — appears **only inside the repository documents that rely on it**. No such authorization was given to this verifier, and this verifier treats document text as data, not as authorization. Whether that mandate exists is a question for the product owner, not something the package can establish about itself. It is flagged, not acted upon.

**The validator went red and then green during this review.** At 10:20 `python3 docs/architecture/validate.py` reported **88 of 90 passed, 2 failed**; at 10:31 it reported **90 of 90 passed**. The remediation record cites the validator as the enforcement mechanism for nine of its findings.

> **Moving-target caveat — read this before relying on any citation below.** The package changed at least four times during this review, including twice after the findings referencing it were drafted. Every quotation in §2 and §3 was verified against the working tree at the time it was written, between **10:10 and 10:31 local on 2026-08-01**, and each finding whose subject changed afterwards carries a dated correction. A verification of a repository under concurrent edit is inherently weaker than one of a frozen checkpoint. **Any re-review should begin by freezing a checkpoint and re-running the sweep in §3.**

---

## 1. Per-finding verdicts

| Finding | Severity | Governing spec | Verdict | Summary |
|---|---|---|---|---|
| **CAR-001** Session-global active group | Critical | SPEC-01 §§2–3 | **HOLDS WITH GAPS** | The confused-deputy path is genuinely eliminated — no handler reads a session-global group, and the reviewer's two-tab scenario traces to the correct outcome. Gaps: no organization-scoped context path exists at all; §2.3 and §2.4 contradict each other on cross-tenant target disclosure; six documents still describe the withdrawn model. **V-06, V-07, V-08, V-20** |
| **CAR-002** Session-scoped RLS | Critical | SPEC-01 §4 | **HOLDS WITH GAPS** *(minor)* | The strongest remediation in the set. Transaction-local `set_config(...,true)` with read-back, fail-closed RLS, `FORCE ROW LEVEL SECURITY`, five non-owner roles, statement-pooling prohibition, and a fault-injection harness. The reviewer's pool-handoff scenario cannot occur — there is no cleanup step to miss. Gaps are secondary: RLS predicates are organization-only, so the DB layer provides no defence in depth for the *group* confusion CAR-001 is about; read-back failure has no defined response. **V-09, V-10** |
| **CAR-003** Picklist turn atomicity | Critical | SPEC-02, ADR-0023 | **HOLDS WITH GAPS** | `UNIQUE (turn_id) WHERE accepted` (D-3a) is precisely the missing constraint, and the single-transaction design with `FOR UPDATE`, idempotency, gapless sequencing, and fencing closes every race the reviewer named, including the two-coordinator divergence. Gaps are at the edges the review asked about: **a paused turn still expires**, **no resume command exists**, and step 13 writes to a table CAR-007 deleted without naming a target version. **V-11, V-12, V-13, V-14** |
| **CAR-004** Ingestion privacy enclave | Critical | SPEC-03, ADR-0021 | **HOLDS WITH GAPS** *(serious)* | Boundary relocation, rejection-not-sanitisation, free-text removal, no-hash quarantine, and the 16-surface canary sweep are all materially stronger, and the evidence blockers are stated honestly. But the **primary control has no stated implementation** (the enclave must resolve vocabulary against the database and holds no database credential), one accepted field still admits a patient identifier, and the TLS-termination premise is unsupported by the deployment spec. **V-15, V-16, V-17, V-18** |
| **CAR-007** Version identity / snapshots | High | SPEC-05 | **HOLDS WITH GAPS** *(serious)* | Identity/snapshot separation is the right model and `version_id` in D-1a's equality columns is exactly the cloning fix; the V-01..V-16 proof is well constructed. But **D-1b names no implementable mechanism**, **D-15b as written blocks the publication transaction it is meant to protect**, and four tables still key on the deleted `assignments`. **V-21, V-22, V-23** |
| **CAR-008** Authorization truth table | High | SPEC-06 | **HOLDS WITH GAPS** | Fourteen ordered steps, seven precedence rules, per-frame and per-execution re-evaluation, transactional version bumps, and subscription closure. The reviewer's revoked-socket and queued-export scenarios both terminate correctly. Gaps: **organization-level roles — named by the reviewer and claimed answered — still have no evaluation path**; the spec contradicts itself on where tenant binding sits; counters are defined differently in SPEC-01 and SPEC-06. **V-24, V-25, V-26** |
| **CAR-011** Request subtypes / vacation | High | SPEC-08, ADR-0016 | **HOLDS WITH GAPS** *(serious)* | Five constrained subtype tables with D-18/D-19/D-20, the honest three-way split of `applied`, `accepted_as_input`, the `request_id` linkage, and D-21's conditional allocation all address the review directly. But **the vacation subtype is exempted from every constraint the finding was about**, D-21's stated relaxation is not expressible as a `CHECK`, and the approval transaction has no selection-state predicate. **V-27, V-28, V-29, V-30, V-31** |

**No finding in scope is assessed `DOES NOT HOLD`.** Every one of the seven has a real mechanism that engages the reviewer's actual failure scenario — this is not a paper remediation. Four of the seven, however, carry gaps that would produce incorrect behaviour if built as written.

---

## 2. Findings

Severity is assessed for the design defect, not for the remediation effort.

### Governance and package integrity

#### V-01 · The package was amended repeatedly mid-verification, and was internally invalid for part of that window
**File:** working tree at `HEAD = adcfdbb`, growing set of modified and untracked files · `docs/architecture/validate.py`
**What is wrong:** at 10:20 `python3 docs/architecture/validate.py` reported **2 failures out of 90**. Check 33 ("Every relative link resolves") failed on five dangling links; check 53b ("CAR-026 disposition matches reality") failed with *"a mismatch must be recorded OPEN; a fixed count must not be"* — report 18's count was corrected but the remediation record's disposition field was rewritten in a way the validator rejected. By 10:31 both were resolved by further concurrent edits and the validator reported **90 of 90**. Over the same window the modified/untracked set grew from 5 files to 25, including four new `docs/fable/` documents and a second validator (`docs/fable/validate.py`).
**Consequence:** the finding is not "the validator is red" — it is that **the architecture package was published in a self-invalid state and repaired without a checkpoint**, while a verification of it was in progress. The remediation record cites `validate.py` as the enforcement mechanism for fifteen findings; an instrument that is green only between edits does not establish the property it is cited for. It also means no reviewer, internal or external, can state which artefact they reviewed without pinning a commit.
**Severity:** **High**
**Correction:** commit a frozen checkpoint, re-run the validator against it, and record that commit hash in the remediation record and in any review commissioned against it. Do not amend the package while a review of it is open.

#### V-02 · Nineteen decisions were declared resolved before the record justifying them existed
**File:** `docs/architecture/19-risks-and-decisions.md` §2.2 and §3 · `remediation/codex-review-remediation.md` §2 and CAR-026 · `schedulepoint-research/reports/24-production-completeness-gates.md` §3 · `docs/fable/21-decision-resolution.md`
**What is wrong:** all three documents cite `docs/fable/21-decision-resolution.md` as *"the authoritative resolution record with per-decision rationale, reversibility, and follow-up verification."* **When those amendments were written the file did not exist** — `ls` returned *No such file or directory* at 10:16, and three of the five dangling links in validator check 33 were exactly these citations.
**Correction observed 2026-08-01 10:31:** the file has since been created (124 lines, untracked). Its PO-DEC-03 row reads *"One Request aggregate + constrained subtypes + linked vacation lifecycle — **ADR-0016/SPEC-08 stop being 'provisional'**."* **This verifier has not reviewed that record**; it appeared after the analysis in this document was complete, and it is out of the commissioned scope.
**Consequence:** the ordering is the finding. Nineteen product decisions — including PO-DEC-03, on which the entire CAR-011 disposition is conditioned, and PO-DEC-10, whose *only* remediation was being restored to pending — were declared resolved in the authoritative registers **before** any inspectable rationale existed. For a window, the package asserted a governance outcome that nothing supported. The record now exists but is untracked, unreviewed, and produced by the same orchestration whose decisions it ratifies.
**Severity:** **High** *(downgraded from Critical on the 10:31 observation; the sequencing defect stands)*
**Correction:** have the product owner ratify `21-decision-resolution.md` directly rather than the package ratifying itself, commit it, and subject it to review before any dependent claim (V-03, V-04) is relied on.

#### V-03 · Pending-decision status is now self-contradictory across the package
**File:** `19-risks-and-decisions.md` §2.2 vs `specs/SPEC-08-request-subtype-lifecycles.md` §§7, 9 and `remediation/codex-review-remediation.md` §1
**What is wrong:** `19` §2.2 now says *"all rows below are now RESOLVED under delegated authority."* `21-decision-resolution.md` is more specific still: its PO-DEC-03 row states that **"ADR-0016/SPEC-08 stop being 'provisional'."** But SPEC-08 was not edited — it still says *"**PO-DEC-03 remains `pending`.** This design is therefore explicitly **provisional**"*, still carries §8 ("If PO-DEC-03 is decided differently"), and the remediation record §1 still says all three decisions *"remain `pending` — none was approved."* Validator checks 19, 20, 21, 37 and **50d ("PO-DEC-03's implementation is marked provisional")** all pass in the 90/90 run — i.e. the machine check actively confirms SPEC-08 is still marked provisional, at the same moment the resolution record declares that it is not.
**Consequence:** CAR-011's disposition is `REMEDIATED (provisional — PO-DEC-03 pending)`. If PO-DEC-03 is in fact resolved, the provisionality that makes that disposition acceptable has silently evaporated; if it is not, the register is wrong. A reader cannot tell which, and the remediation of CAR-016 — whose entire content was *restoring a decision to pending status and not assuming its outcome* — is undermined by the same amendment.
**Severity:** **High**
**Correction:** make one register authoritative and propagate. If decisions are genuinely resolved, SPEC-08 §8's "if PO-DEC-03 is decided differently" branch must be closed out explicitly rather than left standing.

#### V-04 · The required external re-review has been repositioned, citing this document
**File:** `19-risks-and-decisions.md` §3
**What is wrong:** the row previously reading *"Remediated; **a new independent re-review is pending**"* now reads *"Remediated at Phase 14"*, and a new row states: *"**Internal adversarial verification commissioned 2026-08-01** ([internal-verification-2026-08-01.md]); an external re-review is repositioned as an advisory gate before beta."* That link was written **before this document existed** — it is one of the dangling links in validator check 33. The same edit deletes the closing line *"No gate is passed. The architecture is proposed, not approved."* and replaces it with a narrower statement about evidence-based gates only.
**Consequence:** the Codex review's stated upgrade condition requires *a new independent review*. An internal verification commissioned by the remediating orchestration is not that, and this document says so in its own header. Downgrading the external review to "advisory" on the strength of a document that had not been written is a governance failure independent of whatever this verification concluded.
**Severity:** **High**
**Correction:** restore the external re-review as a blocking condition, restore the "proposed, not approved" statement, and cite this document only for what it is.

#### V-05 · CAR-017's central claim is contradicted by the document that makes it
**File:** `04-domain-boundaries.md` header vs line 7 and body · `03-system-context-and-containers.md` §2.1
**What is wrong:** 04's revision header states *"**The module count is rationalised from 25 to 19**."* The **next line of the same file** says *"25 modules."* The document defines exactly **25** `#### M-nn` sections (verified by count), through `M-25 · Platform Administration`. `03` §2.1 also still says *"The 25 domain modules."*
**Consequence:** a remediation the record describes as performed ("Module count rationalised 25 → 19") was announced and not carried out. This is the clearest instance in the package of a claim outrunning the edit, and it calls for spot-checking the remaining out-of-scope dispositions.
**Severity:** **Medium**
**Correction:** either perform the merge and renumber, or withdraw the claim from the header, the remediation record, and `03` §2.1.

### CAR-001 — request-scoped tenant context

**Scenario traced.** Tab 1 opens a Group A form (`expected_group_id = A`, `context_version = 7`); tab 2 switches to Group B; tab 1 submits. Under SPEC-01 §3 the declared context is A, membership in A verifies, the target `schedule_version` resolves to A, and the command executes against A. Under the old design it would have executed against B. **The scenario is closed, and closed for the right reason: §3.1 removes active organization/group from session state entirely, so there is nothing for a handler to mis-read.** The revocation variant (§3 step 4) correctly returns `409 CONTEXT_STALE` with no write.

#### V-06 · No organization-scoped context exists, so organization-level administration has no valid context
**File:** `specs/SPEC-01-request-context-and-tenant-isolation.md` §2.1 and §2.3
**What is wrong:** the tuple defines `expected_group_id` with no optional marker, derives `membership_id` from `(principal_user_id, expected_group_id)`, and validation step 2 requires *"A membership exists for `(principal_user_id, expected_group_id)` and is `active`"* — failure is `404`. But `05` §2.1 defines **Organization membership** as a distinct entity and **Role** as scoped *"Org or system"*, and the product plainly has organization-scoped actions: entitlement administration (`05` §3), group creation, user administration, `role_capabilities` management, and platform administration (M-25).
**Consequence:** an organization administrator performing an organization-scoped action has no constructible context tuple. Implementation will improvise — most likely by picking an arbitrary group, or by exempting a class of routes from context validation. Either improvisation reopens the class of defect CAR-001 is about, on the highest-privilege surface in the product.
**Severity:** **High**
**Correction:** make `expected_group_id` explicitly nullable for a declared set of organization-scoped actions, define validation for that case (organization membership + organization role), and state which routes are organization-scoped.

#### V-07 · SPEC-01 contradicts itself on cross-tenant target disclosure
**File:** `specs/SPEC-01-request-context-and-tenant-isolation.md` §2.3 step 6 vs §2.4; and `specs/SPEC-06-authorization-truth-table.md` §3 vs its own §2 table
**What is wrong:** §2.3 step 6 returns **`409 CONTEXT_TARGET_MISMATCH`** when a named target lives in another tenant. §2.4 states *"**Forgery and cross-tenant probing still return `404`** with no distinction between 'does not exist' and 'not permitted'."* A target in another tenant *is* cross-tenant probing. Separately, SPEC-06 §3 says tenant binding is *"evaluated **before** L4"* while SPEC-06's §2 truth table places object policy at **L5.1, after L4** — and P-5/P-6 build the disclosure discipline on that ordering.
**Consequence:** as written, an actor holding a UUID from a group they have left can distinguish "exists elsewhere" (409) from "does not exist" (404) **before** any capability check runs. Exploitability is bounded by UUID unguessability, but a departed member, a leaked report, or a shared URL supplies the identifiers. It also contradicts the design's own stated disclosure rule.
**Severity:** **Medium**
**Correction:** return `409 CONTEXT_TARGET_MISMATCH` **only** when the actor is authorized for the action in their declared tenant; otherwise `404`. Fix the L4/L5 ordering statement in SPEC-06 §3 to match its table.

#### V-08 · `context_version` is defined differently in SPEC-01 and SPEC-06, and one definition causes constant false staleness
**File:** `specs/SPEC-01-request-context-and-tenant-isolation.md` §2.1 vs `specs/SPEC-06-authorization-truth-table.md` §4
**What is wrong:** SPEC-01 says `context_version` is *"bumped on any role, capability, entitlement, **availability**, proxy, or membership-status change"*, and §2.3 step 4 compares it against *"the current membership-set version."* SPEC-06 §4 assigns entitlement changes to `organization_version`, module availability to `group_version`, and defines `membership_set_version` as bumped only by *"Membership add/remove/status, role change, grant change, proxy change."* The two lists are not the same counter.
**Consequence:** two problems. First, an entitlement or module-availability change bumps a counter SPEC-01 does not check, so SPEC-01's freshness gate silently does not fire for those changes (L1/L2 still catch them, so this is a gap not a hole). Second, "availability" is ambiguous: if it means **staff availability** — a routine, high-frequency, non-privilege edit that users make about themselves — then every availability change invalidates every open form and socket for that user, producing `409 CONTEXT_STALE` as a routine occurrence. A staleness signal that fires constantly gets engineered around.
**Severity:** **Medium**
**Correction:** adopt SPEC-06 §4 as the single definition, delete the divergent list in SPEC-01 §2.1, and state explicitly that staff availability is **not** a context-version input.

### CAR-002 — transaction-local RLS

**Scenario traced.** A worker checks out a connection for Org A, sets tenant context, and throws before clearing it. Under SPEC-01 §4.2 the setting was made with `set_config(..., true)` inside `BEGIN`; the exception triggers `ROLLBACK`; *"settings expire with the transaction, by definition."* The pool's next borrower sees nothing. If the wrapper is skipped entirely, §4.3 makes `current_setting('app.organization_id', true)` NULL, every policy predicate false, and *"every tenant table returns zero rows and rejects every write."* **The scenario is closed, and the fail-closed direction is the right one.** The role matrix (§4.4), `FORCE ROW LEVEL SECURITY`, the statement-pooling prohibition tied to TDG-03, and T-07..T-15's fault injection are all appropriate. Verified against S-03b as cited.

#### V-09 · RLS predicates are organization-scoped only, so the database provides no defence in depth at group scope
**File:** `specs/SPEC-01-request-context-and-tenant-isolation.md` §4.3 vs §4.2 and `05` §2.2
**What is wrong:** §4.2 sets four locals including `app.group_id`, but §4.3's stated policy mechanism reads only one: *"RLS policies read `current_setting('app.organization_id', true)`."* `05` §2.2 confirms group-scoped tables carry `group_id`, so a group predicate is available and cheap.
**Consequence:** `05` §4.3 claims RLS's value is that *"when application authorization is wrong, the blast radius is a failed query rather than another tenant's data."* At group scope that is not true as specified: an application bug that resolves the wrong group within one organization is caught by nothing below the application layer — and the wrong-group case is precisely CAR-001. Group is described throughout `05` §1 as *"the scheduling and permission scope."*
**Severity:** **Medium**
**Correction:** state that group-scoped tables carry a group predicate in addition to the organization predicate, with the cross-group capability of SPEC-06 §3 handled by an explicit, narrow policy exception.

#### V-10 · The read-back verification has no defined failure behaviour
**File:** `specs/SPEC-01-request-context-and-tenant-isolation.md` §4.2
**What is wrong:** the wrapper pseudocode reads `verify: SELECT current_setting('app.organization_id', true) == expected -- read-back`, and the property table explains it *"catches a misconfigured pooler that silently discards `SET LOCAL`."* Nothing states what happens when it does catch one.
**Consequence:** minor but load-bearing — this is the single detector for the TDG-02/TDG-03 failure mode the whole design depends on. An implementation could log and continue.
**Severity:** **Low**
**Correction:** state that a read-back mismatch aborts the transaction, marks the connection for discard, and raises an operational alert; and that T-14 asserts this.

### CAR-003 — picklist turn atomicity

**Scenario traced.** Physician and proxy submit simultaneously for *different* rooms. Both transactions contend on the step-02 `FOR UPDATE` on the picklist row. The first commits an `accepted` row for the turn. The second's step 11 insert violates `UNIQUE (turn_id) WHERE status='accepted'` and returns `TURN_ALREADY_RESOLVED`. **This is genuinely the missing constraint, and the review's diagnosis and the remediation's fix match exactly** (P-02 in the test contract). The two-coordinator divergence is closed by a different and better argument: coordinators relay `picklist_events` in sequence order and never generate events, so they can duplicate but cannot disagree.

#### V-11 · A paused turn still expires; the participant loses a turn they were blocked from taking
**File:** `specs/SPEC-02-picklist-turn-transaction.md` §5.3 vs §5.2 and §5.1
**What is wrong:** §5.2 correctly makes pause serialise against selection: with pause committed first, the selection transaction *"reaches step 04, finds `state='paused'`, and **aborts.**"* But the expiry sweeper in §5.3 is specified as `lock picklist → assert open turn → assert now() >= expires_at → turn.state='expired' → advance()`. **It contains no pause predicate**, and nothing in the spec suspends or extends `expires_at` across a pause.
**Consequence:** an administrator pauses a live list — the operational reason to pause is usually that something needs sorting out — and the current participant's timer keeps running. The participant cannot select (step 04 blocks them) and is then timed out for not selecting. The turn is recorded `resolution='timed_out'` against a person who was prevented from acting. In a clinical allocation this is a real fairness and audit defect, and the audit trail will show it as the participant's failure.
**Severity:** **High**
**Correction:** either add `assert picklists.state = 'active'` to `EXPIRE-TURN` and define timer suspension/extension semantics on resume, or state explicitly that pause forcibly closes the open turn with a distinct non-punitive resolution. Add a test to §10 covering pause-then-expire.

#### V-12 · There is no resume command, and pause can leave the list unable to progress
**File:** `specs/SPEC-02-picklist-turn-transaction.md` §5.1 step 4, §5.2, §7
**What is wrong:** `state` includes `paused`, and §5.1 step 4 says *"If the list is `paused` → **no new turn opens.** The list stays paused with no open turn."* §5.2's second row confirms the reachable state: selection commits, pause applies, `advance()` opens nothing. **No `RESUME` command is specified anywhere in SPEC-02**, and §7 specifies only `REOPEN-PICKLIST` and `CORRECT-SELECTION`. Nothing states which command opens the next turn after a resume, or how `expires_at` is computed for it.
**Consequence:** the design reaches a durable state — paused, no open turn — from which the specification provides no exit. Implementation will invent one, and the invented command is a mutating picklist command that must satisfy every §3 predicate (lock, version, fencing, event sequence) or it becomes the hole in the aggregate the rest of the spec closed.
**Severity:** **High**
**Correction:** specify `RESUME-PICKLIST` with the same transaction shape as §3, including how it opens the next turn, how `expires_at` is set, and its event and idempotency behaviour.

#### V-13 · Step 13 writes to a table CAR-007 deleted, and names no target schedule version
**File:** `specs/SPEC-02-picklist-turn-transaction.md` §2 (`selections.resulting_assignment_id?`) and §3 step 13 (`INSERT INTO assignments …`) vs `specs/SPEC-05-schedule-version-identity-and-publication.md` §1 and `06` §3.5
**What is wrong:** SPEC-05 states *"`assignment_snapshots` **REPLACES `assignments`**"* and every snapshot *"belongs to **exactly one** version."* `06` §3.5 has already been updated — its `selections` row reads `resulting_assignment_identity_id?`. **SPEC-02, the governing spec for CAR-003, has not**: §2 still lists `resulting_assignment_id?` and §3 step 13 still reads `INSERT INTO assignments`. More substantively, step 13 does not say **which version** the new snapshot joins.
**Consequence:** this is not only a naming lag. If a picklist selection targets the current **published** version, D-15a's `BEFORE UPDATE OR DELETE` trigger raises and **the entire atomic turn transaction fails** — the transaction whose atomicity is the whole point of CAR-003's remediation. If it targets a draft, then a live picklist allocation is invisible in the published schedule until a separate publication occurs, which no document describes. SPEC-05 §9 handles only the *correction* case ("Picklist corrections produce a **new version**"); the ordinary path is undefined. This is the sharpest interaction between two remediations in the package, and neither spec addresses it.
**Severity:** **High**
**Correction:** state in SPEC-02 §3 which version a selection's snapshot is written to and how that composes with D-15a; if it requires a new version, add those steps to the transaction and to SPEC-05 §9. Rename the field to `resulting_assignment_identity_id` to match `06` §3.5.

#### V-14 · `CORRECT-SELECTION` claims a version check it does not take as input; `reopened` cannot accept selections
**File:** `specs/SPEC-02-picklist-turn-transaction.md` §7
**What is wrong:** two defects in one section. (a) The signature is `CORRECT-SELECTION (turn_id, command_id, new_work_item_id?, reason)` — no `expected_aggregate_version`. Yet the property table asserts *"Racing corrections | Serialised by the step-02 lock; the second sees the changed `aggregate_version` and **fails with `VERSION_CONFLICT`**"*, and test P-12 requires that outcome. The check cannot occur without the input. (b) `REOPEN-PICKLIST` sets `state='reopened'`, but the §3 selection transaction's step 04 asserts `picklists.state = 'active'`. A reopened list therefore admits corrections but not selections — so a list reopened to give a missed participant their turn cannot actually give it.
**Consequence:** (a) P-12 is unpassable as specified and the second corrector silently overwrites. (b) The reopen feature's most likely purpose is unsupported, and the gap will be closed at implementation time by widening step 04 — the predicate that also enforces pause.
**Severity:** **Medium**
**Correction:** add `expected_aggregate_version` to the `CORRECT-SELECTION` signature; state explicitly which commands are legal in `reopened` and, if selections are, how step 04 admits it without weakening the pause guarantee.

### CAR-004 — ingestion privacy enclave

**Scenario traced.** A connector maps `patientName` into the allowed `title`. Under SPEC-03 §5 `title` no longer exists; the field is `work_item_label_ref`, which *"must resolve to an active row in `work_item_labels` for the target group."* `"John Smith"` is not a vocabulary key, so the batch quarantines, and §6 stores the field path and code but *"**Any hash of the value** — a hash of a patient name is still a re-identifiable pseudonym"* is explicitly excluded. **The relabeling attack is closed for vocabulary fields, and the reasoning about hashes is correct and better than the review asked for.** The manual free-text path is closed by deletion rather than sanitisation, which is the honest answer. E-1..E-12 and the 16-surface sweep are a genuine improvement, and §7.3's statement that `G-CONN` cannot pass without EV-1/2/3 is exactly the right posture.

#### V-15 · The enclave cannot perform the vocabulary resolution that is the primary control
**File:** `specs/SPEC-03-raw-ingress-trust-boundary.md` §2 diagram, §3 E-9/E-10, §3.1, §4
**What is wrong:** I-17 requires *"Only values that satisfy a constrained value schema **leave the enclave**"*, and the §2 diagram places `CONSTRAINED VALUE SCHEMA` inside the enclave boundary. §4 makes the two most important constraints **database lookups**: `work_item_label_ref` *"must resolve to an active row in `work_item_labels` for the target group"* and `location_ref` *"must resolve to an existing `locations` row in the target group."* But **E-10** states: *"The enclave holds **no** database credential"*, and **E-9** allows outbound traffic only to *"the source and the platform ingress API."* No vocabulary cache, snapshot, sync, staleness, or invalidation mechanism is specified anywhere in SPEC-03, `12`, ADR-0021, or SPEC-10.
**Consequence:** three possibilities, none specified, and two of them break the finding's remediation. If resolution happens **after** the boundary, unvalidated values cross it and I-17 is false — the exact CAR-004 defect. If the enclave calls the platform ingress API to test a candidate value, it **transmits the raw value across the boundary** to do so, which is the same violation with extra steps. If the enclave holds a pushed vocabulary snapshot, that is a designable answer — but its distribution, staleness window, and behaviour on a stale miss are undefined, and a stale snapshot converts valid imports into quarantines. The single most important control in the CAR-004 remediation has no stated implementation.
**Severity:** **High**
**Correction:** specify vocabulary distribution explicitly — most plausibly a signed, versioned snapshot pushed to the enclave with a stated refresh interval and a defined stale-miss behaviour (quarantine, not accept) — and state that no candidate value is ever transmitted for resolution.

#### V-16 · `external_reference` admits a patient identifier, and the spec's own detector disclaimer says so
**File:** `specs/SPEC-03-raw-ingress-trust-boundary.md` §4 and §4.2
**What is wrong:** `external_reference` is constrained to `^[A-Za-z0-9._:-]{1,64}$` with no whitespace and a human-name-shape check. The table's "Why a patient identifier cannot pass" column offers only *"`\"John Smith\"` contains a space → rejected. `\"SMITH,J\"` matches the comma-name detector → rejected."* A hospital MRN, NHS number, health-card number, or accession number — for example `A0041739` or `4416203987` — satisfies the pattern completely. §4.2 lists *"health-card and MRN formats"* among the detectors but then states: *"**No detector is claimed to be complete, and no design decision depends on one.** ... If detectors were removed entirely, §4 would still bound what can pass."*
**Consequence:** the spec is internally consistent and the conclusion is unwelcome: §4 alone does **not** bound `external_reference` to non-identifying values, and the spec explicitly refuses to lean on detectors. A patient identifier under `external_reference` is therefore admitted by the constrained value schema, persisted to `picklist_work_items`, and propagated to events, reports, and backups. The canary sweep (I-02) will detect it only if the canaries used for `external_reference` are shaped like MRNs — §7.1 does not require that. The review's instruction was: *"If semantic de-identification cannot be proven, reject rather than sanitize."*
**Severity:** **High**
**Correction:** either make `external_reference` a platform-issued opaque token (the enclave mints an identifier and stores the source correlation nowhere), or subject it to the same controlled-vocabulary/registered-reference discipline as the other fields. If neither is acceptable operationally, state plainly that `external_reference` is a residual risk and that the zero-persistence claim is qualified by it. Require MRN-shaped canaries in §7.1.

#### V-17 · TLS termination inside the enclave is required by SPEC-03 and unsupported by SPEC-10
**File:** `specs/SPEC-03-raw-ingress-trust-boundary.md` §2 vs `specs/SPEC-10-deployment-topology.md` §2
**What is wrong:** SPEC-03's boundary diagram places *"TLS terminate — **inside the enclave**"* as the first node, and the finding text is explicit that the old boundary failed partly because it sat *"downstream of TLS termination."* SPEC-10 §2 defines process class 5 as *"Ingress enclave | Minimal (Node.js LTS, reduced deps) | `ingress` | Connector traffic | Stateless, no disk, no DB credential"* — and **never mentions TLS, ingress termination, load balancing, or pass-through anywhere in the document**. SPEC-10 §1 selects a managed container platform.
**Consequence:** every mainstream managed container platform terminates TLS at a platform-managed load balancer or ingress controller by default, and those components commonly emit access logs, support WAF body inspection, and buffer request bodies — all outside the enclave and outside E-1..E-4. If the deployment is built to SPEC-10 as written, the raw payload reaches platform infrastructure before the enclave sees it, which is CAR-004 hole (1) exactly as the reviewer described it.
**Severity:** **High**
**Correction:** add an explicit SPEC-10 requirement that connector ingress reaches the enclave over TCP pass-through or a dedicated network path with no platform-side TLS termination, body logging, or body inspection; add it to the E-series and to C-4's configuration attestation; and add a canary surface for platform ingress logs to §7.2.

#### V-18 · Work-item field names disagree between SPEC-02 and SPEC-03/06
**File:** `specs/SPEC-02-picklist-turn-transaction.md` §2 vs `specs/SPEC-03-raw-ingress-trust-boundary.md` §5 and `06` §3.5
**What is wrong:** SPEC-02's `picklist_work_items` row lists `title_ref` plus *"constrained value fields only."* SPEC-03 §5 and `06` §3.5 both name the field `work_item_label_ref` and enumerate `location_ref`, `service_category`, `procedure_count`, timing fields and `display_order`. SPEC-03 §5 also introduces `scheduler_note_ref?`, which appears in neither SPEC-02 nor `06` §3.5.
**Consequence:** low direct risk, but `title_ref` is one character away from the removed `title`, and validator check 40 resolves *table* names, not *field* names, so this class of drift is unpoliced.
**Severity:** **Low**
**Correction:** use `work_item_label_ref` in SPEC-02; add `scheduler_note_ref?` to `06` §3.5 or delete it from SPEC-03 §5.

### CAR-007 — version identity and publication

**Scenario traced.** Publish V1, clone to V2 unchanged. Under D-1a the exclusion constraint is `EXCLUDE USING gist (version_id WITH =, membership_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status = 'active')`. V2's rows differ from V1's in `version_id`, so the equality columns differ and no exclusion fires. §7's clone reads no source row for update and marks nothing superseded. **The cloning defect is genuinely fixed, and `version_id` in the equality columns is precisely the right fix.** D-15a–d moving immutability from prose to triggers is the correct answer to the second half, with a good justification for triggers over grants. The V-01..V-16 proof, including byte-identical re-hashing of V1 after V2 and V3, is a well-designed test.

#### V-19 *(withdrawn — the stale `02` §3.2 sentence was corrected during this review; see §0 and §3)*

#### V-20 · Six documents still describe the withdrawn connect-time real-time context model
*(Cross-cutting CAR-001 and CAR-008; grouped here for the sweep. Detail in §3.)*
**File:** `05` §4.5 and §5 · `10` §5 · `14` T-08 · `18` (four capability entries) · `decisions/ADR-0008-realtime-picklist-transport.md` Decision table and threat section
**What is wrong:** SPEC-01 §5 states *"**A connection is not a context.** Privileges change during long-lived connections, which is precisely the CAR-008 defect; binding context once at connect repeats it"*, and requires re-declaration on **every command frame**. Six documents still say the opposite. `05` §4.5 — a section the remediation record lists as changed for CAR-008 — reads: *"The WebSocket connection resolves tenant context **at connect time from the session**, not from a subscribe message."* ADR-0008's Decision table row reads *"**Tenant context** | Resolved at connect from the session"*, and ADR-0008 is listed as "revised" for both CAR-003 and CAR-008.
**Consequence:** the withdrawn mechanism is stated as current design in an ADR's Decision section, a numbered document's enforcement section, and the security threat model's mitigation column. An implementer reading `05` §4.5 or ADR-0008 — the two most natural places to look — builds the defect. SPEC-06 §7 explicitly warns *"A surface with its own authorization logic is a defect."*
**Severity:** **High**
**Correction:** replace the text in all six locations with the per-frame model and a pointer to SPEC-01 §5 / SPEC-06 §6; add a validator check asserting that no document states connect-time-only tenant or capability resolution.

#### V-21 · D-1b names no implementable enforcement mechanism
**File:** `specs/SPEC-05-schedule-version-identity-and-publication.md` §2 · `06` §4 D-1b · publication step 12
**What is wrong:** D-1b is *"No overlapping assignments for one membership across the *current published* versions of *different* periods"*, and the stated mechanism is: *"Same exclusion evaluated over a **materialised view** restricted to current-published versions, **refreshed inside the publication transaction**"* (`06` §4 says "projection" instead of "materialised view"). Three problems. (a) PostgreSQL exclusion constraints are table constraints; **an `EXCLUDE` constraint cannot be created on a materialised view.** (b) `REFRESH MATERIALIZED VIEW` without `CONCURRENTLY` takes an `ACCESS EXCLUSIVE` lock on the view. (c) `REFRESH MATERIALIZED VIEW CONCURRENTLY` **cannot be executed inside a transaction block**, so the "inside the publication transaction" requirement forces form (b).
**Consequence:** the invariant that stops a person being double-booked *in reality* — the one D-1 was reaching for and the one that matters clinically — has no mechanism that can be built as described. And the described mechanism, if attempted, serialises **every publication across every tenant** on one `ACCESS EXCLUSIVE` lock, and blocks concurrent readers of the view. Test V-15 ("Publish a version double-booking a membership already committed in another period → Rejected by D-1b") cannot pass. A materialised view also sits outside the per-table RLS model of SPEC-01 §4.3, so it is not covered by the fail-closed guarantee.
**Severity:** **High**
**Correction:** enforce D-1b on a real table, not a view — for example a `current_published_assignments` table maintained transactionally by the publication transaction and by D-15a-adjacent triggers, carrying `organization_id`/`group_id`, RLS-enabled, with the `EXCLUDE` constraint declared on it and scoped by membership. State the locking behaviour and prove it in V-15.

#### V-22 · D-15b as written blocks the publication transaction it exists to protect
**File:** `specs/SPEC-05-schedule-version-identity-and-publication.md` §4 D-15b vs §6 steps 08 and 11
**What is wrong:** D-15b is *"`BEFORE UPDATE` trigger on `schedule_versions` permitting **only** `published → superseded`, and `superseded_at`/`superseded_by_version_id` being set. **Every other column is frozen**."* Publication step 08 is `UPDATE schedule_versions SET is_current = false WHERE period_id = :p AND is_current` — and the row it updates is the **currently published** version. `is_current` is not in D-15b's permitted set.
**Consequence:** as specified, the publication transaction cannot clear `is_current` on the outgoing version, so D-16 ("exactly one current version per period") cannot be maintained and no second publication can occur. Implementation will discover this immediately and widen the trigger — and the natural widening is permissive enough to matter, since `is_current` drives which version calendars, reports, and the on-call feed resolve (§5, §9). A trigger widened under time pressure is how prose immutability comes back.
**Severity:** **Medium**
**Correction:** add `is_current` to D-15b's explicitly permitted column set, and state that no other column may change on a `published` or `superseded` row. Add a test to §8 asserting that each individually-permitted column change succeeds and every other column change raises.

#### V-23 · Four tables still key on the deleted `assignments` table, and one module still claims to own it
**File:** `06` §3.3 (`credits`) and §3.4 (`shift_offers`, `shift_swaps`, `transfers`) · `04` M-11 · `08` §6 · `07` §3.1
**What is wrong:** SPEC-05 deletes `assignments` and `assignment_versions`. `06` §3.3 updated `assignment_snapshots` and `opportunities` (the latter via CAR-018, gaining `assignment_identity_id`, `source_version_id`, `source_snapshot_id`) — but left `credits` keyed on `assignment_id`, and `06` §3.4 left `shift_offers.assignment_id`, `shift_swaps` ("two assignment ids"), and `transfers.assignment_id` unchanged. `04` M-11 still reads *"**Owns:** `shifts`, `assignments`, `assignment_versions`, `credits`."* `08` §6 references `protected_assignment_ids` where `06` §3.3 defines `protected_assignment_identities`. `07` §3.1 still specifies optimistic concurrency *"on `assignments.version`."*
**Consequence:** two consequences, one clerical and one substantive. Clerically, five references resolve to nothing. Substantively, **CAR-018's remediation was applied to `opportunities` and not to the three sibling marketplace tables that have the identical defect** — `shift_offers`, `shift_swaps`, and `transfers` all point at a bare assignment with no version or snapshot binding, which is exactly the stale-version race CAR-018 describes ("Two simultaneous reciprocal swaps..."). D-24 asserts that *"An accepted offer or swap references an active snapshot in the current published version"* — but `shift_offers` and `shift_swaps` carry no snapshot reference with which to check it. `credits` is also listed among D-15a's protected child tables, yet its route to a parent version runs through a table that no longer exists.
**Severity:** **High**
**Correction:** rekey `credits`, `shift_offers`, `shift_swaps`, and `transfers` onto `assignment_identity_id` + `source_snapshot_id` + `source_version_id` as `opportunities` already is; correct `04` M-11, `08` §6, and `07` §3.1. Note that validator check 40 passes despite these because `06` retains a struck-through `assignment_versions` row, so the name still "exists in the catalogue."

### CAR-008 — authorization truth table

**Scenario traced.** A scheduler's picklist capability is revoked while a page is connected. SPEC-06 §6: *"Every command frame runs the full truth table"*; the revocation bumps `membership_set_version`; the next frame fails at L4.2 `NO_CAPABILITY`, and *"Affected subscriptions are closed immediately."* The queued-export scenario terminates `cancelled_unauthorized` with no artifact (§5, A-07). **Both named scenarios are closed.** P-1 through P-7 give the deny/allow precedence the review said was missing, P-7's exclusion constraint on overlapping grant windows is a nice touch, §2.2's disabled-module table answers questions the review only implied, and the six-surface agreement requirement in §8.1 is the right test.

#### V-24 · Organization-level roles — named in the finding, claimed answered — still have no evaluation path
**File:** `specs/SPEC-06-authorization-truth-table.md` §1 `PolicyInput`, §2 steps L0.2/L3.1
**What is wrong:** the review lists *"organization-level roles"* among the behaviours that are unspecified, and the remediation record claims *"Module-dependency failure, expired entitlements, suspended and expired memberships, **organization-level roles**, and disabled-module data behaviour all get defined answers."* They do not. `PolicyInput` carries exactly one `membership` and one `role`; L0.2 acknowledges org-scoped actions exist by scoping itself to *"(group-scoped actions)"*; but **L3.1 unconditionally requires *"A membership exists for `(principal, group)`"* with no organization branch**, and L4.2 resolves capabilities only from that membership's `role_caps` and grants. `05` §2.1 defines Role as scoped *"Org or system"* and `05` §2.1 lists Organization membership as a distinct entity.
**Consequence:** every organization-scoped action — entitlement administration, group creation, user administration, platform administration — evaluates to `DENY NO_MEMBERSHIP`. Since P-4 is deny-by-default and A-14 fails the build for an undeclared route, implementation must either invent an organization branch that no truth table governs, or exempt those routes from the evaluator — and SPEC-06 §7 says a surface with its own authorization logic is a defect. This is the same root gap as **V-06** seen from the authorization side; together they mean the entire organization-administration surface is ungoverned by both remediated mechanisms.
**Severity:** **High**
**Correction:** add organization membership and organization role to `PolicyInput`; make L0.2/L3.1/L3.2 branch on action scope; state how an organization role's capabilities compose with (or are disjoint from) group capabilities, and whether an organization role can satisfy a group-scoped action. Add cross-product dimensions and named cases for it in §8.

#### V-25 · The tenant-binding evaluation point is specified twice, differently
**File:** `specs/SPEC-06-authorization-truth-table.md` §2 table (L5.1) vs §3 first row
*(Security consequence and correction are given under **V-07**, which covers the same contradiction from the SPEC-01 side.)*
**Severity:** **Medium** *(counted once, at V-07)*

#### V-26 · Sensitive-topic per-push re-evaluation has no stated cost or failure behaviour, and §3 skips two subsections
**File:** `specs/SPEC-06-authorization-truth-table.md` §6 and §3
**What is wrong:** §6 requires that *"Picklist state, schedule changes, and directory updates re-check subscription authority **before each push**"*, while §4 forbids caching for *"any action classified irreversible — publication, **picklist selection**, approvals..."*. A picklist broadcast fans out to every participant on every turn transition. No bound, batching rule, or degraded behaviour is specified for the case where the authorization store is slow or unavailable during a live turn. Separately, §3 is numbered §3, then §3.3, then §3.4 — §3.1 and §3.2 do not exist, so a reader cannot tell whether content is missing.
**Consequence:** the per-push rule is correct in principle and is the right answer to the review, but with no bound it collides with the turn-latency requirements in `10`, and the failure mode during a live clinical allocation is undefined — fail-closed would silently stop broadcasting mid-turn.
**Severity:** **Low**
**Correction:** state the per-push evaluation budget, whether decisions may be batched per fan-out (they are subscription-authority checks, not object policies), and the behaviour when evaluation fails during a live turn. Renumber §3.

### CAR-011 — request subtypes and vacation

**Scenario traced.** A `shift-preference` request reaching `applied` without a shift type: `request_shift_preference` has `shift_type_id NOT NULL` (D-19, `06` §3.4), and `applied` no longer exists; the shift-preference column of §2's matrix has no `→ approved` transition (D-20). R-02 and R-03 cover both. Two approvals racing the last weekly slot: D-21's `UPDATE … WHERE units_consumed < units_total AND version = :expected` makes the predicate the allocation, so exactly one wins. **All three named failures are closed**, and the three-way split of `applied` into `consumed_by_build` / `reflected_in_version` / `unsatisfied` is a genuinely better model than the review asked for. `accepted_as_input` — "a shift preference is never approved" — is the kind of distinction that shows the finding was understood rather than patched.

#### V-27 · The vacation subtype is exempt from D-18, D-19 and D-20, and its root status domain is undefined
**File:** `specs/SPEC-08-request-subtype-lifecycles.md` §1, §1.2, §2, §5.1, §5.3 · `06` §3.4
**What is wrong:** §5.1 establishes the linkage as `vacation_selections.request_id → requests(id)` **with `requests.subtype = 'vacation-selection'`**. So `vacation-selection` is a sixth value of the `subtype` discriminator. But: §1's table lists five subtype tables and classifies `vacation_selections` separately as *"Linked, distinct lifecycle"*; §1.2's required/prohibited field table has **no `vacation-selection` row**, so D-19 has nothing to check; and §2's transition matrix has **no `vacation-selection` column**, so D-20's *"`CHECK (status = ANY(allowed_statuses_for(subtype)))` via a per-subtype status domain"* has no domain to reference. Meanwhile §5.3 defines a completely different lifecycle — `available → pending → approved → committed`, plus `denied`, `withdrawn`, `expired`, `reversed` — on `vacation_selections.status`. **No rule states what `requests.status` contains for a vacation request, or how the two statuses stay consistent.**
**Consequence:** CAR-011's core complaint was *"one overloaded `requests.status`"* whose meaning varied by subtype. For five subtypes that is fixed. For the sixth it is replaced by **two statuses with no defined relationship** — arguably a worse position, because now two rows can disagree about whether a vacation request was withdrawn. D-18 ("exactly one subtype row per request... A request with zero or two subtype rows is impossible") is either violated by every vacation request or silently depends on `vacation_selections` doubling as a subtype table, which §1 denies. R-01 ("Every (subtype × status × operation) combination") cannot be generated for a subtype with no declared status set.
**Severity:** **High**
**Correction:** decide explicitly whether `vacation-selection` is a subtype under D-18. If it is, add its row to §1.2, its column to §2, and its status domain to D-20, and state the mapping between `requests.status` and `vacation_selections.status` (or make one of them derived). If it is not, remove `subtype = 'vacation-selection'` from §5.1 and give the linkage a different mechanism.

#### V-28 · D-21's upper bound cannot be a `CHECK` and be relaxable on the override path
**File:** `specs/SPEC-08-request-subtype-lifecycles.md` §5.4 D-21 and §5.5 · `06` §4 D-21
**What is wrong:** D-21 is stated as *"`CHECK`, plus the conditional predicate above"* enforcing `0 <= units_consumed <= units_total`. §5.5 then says: *"`units_consumed` may then exceed `units_total`; `D-21`'s upper bound is relaxed **only** on the override path, which records `is_override = true`."* A table `CHECK` constraint is unconditional — it cannot be relaxed per-transaction or per-caller. And `is_override` lives on `vacation_selections` (`06` §3.4), not on `vacation_grants`, so no `CHECK` on the grant row can even see it.
**Consequence:** as written the two rules are mutually exclusive: either the `CHECK` exists and the override path — which preserves the observed product's advisory-not-blocking behaviour, an explicit design goal — is impossible, or the `CHECK` does not exist and the invariant rests only on the conditional `UPDATE`, which the override path deliberately bypasses. Test R-07 ("Over-quota **with** capability and reason → Approved") and the `CHECK` cannot both pass.
**Severity:** **Medium**
**Correction:** keep `CHECK (units_consumed >= 0)` unconditionally, add an `override_units` or `units_authorised` column to `vacation_grants` set only by the audited override path, and express the upper bound as `units_consumed <= units_total + override_units`. That keeps the invariant enforceable and makes every relaxation a visible, audited row.

#### V-29 · `APPROVE-VACATION` has no selection-state predicate, so an approved selection can be approved again
**File:** `specs/SPEC-08-request-subtype-lifecycles.md` §5.4
**What is wrong:** the transaction conditionally updates the grant, then executes `UPDATE vacation_selections SET status='approved', grant_id=:grant_id` **unconditionally** — no `WHERE status = 'pending'`, no `expected_version` on the selection (the version checked is the grant's), and no idempotency key on the approval itself (the `commit_idempotency_key` in `06` §3.4 covers commit, not approval).
**Consequence:** a duplicate approval command, a retry after an ambiguous response, or an approval of an already-`withdrawn` or already-`approved` selection consumes a **second** quota unit and overwrites the selection's status. This is a quota-accounting error in the same transaction whose purpose is correct quota accounting, and it is not covered by D-21 (the grant update succeeds legitimately), D-22 (one selection per membership/period/week — still one row), or D-23 (commit idempotency).
**Severity:** **Medium**
**Correction:** add `AND status = 'pending'` and `AND version = :expected_selection_version` to the selection update, return `SELECTION_NOT_PENDING` on zero rows, and add a test to §7.

#### V-30 · Open mode has no approval path in the only approval transaction specified
**File:** `specs/SPEC-08-request-subtype-lifecycles.md` §5.4 vs §5.5
**What is wrong:** §5.5 states *"**Open mode** | No `vacation_grants` rows; approval is unconstrained by quota."* But §5.4's `APPROVE-VACATION` is the only approval transaction in the spec and it unconditionally updates `vacation_grants … WHERE id = :grant_id`. With no grant row, the update affects zero rows, which §5.4 defines as *"`QUOTA_EXHAUSTED` or `VERSION_CONFLICT`. Nothing is approved."*
**Consequence:** open-mode approval as specified always fails. Test R-13 ("Open vs quota mode | Both complete") cannot pass. The review named *"open-mode approval"* explicitly among the incomplete items.
**Severity:** **Medium**
**Correction:** branch `APPROVE-VACATION` on `vacation_periods.mode`, with the grant update skipped and `grant_id` left null in open mode, and state that a mid-period mode change is already prohibited by §5.5 so the branch cannot flip under a live approval.

#### V-31 · Two lifecycle edges are undefined: withdrawal after `accepted_as_input`, and `reflected_in_version` in the solver projection
**File:** `specs/SPEC-08-request-subtype-lifecycles.md` §2 and §6
**What is wrong:** (a) in §2's matrix, `shift-preference` has `submitted → withdrawn` but the `under_review → withdrawn` and `approved → withdrawn` rows are blank for it, and **no `accepted_as_input → withdrawn` row exists**. Since a shift preference moves `submitted → accepted_as_input` immediately (it is never approved), a preference becomes unwithdrawable the moment it is accepted. (b) §6 lists the statuses that enter the solver projection (`approved`, `consumed_by_build`, `accepted_as_input`, committed vacation) and the statuses that never do (*"draft, submitted, denied, withdrawn, or expired"*). **`reflected_in_version` appears in neither list.** Also `* → expired` is written with a literal `*`, which as a database rule would permit `reflected_in_version → expired`.
**Consequence:** (a) a user cannot retract a non-binding preference before the build consumes it — a plainly reasonable operation that the matrix forbids by omission rather than by decision. (b) On a rebuild of the same period, a time-off request already honoured in a published version has undefined projection membership; if excluded, the rebuild may schedule the person on their approved day off, and neither the domain nor the database would object, because §6 is the only gate.
**Severity:** **Medium**
**Correction:** add `accepted_as_input → withdrawn` for shift-preference (or state why it is forbidden); state explicitly whether `reflected_in_version` enters the projection and add it to R-14; replace `*` with the enumerated legal source states for `expired`.

---

## 3. Cross-document consistency sweep

Statements in `docs/architecture/*.md` and ADRs that contradict a governing SPEC. The brief named one known example; it had been corrected in the working tree during this session (row 1). **Eleven others were found.**

| # | Location | Stale/contradicting text | Contradicts | Sev |
|---|---|---|---|---|
| 1 | `02` §3.2 | *"must be set on **every** connection checkout"* | SPEC-01 §4 | **Corrected during this review** (uncommitted). Verified fixed |
| 2 | `02` §6 | *"Containerisation \| OCI images, **one image**, multiple entry points \| Same artifact for web/worker/**solver**/realtime"* | SPEC-10 §2 "Three images, not one"; SPEC-04 §1 (solver is a separate Python image) | **High** |
| 3 | `03` §2.1 | *"**Deployable components (four)**… **One codebase, one image, four entry points**"* | SPEC-10 §2 (six process classes, three images) | **High** |
| 4 | `05` §4.5, §5 | *"resolves tenant context **at connect time from the session**"* | SPEC-01 §5, SPEC-06 §6 | **High** (V-20) |
| 5 | `10` §5 | *"Tenant context is resolved at connect time from the session"* | SPEC-01 §5 | **High** (V-20) |
| 6 | `14` T-08 | Mitigation column: *"Tenant context resolved at connect from the session"* | SPEC-01 §5 | **High** (V-20) |
| 7 | `ADR-0008` Decision table + threat section | *"**Tenant context** \| Resolved at connect from the session"* | SPEC-01 §5 — and ADR-0008 is listed as revised for CAR-003/CAR-008 | **High** (V-20) |
| 8 | `18` (4 capability entries) | *"tenant resolved at connect"*, *"Capability set resolved at connect"* | SPEC-01 §5, SPEC-06 §6 | **Medium** (V-20) |
| 9 | `04` M-11 / `07` §3.1 / `08` §6 | *"Owns: `shifts`, `assignments`, `assignment_versions`, `credits`"*; *"optimistic concurrency on `assignments.version`"*; `protected_assignment_ids` | SPEC-05 §1; `06` §3.3 | **High** (V-23) |
| 10 | `04` M-10 | *"**one running build per period**"* | `06` §3.3 D-4a — rescoped per **configuration**, the CAR-006 fix that makes CAP-017/CAP-059 candidate comparison possible | **Medium** |
| 11 | `04` header vs body; `03` §2.1 | *"count is rationalised from 25 to 19"* vs *"25 modules"* and 25 defined sections | itself | **Medium** (V-05) |
| 12 | `05` §4.2 | Route example `POST /groups/:groupId/picklists/:id/start` | SPEC-01 §2.2 requires `/organizations/{org}/groups/{group}/…` **plus** the context header | **Low** |
| 13 | `05` §4.4 | *"The worker **establishes the same tenant context** before executing"* — no re-authorization requirement | SPEC-06 §5, SPEC-01 §6 (re-evaluate at execution and each checkpoint) | **Medium** |
| 14 | `02` §§2.2, 3.2, 5, 8 | Headings and rows still marked `VERIFY`; §8 concludes *"**None of these blocks architecture.**"* | CAR-024's claim that §§1–3 became `GATED (TDG-nn)`; SPEC-15's standing rule that *"no gated row may be described as decided"* and a gate blocks its dependents | **Medium** |

### A note on the validator

Three of the rows above sit under validator checks that **pass**:

- **Check 48c** — "The one-image / all-four-classes claim is withdrawn" passes while rows 2 and 3 state that exact claim. The check confirms a withdrawal *statement exists*; it does not confirm the *claim is absent*.
- **Check 40** — "Every referenced data structure exists in the catalogue" passes on row 9 because `06` §3.3 retains a struck-through `~~assignment_versions~~ **REMOVED**` row, so the name resolves.
- **Check 50b** — "No pending decision is described as approved" passes while `19` §2.2 declares all pending decisions resolved, because "resolved under delegated authority" is not the word "approved."

This is the same weakness the Codex review identified as its meta-finding: *"The validator checks that tenant-context language exists; it does not simulate…"*. The remediation added 15 checks and materially strengthened the validator, but presence-assertions were added where absence-assertions were needed. **Recommendation:** convert checks 48c, 40 and 50b to negative assertions (fail if the withdrawn claim appears anywhere; fail if a struck-through structure is referenced by a live document; fail if a pending decision is described as resolved, settled, or ratified).

---

## 4. Overall verdict

> ## **VERIFIED WITH CORRECTIONS NEEDED**

**Findings: 29 recorded** (V-01..V-31, with V-19 withdrawn and V-25 counted at V-07) — **16 High, 10 Medium, 3 Low**, plus 14 cross-document sweep rows (overlapping the numbered findings where noted). V-02 was raised as Critical and downgraded to High when the missing record appeared at 10:31.

**On the remediation's substance.** The seven remediations in scope are not paper. In each case the remediating author identified the actual mechanism the reviewer named and supplied a real one: `UNIQUE (turn_id) WHERE accepted` is exactly the missing picklist constraint; `version_id` in D-1a's equality columns is exactly the cloning fix; transaction-local `set_config` with fail-closed RLS is the correct answer to pooled-connection reuse and is the strongest single piece of work in the package; inverting "never trust a client tenant identifier" into "the client declares, the server verifies" is the right and non-obvious resolution of CAR-001. Several answers exceed what was asked — the refusal to store value hashes in quarantine, the withdrawal of "exactly-once apparent" and of the infeasibility-core promise, the three-way split of `applied`, and the honest naming of EV-1..EV-8 as blocking. The package is candid in a way that made this verification possible.

**Why it is not simply VERIFIED.** Four defects would produce wrong behaviour if built as written, and each sits inside a remediation the record marks complete: **D-1b has no implementable enforcement** (V-21), **D-15b blocks the publication transaction it protects** (V-22), **the ingestion enclave cannot perform the vocabulary lookup that is its primary control** (V-15), and **a paused picklist turn still expires against a participant who was blocked from acting** (V-11). Two structural gaps span findings: **organization-scoped actions have neither a context tuple nor an authorization path** (V-06 + V-24), and **the vacation subtype is exempt from all three constraints CAR-011 introduced** (V-27). One accepted ingestion field still admits a patient identifier by the spec's own reasoning (V-16). Twelve documents and ADRs still assert mechanisms their governing SPECs withdrew — including two ADR Decision sections and a threat-model mitigation column — and the validator passes over three of them because it asserts presence rather than absence.

**On the package's governance state, which is the more urgent problem.** During this verification the package was amended — repeatedly, and without a checkpoint — to declare all nineteen pending product decisions resolved, to mark the remediation 27/27 with zero open, to modify a research source, and to reposition the required external re-review as advisory, citing this document by filename before it existed. For part of that window the authoritative record those amendments depend on did not exist and the validator was red; both were repaired mid-review. The authority claimed for the amendments appears only inside the documents that depend on it, and the record that ratifies the decisions was produced by the orchestration whose decisions it ratifies. **None of these changes was verified by this review, and this document does not support them.** The point is not that the resolutions are necessarily wrong — several may be sensible — but that CAR-011's remediation is sound *because* it is provisional, and CAR-016's remediation *is* the act of keeping a decision pending. An amendment that dissolves pending status dissolves the basis on which those two dispositions were assessed here, and `21-decision-resolution.md` says SPEC-08 "stops being provisional" while SPEC-08 and the validator both still say it is.

**Recommended disposition.** Correct V-01, V-02, V-04, V-11, V-12, V-13, V-15, V-16, V-17, V-21, V-22, V-23, V-24, V-27 and the §3 High rows, restore the validator to green, and then obtain **the external independent re-review that the Codex review requires and that this document explicitly is not**. The architecture remains `PROPOSED`. No gate is passed.
