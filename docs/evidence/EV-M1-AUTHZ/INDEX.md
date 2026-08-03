# EV-M1-AUTHZ — evidence bundle for OPUS-M1-002

**Task:** OPUS-M1-002 — Authorization evaluator + roles/grants (SPEC-06)
**Branch:** `opus/m1-002-authz-evaluator`
**Specs under test:** SPEC-06 §1 (PolicyInput), §1.1 (organization-scoped action set),
§1.2 (P-8/P-9/P-10), §2 (the truth table), §2.1 (P-1..P-7), §3 (object policies, proxy,
impersonation), §4 (freshness counters), §8 (test contract); SPEC-01 §2.3 step 6 / §2.4
(disclosure), §4.3 EX-2/EX-3 as amended 2026-08-02 (FAD-11), §4.4 (role matrix)
**Status of this document:** captured evidence. **It closes nothing on its own.**

> **Every artefact in this directory is from ONE capture pass**, run back to back after
> the last code change, with `environment.txt` recording the timestamp. That is stated
> because an earlier draft had the gate transcript and the test output from different
> runs, and an independent review caught it. Timings vary between runs; structural
> figures — case counts, test counts, SQLSTATEs, gate verdicts, "0 disagreements" — are
> invariant.

---

## 1. The files

> **Every artefact in this directory is from ONE capture pass**, run back to back after
> the last change of the delta revision, on **port 55473**, with `environment.txt`
> recording the timestamp. Two environmental flakes were seen while producing it, and
> both are disclosed here rather than left in a commit message:
>
> 1. **The `check` capture needed a second attempt.** The first raced the
>    immediately-preceding run's cluster teardown on port 55471 and reported
>    `ECONNREFUSED 127.0.0.1:55471` — twelve suites failed at `beforeAll`, not on an
>    assertion. Re-captured on 55473, which is the port every artefact here now uses.
> 2. **The nested-vitest exit-code red case failed once, mid-session, and passed on
>    re-run.** `red-cases/gates-fail-on-violations.test.ts` spawns a CHILD vitest with
>    its own PostgreSQL cluster, so it is timing-sensitive by construction. The second
>    reviewer ran it **6/6 clean** and judges it environmental.
>
> **Neither is a defect in this task's code**, and neither is a reason to trust the
> numbers below less — but a capture that needed a second attempt should say so, and a
> test that has ever been seen red should be named.

| File | Command | Result |
|---|---|---|
| [`environment.txt`](environment.txt) | `uname -a`, `node --version`, `pnpm --version`, `git log`, `git status` | PostgreSQL 17.10 via `embedded-postgres` (FAD-7), Node 24.18.0, pnpm 11.18.0 |
| [`pnpm-check-output.txt`](pnpm-check-output.txt) | `SP_TEST_PG_PORT=55473 corepack pnpm check` | **12 gates, 12 passed, 0 failed**, exit 0 |
| [`red-cases-output.txt`](red-cases-output.txt) | `SP_TEST_PG_PORT=55471 corepack pnpm red-cases` | **14 cases, 14 proven, 0 not proven**, exit 0 |
| [`harness-output.txt`](harness-output.txt) | `vitest run --project api --project domain --project contracts --reporter=verbose` | exit 0 — 22 files, **378 tests passed, 0 failed** |
| [`per-project-counts.txt`](per-project-counts.txt) | `vitest run --project <name>`, once per project | api **255** · domain **119** · contracts **4** · gates **84** · web **5** = **467** |
| [`cross-product-output.txt`](cross-product-output.txt) | `vitest run --project domain --reporter=verbose` | the SPEC-06 §8.1 battery, verbatim |
| [`migrate-cycle-output.txt`](migrate-cycle-output.txt) | `corepack pnpm --filter @schedulepoint/api migrate:cycle:embedded` | exit 0 — up → down → up → down → up, **0 tables and 0 policies left behind** |

Each per-project figure is taken from **its own run**, not apportioned by hand — the way
EV-M1-TENANCY §2 records getting that wrong once.

---

## 2. Headline results

- **The SPEC-06 §8.1 cross-product runs IN FULL: 39,285,000 cases, 0 disagreements.**
  Not sampled, and there is nothing to escalate about sampling: the product was measured
  before anything was decided and evaluates in ~20 s of pure CPU, because the evaluator
  performs no I/O. The battery asserts its own case count is above 30 million, so a
  future change that quietly collapses a dimension fails rather than passing faster.
- **Every one of the fifteen rows of SPEC-06 §2's table is exercised by a generated
  case**, plus ALLOW — the per-row counts are printed in `cross-product-output.txt` and
  reproduced in §3.1 below. A row that produced no outcome would fail the coverage
  assertion.
- **Each case is decided twice**: by `authorize` (nested guards, early returns) and by
  `expectedOutcome` (a flat ordered list of predicate → reason pairs), both transcribed
  independently from SPEC-06 §2. 0 disagreements across 39.3 M cases.
- **`corepack pnpm check`: 12/12.** **`corepack pnpm red-cases`: 14/14 proven.**
- **467 tests pass**, up from OPUS-M1-001's 183 in the same three projects plus `gates`
  and `web`.
- **Migration cycle clean**, including `0002_authorization.sql`'s `down`.
- **Three EV-M1-TENANCY residuals are closed at the database for an actor WITHOUT the
  capability** (1, 2, 4); residual 5 is closed in SQL. **Residual 1b — an
  *authorized* administrator can still attach an arbitrary global user id, and doing so
  irreversibly bumps that foreign user's freshness counter — remains OPEN**, is asserted
  as open by a test that will flip when it closes, and is owned by the provisioning
  design. Residuals 6 and 7 are reviewed and re-recorded. §4 has the detail.
- **A real defect was found by the HTTP battery and fixed** — placing
  `organization.entitlement.administer` in `core_scheduling` made revoking
  `core_scheduling` an unrecoverable lockout. §6.1.
- **A capability route cannot SUCCEED without evaluating its policy.** An `onSend` guard
  converts a 2xx from a capability route with no evaluation into a **500**, proven by a
  deliberately non-evaluating route (`apps/api/test/authz/fail-closed-guard.test.ts`).
  **It proves the evaluation happened, not that the verdict was honoured** — a handler
  that evaluates and then ignores `decision.allowed` still passes it. The route-policy
  gate proves every route *declares* a policy; this proves every route *consults* it.
- **An independent adversarial review found three HIGH and nine MEDIUM/LOW findings, and
  every one is either fixed or recorded.** §7 is the ledger. Two of the three HIGH
  findings were live privilege-escalation or disclosure paths that the 39-million-case
  battery did not reach, and one was a **test that could not fail**.

---

## 3. SPEC-06 mapping

### 3.1 §2 — every row of the truth table, and how often the battery reached it

From `cross-product-output.txt`, verbatim:

| Row | Reason | Cases |
|---|---|---:|
| **L0.1** | `ORG_INACTIVE` | 19,642,500 |
| **L0.2** | `GROUP_INACTIVE` | 8,910,000 |
| **L1.1** | `NOT_ENTITLED` | 2,146,500 |
| **L1.2** | `ENTITLEMENT_SUSPENDED` | 2,146,500 |
| **L1.2** | `ENTITLEMENT_REVOKED` | 2,146,500 |
| **L1.3** | `ENTITLEMENT_EXPIRED` | 2,862,000 |
| **L1.4** | `MODULE_DEPENDENCY_UNSATISFIED` | 445,500 |
| **L2.1** | `MODULE_UNAVAILABLE_IN_GROUP` | 378,000 |
| **L3.1** | `NO_MEMBERSHIP` | 75,600 |
| **L3.1** | `NO_ORG_MEMBERSHIP` | 107,100 |
| **L3.2** | `MEMBERSHIP_INVITED` / `_SUSPENDED` / `_ENDED` | 106,200 each |
| **L3.3** | `MEMBERSHIP_EXPIRED` | 53,100 |
| **L4.1** | `EXPLICIT_DENY` | 17,700 |
| **L4.2** | `NO_CAPABILITY` | 15,150 |
| **L5.1** | `OBJECT_POLICY` | 6,750 |
| **L6.1** | `PROXY_INVALID` / `PROXY_SCOPE` / `PROXY_GRANTOR_DENIED` | 2,700 each |
| **L6.2** | `IMPERSONATION_EXPIRED` | 1,080 |
| **L6.2** | `IMPERSONATION_FORBIDDEN_SURFACE` | 2,160 |
| | **ALLOW** | 2,160 |

**Fifteen rows, not fourteen.** The packet calls this "the fourteen-step truth table";
SPEC-06 §2's table as amended 2026-08-01 (V-24, V-26) has **fifteen** numbered rows plus
the terminal ALLOW. All fifteen are implemented and all fifteen are exercised. The count
discrepancy is recorded rather than resolved by dropping a row to make the number match
— see §6.5.

**Two dimensions were ADDED to SPEC-06 §8.1's list**, and both for the same reason: its
membership-status dimension has four values and its list has no membership-window
dimension, so `NO_MEMBERSHIP` (L3.1's group branch) and `MEMBERSHIP_EXPIRED` (L3.3) would
never have been generated — and the "every row is exercised" assertion would have been
quietly untrue. `MEMBERSHIP_STATUSES` gains `absent`; `MEMBERSHIP_WINDOWS` is new. The
proxy and impersonation dimensions were likewise widened so L6.1 and L6.2 have denying
cases.

### 3.2 §8.2 — the named cases

The ledger is asserted in code (`packages/domain/test/authz/named-cases.test.ts`, describe
block "SPEC-06 §8.2 coverage ledger"), which fails if any row of A-01..A-23 is neither
covered nor consciously deferred.

| # | Where |
|---|---|
| A-01 | `named-cases.test.ts` — explicit deny + role allow → `EXPLICIT_DENY` at L4.1 |
| A-02 | `named-cases.test.ts` — explicit allow + unentitled module → `NOT_ENTITLED` at L1.1 (P-3: L1 runs before L4) |
| A-03 | `named-cases.test.ts` — a **two-level** dependency chain (`hospital_integration` → `picklist` → `core_scheduling`) |
| A-04 | `named-cases.test.ts` — suspended membership + valid grant |
| A-05 | `named-cases.test.ts` (two instants) **and** `apps/api/test/authz/http-authorization.test.ts` (revoked mid-session over HTTP) |
| **A-06** | **DEFERRED** — no WebSocket surface exists (SPEC-01 §5 / SPEC-02's milestone) |
| **A-07** | **DEFERRED (partial)** — the worker re-authorizes at execution, but on OPUS-M1-001's role allow-list. See §5 item 1 |
| **A-08** | **DEFERRED** — no report or artifact surface exists (SPEC-09's milestone) |
| A-09 | `http-authorization.test.ts` — disable, deny, re-enable, row count unchanged |
| A-10 | `named-cases.test.ts` — `PROXY_GRANTOR_DENIED` |
| A-11 | `named-cases.test.ts` — credential surface, **and** the intersection rule |
| A-12 | `apps/api/test/authz/schema.test.ts` (23P01 from the EXCLUDE constraint) **and** `http-authorization.test.ts` (409 over HTTP, first grant untouched) |
| **A-13** | **DEFERRED** — nothing caches an authorization decision in this milestone. See §5 |
| A-14 | `apps/api/test/http/route-declarations.test.ts` — `routeActionProblems` over the **registered** route table |
| A-15 | `cross-product.test.ts` — every capability has both an allow and a deny case |
| A-16 | `named-cases.test.ts` (`overlappingCapabilityKeys`, `duplicateCapabilityKeys`) and `route-declarations.test.ts` (a route claiming the other namespace fails) |
| A-17 | `named-cases.test.ts` — L0.2 and L2.1 structurally absent for organization scope |
| A-18 | `named-cases.test.ts` — P-9, including a same-named group capability that must not satisfy it |
| A-19 | `named-cases.test.ts` — P-8, including `org_admin` holding the group key |
| A-20 | `named-cases.test.ts` — organization membership suspended / expired / roleless → L3.2 / L3.3 / L3.1 |
| **A-21..A-23** | **DEFERRED** — picklist fan-out does not exist (SPEC-02's milestone) |

### 3.3 §2.1 — the precedence rules

| Rule | Where it is proven |
|---|---|
| **P-1** explicit deny beats every allow | A-01, and the L4.1 HTTP row. L4.1 is evaluated before L4.2 in `evaluate.ts` and in `app_acting_membership_holds` |
| **P-2** a grant never rescues L0–L3 | A-02, A-04; and 2,146,500 L1.1 cases include grant=`allow` rows |
| **P-3** entitlement before permission | A-02, and the `no-explanation-leaks` suite: no module key ever reaches a response body |
| **P-4** deny-by-default, build-time check | `route-declarations.test.ts` (5 rejection cases) and the evaluator's `UNDECLARED_ACTION` runtime backstop |
| **P-5 / P-6** 404-vs-403 | `named-cases.test.ts` describe "P-5 / P-6", and every HTTP row derives its expected status from `denialDisclosure` rather than hard-coding it |
| **P-7** no overlapping grant windows | `schema.test.ts` A-12 — 23P01, plus a *touching* window at the same instant accepted |
| **P-8 / P-9 / P-10** | A-18, A-19, A-16; `http-authorization.test.ts` describe "P-8 and P-9 over HTTP"; `roles.scope = memberships.kind` in `app_acting_membership_holds` |

### 3.4 §4 — the freshness counters this task adds

SPEC-06 §4 requires the bump to be "in the SAME transaction as the change that caused
it". OPUS-M1-001 landed the first clause of each row; these are the rest.

| Counter | Bumped by | Landed | Proven |
|---|---|---|---|
| `organization_version` | entitlement change | `entitlements_bump_organization_version` | `schema.test.ts` |
| `group_version` | module-availability change | `group_module_availability_bump_group_version` | `schema.test.ts` |
| `membership_set_version` | grant change | `capability_grants_bump_membership_set_version` | `schema.test.ts` |
| `membership_set_version` | role-capability change (fan-out to every holder) | `role_capabilities_bump_membership_set_version` | exercised by provisioning; the fan-out cost is recorded in §5 |

---

## 4. The EV-M1-TENANCY §5.2 residuals

EV-M1-TENANCY is **not edited** — it is the historical record of what OPUS-M1-001 left
open. Closure is recorded here, and the tests that documented each residual have been
flipped in place (`apps/api/test/tenancy/roles-and-schema.test.ts`, describe block
renamed from "residuals this milestone leaves open" to
**"EV-M1-TENANCY residuals 1, 2 and 4 — CLOSED by OPUS-M1-002"**).

| # | Residual | Disposition | The flipped test |
|---|---|---|---|
| **1** | Cross-organization user attach, including the **irreversible** foreign-user `membership_set_version` bump | **CLOSED for an actor without the capability. NOT closed for an authorized administrator — see 1b, which is OPEN.** `memberships_guard_administration_on_insert` requires `organization.membership.administer`; a unit of work with no acting membership holds nothing, so the exact statement OPUS-M1-001 recorded now raises **42501**, no row lands, and the foreign user's counter does not move | `RESIDUAL (1) CLOSED: an actor with no capability can no longer attach ANY user` — was `RESIDUAL (1): an organization-scoped writer can attach ANY user to its organization`. Paired with a **positive** test proving an authorized administrator still can |
| **1b** | *(new, narrowed)* An **authorized** administrator can still name an arbitrary global `user_id`, **and doing so irreversibly raises that foreign user's `membership_set_version`** | **OPEN. Asserted as open.** `users` carries no tenant column (PO-DEC-06), so `memberships`' WITH CHECK cannot inspect `user_id` and no non-recursive predicate can. What OPUS-M1-002 closes is the unauthorized path. Whether a legitimate administrator should be able to attach an arbitrary global id is a **provisioning-design** question | `RESIDUAL 1b, STATED AS IT IS: an AUTHORIZED administrator CAN still attach a foreign user`. **The first version of this test branched on the status code and passed either way, under a title claiming the opposite** — an independent review called it out, and it was right to. It now asserts `200` and asserts the counter is bumped by exactly one, so it **flips when the residual closes** |
| **2** | 23503 global user-id existence oracle at the membership edge | **CLOSED.** A BEFORE ROW trigger runs before referential integrity is checked — **measured on this cluster before the migration was written**, not assumed. A non-existent user id and an existing-but-invisible one now both raise 42501, so the pair discloses nothing. Over HTTP the route authorizes before issuing any statement, and the two responses are **byte-identical** | `RESIDUAL (2) CLOSED: the FK is no longer a global user-id existence oracle`, plus `RESIDUAL 2: … BYTE-IDENTICAL to an unauthorized actor` in `http-authorization.test.ts` |
| **3** | `login_email` global uniqueness | **STANDING** — unchanged, both mitigations still in place. No route in this milestone inserts a user except the provisioning path |
| **4** | Self role escalation | **CLOSED.** `memberships_guard_administration_on_privilege_change` fires on exactly OPUS-M1-001's privilege-bearing column list and requires the capability; a `last_active_at` touch is untouched. `capability_grants` additionally refuses a **self-grant unconditionally**, for anyone | `RESIDUAL (4) CLOSED: a member cannot escalate its own role` (member **and** scheduler), and `a membership may not write a capability grant for ITSELF, whatever it holds` |
| **5** | EX-2's capability gate is above the database | **CLOSED in the sense FAD-11 ruling 3 permits.** The gate is now in SQL — in a **trigger**, not a policy. A policy on `memberships` that reads `memberships` recurses; a trigger on `memberships` that reads `memberships` does not, because a trigger body is ordinary SQL and a SELECT fires no INSERT trigger. `schema.test.ts` asserts no policy anywhere references `app_acting_membership_holds`, so the recursion cannot be reintroduced by accident |
| **6** | Resolution-grant breadth (the §2.3 snapshot transaction runs before step 2 has decided anything) | **REVIEWED, unchanged, re-recorded.** No query was added to `resolveContextSnapshot`. The authorization snapshot is loaded in the **command** transaction instead — `loadPolicyInput` takes a `Kysely` handle and never a runner, so it structurally cannot open the resolution transaction. The breadth itself is what SPEC-01 §2.3 steps 1–3 need in order to reject, and narrowing it would mean deciding step 2 before reading the row step 2 decides on |
| **7** | Self-service tenant creation (`GRANT INSERT ON organizations`) | **REVIEWED, and the interaction with the new bootstrap door analysed and TESTED — see below.** Unchanged at the grant level; still owned by the provisioning design in M1's later slices |

### 4.1 Residual 7 × the provisioning door — the attack this task could have created

**The question an adversarial reader should ask.** `app_require_capability` waives the
capability check for an organization with **no memberships**. Residual 7 says any unit of
work can INSERT an `organizations` row for a UUID it declared. Composed, that is an
attack: create a fresh organization, walk through its open door, attach an arbitrary
global `user_id`, and 0001's counter trigger irreversibly raises a **foreign** user's
`membership_set_version` — residual 1's availability half, reached by a new route that
this task introduced.

**It is not reachable through the application, and the reason is structural.** No HTTP
path opens a unit of work for an organization the caller is not already a member of:
SPEC-01 §2.3 step 2 resolves the acting membership **before** the command transaction
exists, and a membership-less organization has none. The request is a `404` and no
transaction with that organization in context is ever opened.

That is a claim about **every route that will ever exist**, so it is asserted rather than
argued — `apps/api/test/authz/provisioning.test.ts`, describe block "the bootstrap door is
unreachable over HTTP — residual 7, revisited":

1. the residual-7 statement is executed and **asserted to still succeed** (so the test
   fails loudly if residual 7 is ever closed and the reasoning goes stale);
2. a membership-creation request against that organization answers `404` and writes
   nothing;
3. the intended victim's `membership_set_version` is read before and after and **has not
   moved**.

At the database layer — an actor holding `app_runtime` credentials and writing SQL
directly — the composition is real. That actor can already declare any organization and
is outside every application control, so the door does not widen their reach.

---

## 5. What is NOT proven here

Recorded plainly, because a bundle that overstates its coverage is worse than a smaller
one. **Item 1 is an escalation**, not a gap.

### 5.1 Escalations

| # | Item |
|---|---|
| **1** | **SPEC-06 §7 — "one evaluator, every path" — is NOT satisfied. The job surface still authorizes on OPUS-M1-001's role allow-list.** `apps/api/src/jobs/worker.ts` calls `provisionallyAuthorized`, and `apps/api/src/jobs/**` is **OPUS-M1-003's file scope**, which this task's packet prohibits editing. The consequence is concrete rather than cosmetic: the worker cannot see entitlements, module availability or grants, so **A-07's scenario is covered only in the role dimension** — a job whose entitlement was revoked, or whose capability was explicitly denied by a grant, after enqueue would still execute. What is pinned instead: `job-context.test.ts` asserts the worker's allow-list equals the set of system roles the **catalogue** grants that capability, so the two surfaces cannot drift on the dimension they share. **This needs an orchestrator ruling: either OPUS-M1-003 wires `evaluateInTransaction` into `executeJob` (a one-line change at the call site), or a follow-up task is issued.** |
| **2** | *(was: the `entitlements`-module lockout)* **RULED — FAD-13(2).** Entitlement administration must never be self-referentially module-gated. In M1 entitlement mutation is a **bootstrap/operator path**; when a tenant-facing surface lands it is role/grant-gated but **exempt from the `entitlements`-module availability check**. The lockout described here is therefore not a residual to live with but a design constraint on the surface that has not been built. What this milestone ships is unchanged and correct for M1 — the route exists for the test contract, and the exemption belongs with the tenant surface. §5.4 records what the implementer of that surface must not do |

### 5.1a FAD-13 — the three escalations, ruled

Recorded on `main`; reproduced here so this bundle is readable on its own.

| Escalation | Ruling |
|---|---|
| **1 — the job surface authorizes on a role allow-list** | **Closed by a post-merge integration task, not by this one.** The disclosure is accepted as exactly-scoped. §5.1 item 1 stands as the description of the gap; the owner is that task |
| **2 — revoking the `entitlements` module locks out entitlement administration** | **Entitlement administration must never be self-referentially module-gated.** In M1 entitlement mutation is a bootstrap/operator path. When a tenant-facing surface lands it is role/grant-gated but **exempt from the `entitlements`-module availability check**. See §5.4 |
| **3 — "fourteen-step" vs fifteen rows** | **SPEC-06's fifteen rows govern.** The packet's wording is corrected on `main`. Implementing all fifteen was right; §6.5's note stands as the record of how it was found |

### 5.2 Scope and coverage

| Gap | Detail |
|---|---|
| **Four of six surfaces in §8.1** | §8.1 requires HTTP, worker, WebSocket, report download, object storage and calendar to agree. **HTTP** is covered. **Worker** exists but diverges (item 1). WebSocket, report download, object storage and calendar **do not exist** — SPEC-02, SPEC-09 and their milestones own them |
| **Proxy and impersonation have no wire format** | L6.1 and L6.2 are implemented and exhaustively exercised by the pure battery (2,700 and 1,080–2,160 cases per branch), but `SPEC-01 §2.2`'s declaration carries no proxy or impersonation channel yet, so `loadPolicyInput` passes `null` for both. **They are unreachable over HTTP in this milestone.** That is the honest state: the evaluator is ready, the surface is not |
| **`grantorPassed` and `operatorHoldsCapability` are inputs, not recursion** | SPEC-06 §3.2 requires the grantor to "independently pass L0–L5". Keeping the evaluator pure means the caller evaluates the grantor's snapshot and passes a boolean. **No caller does this yet**, because no proxy surface exists. The wiring is a second `authorize` call, and it is not written |
| **A-13, cached decisions** | SPEC-06 §4 specifies cache versioning and a 30-second TTL. **Nothing in this milestone caches an authorization decision** — `loadPolicyInput` reads every field on every request, with no memo, no TTL and no `authorization_version` short-circuit. That is the safest possible state and it means A-13 has nothing to test. When a cache lands, A-13 lands with it |
| **The HTTP battery is a SUBSET, and says so** | Eight rows, one per layer, each moving one dimension. It is not the cross-product over HTTP and does not claim to be; the cross-product runs in full at the evaluator level |
| **Three of the HTTP rows are refused by SPEC-01 §2.3, not by SPEC-06** | An inactive organization (step 1 / L0.1) and a suspended or out-of-window membership (step 2 / L3.2, L3.3) are refused by the context sequence **before** the evaluator runs. Both layers answer the same 404 so nothing leaks, but the evaluator's own L0.1/L3.2/L3.3 are exercised only by the pure battery over HTTP-equivalent inputs. The tests mark these `deniedBy: 'context'` and assert that **no** authorization line was logged, rather than pretending the evaluator saw them |
| **No `membership_roles` table** | CAP-006 lists it. `memberships.group_role` / `.organization_role` already carry the current role and are NOT NULL by 0001's CHECK, so a second authoritative store would be two sources of truth. The effective-dated, EXCLUDE-constrained store the packet asks for is `capability_grants`. **Consequence: role assignment has no history**, and the audit chain (OPUS-M1-003) is what will record role changes |
| **No runtime path removes a capability from a ROLE** | DELETE is granted on nothing, `role_capabilities` included — consistent with 0001, where DELETE is granted nowhere. Taking a capability from an individual is an effective-dated `granted = false` grant; taking one from a role has no runtime path and would need a migration. Recorded rather than solved with a DELETE grant |
| **`role_capabilities` bump fans out** | A role-capability change bumps `membership_set_version` for **every** holder of that role, in the same transaction. Correct per SPEC-06 §4 and cheap at organization scale; if a future organization makes it large, the fix is to batch the administrative change, not to skip the bump |
| **`role_capabilities` does not enforce P-10 at the database** | `capability_key` is plain `text` with no scope column and no FK, because the vocabulary is a code constant (D-1). Nothing in SQL stops `organization.membership.administer` being written into a group-scoped role, after which its holders would satisfy that capability from a group context. What stands in the way: **no route writes the table**, `provisionAuthorization` validates every pair against the catalogue's scope before inserting, and `schema.test.ts` re-checks every seeded pair. Raised by the independent review; the misleading SQL comment that claimed otherwise is corrected |
| **`last_active_at` on any group membership is writable from an organization context** | `memberships_organization_administration` lifts 0001's `group_id IS NULL` restriction so that "assign a group role" (SPEC-06 §1.1) is implementable. `staffing_kind` was pulled into the privilege-change guard as a result; `last_active_at` was not, because it bumps no counter and confers nothing. So any principal with an organization membership — including `org_observer`, which holds zero capabilities — can touch other members' activity timestamps. A nuisance write, recorded because the DB envelope grew |
| **`app_membership_holds` became OBSERVER-DEPENDENT when S-05 narrowed the grant read** | Asking about **another** membership now answers differently depending on who is asking: the function reads `capability_grants` under the caller's RLS, and since S-05 a caller sees only their own grants unless they hold `organization.role.administer` by role. So for a membership other than the caller's, the grant arms — L4.1's explicit deny and L4.2's explicit allow — are invisible, and the answer collapses to the role-derived one. Two consequences, one of each sign: an explicit ALLOW on another membership is **not counted** (fail-closed), and an explicit DENY on another membership is **not counted either** (fail-OPEN). **Inert today**: the only consumer that asks about another membership is S-02's last-administrator loop, only `org_admin` carries `organization.membership.administer`, and `org_admin` also carries `organization.role.administer` — so the caller who runs that loop can see the grants. It goes live the moment custom organization roles or grant-derived administration exist. **Owner: the roles-administration slice.** Raised by the second review |
| **No audit rows** | Mutations are shaped for emission — one unit-of-work boundary, stable event names in `AUDIT_EVENTS` — and **nothing is written**. `http-authorization.test.ts` asserts no `audit*` table exists |
| **No authentication** | Unchanged from OPUS-M1-001: the shipped principal resolver denies everything |
| **A stale citation survives in `0001_tenancy_core.sql`** | Its `users` docblock cites the describe block "residuals this milestone leaves open", which this task **renamed** when it flipped those tests to assert closure. `0001` is a prohibited file for this task (never edit an applied migration), so the citation is recorded here rather than corrected. The block is now "EV-M1-TENANCY residuals 1, 2 and 4 — CLOSED by OPUS-M1-002" in `apps/api/test/tenancy/roles-and-schema.test.ts`. The other three stale citations an independent review found were in this task's own files and are fixed |

### 5.3 Method and measurement

| Gap | Detail |
|---|---|
| **The oracle and the evaluator share a source, not an author** | Both were transcribed from SPEC-06 §2 in this task. 0 disagreements across 39.3 M cases proves they agree; it does **not** prove either matches the spec — a shared misreading would be invisible. What guards against that is the named-case table (§8.2), which is written from the spec's own worked outcomes rather than from the table, and the coverage ledger that fails when a named case has no home |
| **The battery's `now` is fixed** | Every case evaluates at one instant with windows arranged around it. Clock-skew and boundary-instant behaviour (`now == valid_from`, `now == valid_to`) are covered by `withinWindow`'s half-open arithmetic and the adjacent-window EXCLUDE case, not by the product |
| **Timing equality is not measured** | Residual 2's two responses are asserted byte-identical in body, status, `content-type` and `content-length`, and the unauthorized path issues **no** statement at all. Wall-clock equality is argued from the code path, not measured — the same disclosure EV-M1-TENANCY §5.3 makes |
| **`P-4` is unreachable from the generated battery** | `policyInputFor` derives `moduleKey` and `scope` from the catalogue and throws on an unknown key, so `step4Precondition` can never fire from a generated case and the oracle's `P-4` line is dead code. "Every step exercised" therefore means **fifteen of the sixteen `PolicyStep` values**; the sixteenth is covered by named cases and by the build-side checks in `route-declarations.test.ts` |
| **The oracle shares CONSTANTS with the evaluator** | `expectedOutcome` imports `capabilityDefinition`, `moduleClosure` and `SYSTEM_ROLE_CAPABILITIES` from the modules the evaluator uses. The two are independent in **control flow**, not in data: a wrong constant would be wrong for both. §5.3's shared-source disclosure above covers the reading; this covers the data |
| **The generated battery has four blind spots, and they are not small** | Raised by an independent review, and moved here from a docblock because a coverage limitation recorded next to the code that has it is a limitation nobody reads. **(a) Grant windows never vary**: every generated grant is in-window, so the battery never produced an out-of-window allow or deny — the window dimension exists for memberships and entitlements and not for grants. **(b) The object-policy branch was never exercised**: `policyInputFor` sets neither `ownershipOverrideCapability` nor `permittedTargetStates`, so L5.1's ownership and state rules were unexecuted code in a 39-million-case run — and a defect was hiding in one of them (§7 finding 1). **(c) No cross-tenant target**: the generated target always carries the context's own organization and group, so L5.1's tenant-binding arm is never the failing one. **(d) No wrong-module entitlement**: the entitlement is always for the action's module, which is why the cross-field check S-07 added had nothing to catch it. All four are now covered by **named** cases (`named-cases.test.ts`, describe blocks "L5.1 — the object-policy branch…", "S-03 —…", "S-07 —…"); the generator itself is unchanged, so the blind spots persist in the 39.3 M figure and the named cases are what stand behind those layers |
| **One database, one PostgreSQL** | Unchanged: embedded-postgres 17.10, no external pooler. The `btree_gist` availability and the trigger-before-FK ordering were **measured on this cluster**; both are documented PostgreSQL behaviour, but a different major version should re-measure |

---

### 5.4 What FAD-13(2) requires of the tenant entitlement surface

The route this milestone ships (`PATCH …/entitlements/:moduleKey`) exists for the
SPEC-06 §8.2 test contract — A-05, A-09 — and is a bootstrap/operator path. When a
tenant-facing entitlement surface lands, FAD-13(2) constrains it:

- it is **role/grant-gated** like every other organization-scoped action;
- it is **exempt from the `entitlements`-module availability check** — that is, its
  action must not be gated on L1 for the module that governs entitlement administration
  itself. Self-referential module gating is what made revoking `core_scheduling` an
  unrecoverable lockout in the first place (§6.1), and moving the capability into its own
  module narrowed that without eliminating it;
- the exemption is **for entitlement administration only**. It is not a general
  "administrative actions skip L1" rule; an exemption of that shape in the evaluator is
  the kind of hole that grows.

**Nothing in this milestone implements the exemption**, because nothing in this milestone
is the tenant surface. The current route's action is in the `entitlements` module and
therefore still reachable by the lockout — which is correct for a bootstrap path and
wrong for a tenant one.

## 6. Five things that were wrong, and how they were found

None was found by reading the code.

### 6.1 An entitlement model that could lock an organization out of itself

`organization.entitlement.administer` was placed in the `core_scheduling` module, with a
comment explaining that an entitlement administrator "must still be able to act when
every OTHER module is revoked".

The HTTP battery's A-05 test revoked `core_scheduling`, asserted the denial, and then
failed in its `finally` block: **the administrator could not turn it back on.** L1.2
denied `organization.entitlement.administer` because its own module was the one that had
been revoked. One request, unrecoverable, and the comment in the catalogue asserted the
opposite.

**Fix:** SPEC-06 §1.1's table already answers this — its "Governing module" column names
**Entitlements** and **Organization administration**, neither of which is in doc 05
§3.2's seven-module list. Both are now module keys with no dependencies, provisioned by
default, and the organization-scoped capabilities are split between them.

**It is narrowed, not closed.** Revoking the `entitlements` module still locks out
entitlement administration. §5 item 2 records it, and the recovery path is platform
administration (M-25).

### 6.2 A capability gate that could not be a policy, and did not have to be

FAD-11 escalation 3 recorded that a policy on `memberships` querying `memberships` is
infinite recursion, and ruled that the gate could be application-layer "inside the unit
of work; SQL where non-recursive". The obvious reading is that the SQL half is
impossible.

It is not. **The recursion is a property of RLS policy evaluation, not of the table.** A
BEFORE ROW **trigger** on `memberships` may query `memberships` freely: the read is an
ordinary SELECT subject to ordinary RLS, and a SELECT fires no INSERT trigger. Measured
on this cluster before the migration was written.

That is what makes residuals 1, 2 and 4 closable at the database rather than only above
it. The rule that keeps it safe — **the probe must never appear in a policy** — is
asserted against `pg_policies`, not remembered.

### 6.3 A test that would have stopped testing X-06

`roles-and-schema.test.ts`'s X-06 case proves that a composite tenant FK rejects a
cross-tenant membership reference, as superuser, where RLS is not the control. With the
new guard trigger in place that statement started returning **42501** instead of
**23503** — the trigger fires before referential integrity is checked.

The test's first arm already accepted either SQLSTATE, so a lazy fix would have been to
widen the second arm too. That would have left a test named "the composite tenant FK
rejects…" passing for a reason that has nothing to do with foreign keys. Instead the
superuser session now declares an authorized administrator, gets **past** the guard, and
the 23503 that follows is the FK and nothing else.

The same reasoning produced the two-control version of "a privilege-bearing membership
change outside a unit of work is refused": the capability guard (42501) and the counter
trigger (23001) are now asserted **separately**, because a test that accepts "some
rejection" stops noticing when one of two controls disappears.

### 6.4 A caller-chosen primary key, which is the X-11 oracle again

The membership-creation and grant-writing routes originally took `membershipId` and
`grantId` in the request body. Both are **primary keys**, PK checks **bypass RLS**
(SPIKE-REPORT X-11), and a primary key cannot be tenant-qualified — so a 23505 on a
caller-chosen id would have told the caller that id exists **somewhere**, which is the
same oracle class as residual 2, reintroduced by the route that was written to close it.

Found in self-review before submission, not by a test. **Fix:** the server generates both
ids and returns them; the request contracts are `.strict()`, so a client that supplies one
gets a `400` rather than having the field ignored. `apps/api/test/authz/http-authorization.test.ts`
asserts the rejection, because a permissive schema would silently re-open it.

### 6.5 Fourteen steps, or fifteen

The packet, the objective line and the task brief all say "the fourteen-step truth
table". SPEC-06 §2's table as amended has **fifteen** numbered rows (L0.1, L0.2, L1.1–
L1.4, L2.1, L3.1–L3.3, L4.1, L4.2, L5.1, L6.1, L6.2) plus the terminal ALLOW.

All fifteen are implemented, named in `PolicyStep`, and exercised. **No row was dropped
to make the number match.** The likely origin is the pre-V-26 table, where §3.2 and §3.3
were numbered differently. Flagged for the orchestrator as a wording reconciliation, not
resolved here.

---

## 7. The FIRST adversarial review (pre-submission), and what it found

The review was run against this branch before submission, with a brief to break the
implementation rather than approve it. It reported **three HIGH, nine MEDIUM, two LOW and
two NIT** findings and confirmed it found nothing in five categories (disclosure leaks,
`nullif` guards, the V-09 group predicate, recursion risk, and forbidden paths).

Every finding is listed. **Nothing was argued away.**

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | **HIGH** | L5.1's ownership override ignored an in-window explicit **deny** — revoking an override capability from someone whose role also carried it changed nothing. The whole override branch, and `permittedTargetStates`, had **zero** test coverage: `policyInputFor` never sets either field | **FIXED.** `holdsCapability` now applies L4's precedence (deny beats allow beats role) and is shared by L4.2 and L5.1, so the two cannot answer differently. Eight new named cases cover the branch the generator cannot reach (`named-cases.test.ts`, "L5.1 — the object-policy branch an independent review found untested") |
| 2 | **HIGH** | The "no self-grant, whatever it holds" control compared **membership ids**. A user holds many memberships, so an `org_admin` could create a group membership for their own user and grant it `schedule.publish`, `identity.impersonate`, `audit.export` — all documented as grant-only — in **two requests** | **FIXED at both layers.** The route compares `target.user_id` to `context.principalUserId`; the trigger compares the two memberships' `user_id`s. Four new HTTP tests walk the exact two-hop path, including one that bypasses the route entirely, plus a positive case proving granting *another* principal still works |
| 3 | **HIGH** | `RESIDUAL 1: even an AUTHORIZED administrator cannot attach a user…` branched on the status code and **passed either way**, under a title asserting the opposite of what its body documented | **FIXED.** Rewritten as `RESIDUAL 1b, STATED AS IT IS: an AUTHORIZED administrator CAN still attach a foreign user`, asserting `200` and asserting the foreign user's counter is bumped by exactly one. It flips when the provisioning design closes it. The §2 headline that repeated the overstatement is corrected too |
| 4 | MEDIUM | The residual-1 closure test selected the foreign user's counter, logged it, and compared it to nothing | **FIXED.** The value is captured before and asserted equal after |
| 5 | MEDIUM | The migration's comment claimed a shape CHECK on `capability_grants` that did not exist; nothing bound `group_id` to the referenced membership's | **FIXED.** The guard trigger now refuses a mismatch, and the comment describes what is there. A test writes a grant with the wrong group and asserts 42501 |
| 6 | MEDIUM | `app_organization_is_unprovisioned` runs under caller RLS with a caller-controlled parameter, so it answered `true` for **any** other organization — the capability gate contributed nothing for a foreign `organization_id` | **FIXED.** The bootstrap branch now additionally requires `p_organization_id` to be the in-context organization. RLS refused those rows anyway; a gate whose correctness depends on a different control is not a gate |
| 7 | MEDIUM | `role_capabilities` accepts any capability key at any role scope; the SQL comment claimed `r.scope = acting.kind` was P-10 for the capability | **COMMENT FIXED, limitation recorded.** The comparison is P-8/P-9 for the *role* key and the comment now says so. The only writer is `provisionAuthorization`, which validates every pair against the catalogue's scope; no route writes the table. §5.2 records it |
| 8 | MEDIUM | `routeActionProblems` checked `action.key`'s scope and module but not the ownership override's — a group route could name an organization-scoped override | **FIXED.** The override gets the same scope check |
| 9 | MEDIUM | `memberships_organization_administration` lifted 0001's `group_id IS NULL` for **all** DML, putting every group membership's `staffing_kind` and `last_active_at` in reach of any organization role, `org_observer` included | **PARTLY FIXED, remainder recorded.** `staffing_kind` is now in the privilege-change trigger's `WHEN` list (staff vs locum changes vacation entitlement and fairness credits, doc 08 §3). `last_active_at` remains reachable — it is a non-privilege-bearing timestamp that bumps no counter — and is recorded in §5.2 |
| 10 | MEDIUM | The read policies on `roles` / `role_capabilities` / `entitlements` cite EX-2/EX-3 as authority but drop both of the exception's conjuncts (`app.group_id IS NULL`, and the capability); `group_module_availability`'s write policy cites EX-2 for an EX-3 table | **RECORDED, not silently kept.** D-7 is expanded and D-9 added; the substance (these rows have no group dimension, so an organization predicate is the narrowest that exists) is unchanged, and the practical effect — a group member can enumerate the organization's role vocabulary and entitled modules — is stated |
| 11 | MEDIUM | L6.2 compared `Date.parse(now) >= Date.parse(expiresAt)`; `NaN` made a malformed expiry read as **still valid**, contradicting `withinWindow`'s stated fail-closed discipline | **FIXED.** L6.2 uses `withinWindow`. A named case asserts a malformed instant denies |
| 12 | MEDIUM | Second self-lockout: deprecating the last role carrying `organization.role.administer` destroys the capability needed to undo it, unrecoverably. Unrecorded, untested | **FIXED.** A system role may not be deprecated (`app_guard_roles_administration`), with a test. Unlike the `entitlements` lockout in §5, this one *can* be closed, so it is |
| 13 | LOW | §2 claimed "I-02 is now structural"; the guard proves evaluation happened, not that the verdict was honoured | **CLAIM CORRECTED** in §2 |
| 14 | LOW | `P-4` is unreachable from the battery (the generator cannot build a disagreeing action), so "every step exercised" means fifteen of sixteen `PolicyStep` values; the oracle shares constants with the evaluator | **RECORDED** in §5.3 |
| 15 | LOW | `scripts/**` — a prohibited path — was dirty from running the gates, and `red-cases/evidence-output.txt` records worktree-absolute paths | **RESOLVED.** Both regenerated captures are discarded before every commit (standing runbook note); the committed tree has `scripts/` clean |
| 16 | NIT | `GRANT EXECUTE` without a `REVOKE ... FROM PUBLIC` reads as a restriction and is not one | **FIXED.** All twelve new functions are revoked from `PUBLIC`; the three helpers called from trigger bodies are granted back to the runtime roles — **measured**, because revoking without granting broke every guarded write |
| 17 | NIT | The two `409` paths sent raw inline objects, bypassing the "every 409 is parsed through its own contract" rule stated in `responses.ts` | **FIXED.** `conflictBodySchema` added and both paths parse through it |

## 8. Deviations, each with its reason

| # | Deviation | Reason |
|---|---|---|
| **D-1** | `capabilities`, `module_definitions` and `module_dependencies` are **code constants**, not tables, despite doc 06 §3.1 listing them | All three have tenant scope `system` — identical for every organization. SPEC-06 A-14/A-16 require an unknown key and a both-namespaces key to fail the **build**, and a row cannot fail a build. It also keeps the evaluator pure (§1: "it performs no I/O") and avoids three RLS opt-outs for data that never varies |
| **D-2** | No `membership_roles` table, despite CAP-006 listing it | See §5.2. Two authoritative stores for the current role is worse than no role history, and 0001 cannot be edited to remove the columns |
| **D-3** | Two module keys added beyond doc 05 §3.2's seven: `organization_administration`, `entitlements` | SPEC-06 §1.1's own "Governing module" column names both. Forced by the defect in §6.1 |
| **D-4** | A new permissive policy `memberships_organization_administration` on 0001's `memberships` table | SPEC-06 §1.1 makes "assign a group role" organization-scoped, and 0001 admitted only `group_id IS NULL` rows under an organization context — so the action was unimplementable. Additive, organization-bounded, and the same shape of contradiction FAD-11 resolved for `groups`. The capability gate for it is the trigger, not the policy |
| **D-5** | `capability_grants` has an organization-administration policy that reaches **group-scoped** rows | Same reason as D-4: capability administration is organization-scoped, so an organization administrator must be able to grant a group member something. Reaching that branch requires `app.group_id` unset, which SPEC-01 §2.3 step 2 only permits for a principal holding an organization membership with an organization role |
| **D-6** | The build-failing "unknown capability" check is a **test**, not a new `scripts/gates/` script | `scripts/**` is a prohibited path for this task. The `unit` gate is one of the twelve in `pnpm check`, so a test failure is a build failure — the packet's requirement is met without touching a prohibited file. `route-declarations.test.ts` runs it over the **registered** route table |
| **D-7** | `roles`, `role_capabilities` and `entitlements` are readable under a **group-scoped** context (organization predicate, no group conjunct) | SPEC-06 L1 and L4.2 evaluate during group-scoped requests and these rows carry no `group_id` to bind against — an organization predicate is the **narrowest predicate that exists** for them, not a relaxation of V-09. Who holds a role stays on `memberships`, which keeps its group predicate. Their WRITE policies remain organization-context-only. Registered as the new `organization-only` scope in `TENANT_TABLES` so the isolation probes cover them |
| **D-9** | `group_module_availability`'s organization-scoped policy is `FOR ALL`, and the read policies in D-7 carry **neither** of EX-2/EX-3's conjuncts (`app.group_id IS NULL`, and the corresponding capability). **`capability_grants` no longer belongs in this row — S-05 narrowed it** (§10) | Raised by the independent review as a citation problem, and it is one. The substance stands — a row with no `group_id` has no group dimension to bind against — but the exception list is not the authority for it, and the capability conjunct is genuinely dropped. The practical effect is **reconnaissance, not escalation**: any group member can enumerate the organization's role vocabulary, which capabilities `org_admin` holds, and which modules the organization is entitled to. The last of those is the shape P-3 exists to hide, and it is the strongest argument for narrowing these reads in a later slice. **What is no longer in scope of this deviation is WHO HOLDS WHAT** — the second review pointed out that `capability_grants` was readable on the same terms, which is a strictly larger disclosure, and it is now narrowed to "your own grants, or you hold the administration capability by role" |
| **D-8** | The provisioning door: `app_require_capability` waives the check for an organization-scoped context in an organization with **no memberships** | Bootstrap. An organization with no memberships has nobody who could authorize anything. The door shuts at the first membership row, `memberships` has no DELETE grant so it cannot reopen, and it never opens under a group-scoped context. Five tests in `provisioning.test.ts` prove it is shut |

---

## 9. Reproducing

```bash
corepack pnpm install
corepack pnpm check                                                 # 12 gates
corepack pnpm red-cases                                             # 14 cases
corepack pnpm exec vitest run                                       # 467 tests, all projects
corepack pnpm exec vitest run --project domain --reporter=verbose   # the 39.3 M-case battery
corepack pnpm --filter @schedulepoint/api migrate:cycle:embedded    # up -> down -> up
```

Every run starts from a **destroyed and re-initialised** data directory, so there is no
state to carry between runs. `SP_TEST_PG_PORT` moves the cluster off `55433`, which is
required when two worktrees run at once — **this bundle was captured on `55473`**
throughout (see §1 for why it is not 55471).

---

## 10. The SECOND independent review (REVISE), finding by finding

The independent second review of the submitted branch returned **REVISE**, with one
merge-blocking finding and eleven required items. It also confirmed a great deal clean:
the 39.3 M battery reproduces exactly and is genuinely unsampled with an independent
oracle; all three self-reported HIGH fixes from §7 are real, two with regression tests
that fail on revert; residual closures 1/2/4/5 hold; the schema quality (composite tenant
FKs, the EXCLUDE proven with a real 23P01, X-11 closed at both routes, per-reference
`nullif` across all five new tables) is good; the build-failing controls are non-vacuous
under mutation.

Every item below is implemented on this branch. **Finding → change → the test that proves
it**, in the order they were fixed.

| # | Sev | Finding | Change | Proof |
|---|---|---|---|---|
| **S-01 + S-08** | **MERGE-BLOCKING** | L1 read an **arbitrary** entitlement row: no window predicate, no `ORDER BY`, last row wins. `entitlements` is effective-dated with a `[)` EXCLUDE constraint, so multiple rows per (org, module) is the DESIGNED steady state — **one legitimate administrative write made every action in that module 404 organization-wide**, undiagnosably. S-08 is the write-side twin: the UPDATE hit every row for the module, rewriting history | `pickEntitlementInForce` selects the row in force, falling back to the most recently ENDED and then the earliest FUTURE row — the fallbacks exist because filtering in SQL would have deleted L1.3 from the truth table. L1.4's dependency map uses the same selection. The UPDATE carries the same predicate and asserts it matched ≤ 1 row | `entitlement-in-force.test.ts` — 15 tests including the reviewer's exact scenario, the L1.3-still-reachable case, the re-window-then-re-evaluate cycle, and the selection rule in isolation |
| **S-02** | required | Sole-administrator lockout, **unrecoverable**: a sole `org_admin` could end their own membership in one authorized request. Guard fires for owner and superuser, no DELETE grant, break-glass is SELECT-only | Last-administrator check in `app_guard_membership_administration` — a change removing `organization.membership.administer` is refused unless another active membership still holds it; **self-demotion refused outright** even when another administrator exists, the same two-person rule grants follow. No recursion needed: a TRIGGER on `memberships` may query `memberships` | `provisioning.test.ts` — self-end, self-demote, self-window-close, self-demotion-with-a-second-admin, and an ordinary member ending normally so the guard is not a wall |
| **S-03** | required | L4.1 explicit deny **failed OPEN** on a malformed instant: `inWindowGrants` dropped unparsable-window grants, which for a DENY deletes the denial. `infinity` is permitted by the CHECK and node-postgres returns it as a **number** | `hasExplicitDeny` treats an undecidable window as **in force** — P-1 says the row is absolute within its window; if the window cannot be read, the safe reading of "within" is yes. Same rule at L5.1's override. `instantOf` in the loader stops `infinity` throwing a `TypeError` | `named-cases.test.ts` "S-03" — four undecidable spellings on both bounds, the ALLOW direction still fail-closed, and a decidably-expired deny still expiring |
| **S-04** | required | The loader's four snapshot cross-checks were **unexecuted code** — the reviewer replaced the whole predicate with `membershipRow !== undefined` and all 212 API tests passed | 8 tests calling the loader directly with one disagreement at a time | `loader-cross-checks.test.ts`. **MEASURED under the reviewer's exact mutation: 6 of 8 fail** |
| **S-06** | required | L5.1 **inert** on the only route declaring an object policy: the handler discarded the decision, and flipping the declaration to `false` changed nothing. That route is the pattern every later feature copies. L1.1/L1.4/L5.1/L6.1/L6.2 had no HTTP coverage | The evaluation receives the resolved target and its decision is honoured; the route declares `ownershipRequired` with an override, so the declaration is testable in both directions. HTTP coverage added for L5.1 and L1.1 | `context-surface.test.ts` T-05 (owned → 200, not owned → 404 at L5.1); `entitlement-in-force.test.ts` "S-06 (second half)". L1.4/L6.1/L6.2 remain evaluator-only and are disclosed in §5.2 |
| **S-07** | required | Three inconsistent snapshots produced ALLOW: entitlement for a different module, dependency row for the wrong module, role object not the one the membership names | All three deny. **Landing the role check exposed that the loader and the generator had disagreed about what `roleId` meant since they were written** — UUID vs role key — and nothing had ever compared them; the key wins, and both fields now say so | `named-cases.test.ts` "S-07", plus the consistent snapshot still allowing |
| **S-05** | record + narrow | Any organization role — including capability-less `org_observer` — read **every** capability grant in the organization: who holds `identity.impersonate`, who was denied `audit.export` | **Narrowed, not recorded.** Expressible without recursion because `app_acting_membership_role_holds` reads no `capability_grants`. Two readers: your own grants; or a role-derived holder of `organization.role.administer` under an organization context | `schema.test.ts` — T-13b tightened to "own grants", `org_observer` reads 0, the administrator still reads them |
| **S-09** | required | The EXPIRED-grant test never asserted its setup `inject` — a 400 would have made it pass by proving nothing | Setup asserted, plus the row count. Same for the different-capability test | `http-authorization.test.ts` |
| **S-10** | required | The two-hop self-grant test could not tell WHICH control refused; the trigger would refuse it too, so reverting the route half alone left it green | A test asserting the route's distinctive security-event log line, which the trigger cannot produce | `http-authorization.test.ts` "the ROUTE half refuses it on its own" |
| **S-11** | required | Provisioning ids used the organization id's **first eight hex characters** — two organizations sharing them collide on every role PK, and role PKs bypass RLS | SHA-256 over the full organization id plus discriminator, stamped into a v4-shaped UUID | `provisioning.test.ts` "S-11" — the adversarial pair gets disjoint ids, determinism preserved, shape valid |
| **S-12** | required | Four stale in-code test citations | Three fixed (two cited files never existed). **The fourth is in `0001_tenancy_core.sql`, a prohibited file** — recorded in §5.2 instead. A sweep over every path cited in this task's files now reports zero missing | the sweep |
| **S-13** | required | `PROXY_MEMBERSHIP` unreachable — L6.1 requires L3.2 passed — yet asserted as a reason | Dead branch removed; the reason stays in the union because SPEC-06 §3.2 names it, and its unreachability is now **asserted** | `named-cases.test.ts` "S-13" |
| **S-14** | disclosure | The battery's blind spots were recorded in a docblock rather than in §5 | Moved into §5.3 as a first-class limitation, with all four spelled out | §5.3 |

---

## 11. The delta re-review (APPROVE WITH FOLLOW-UPS), finding by finding

All twelve REVISE findings were verified closed by the reviewer's own mutations and
probes; S-01/S-08 discharged on both sides. The micro-delta below is what remained.

| # | Finding | Change | Proof |
|---|---|---|---|
| **S-22** | `instantOf`'s docblock asserted `0002` forbids infinite bounds at the CHECK level. **No such CHECK existed** — `'infinity'` satisfies every window CHECK (`valid_to > valid_from` is true when `valid_to` is `infinity`), and the reviewer wrote infinite bounds to all three tables. Third instance in this task of a comment describing a control that is not there | **The control, not the comment.** `memberships_finite_window`, `capability_grants_finite_window`, `entitlements_finite_window` — additive `ALTER TABLE ADD CONSTRAINT`, including on 0001's `memberships`, dropped in 0002's `down` | `schema.test.ts` "S-22" — both bounds × both infinities × three tables, plus `valid_from`, plus a finite bound still landing, plus the three constraints existing by name. **Run with an authorized administrator declared**, because the guard triggers fire before constraint checks and an unauthorized statement would be refused 42501 without ever reaching the CHECK |
| **S-21** | The `instantOf` guard was missing one module **upstream**: `context/snapshot.ts` had the identical unguarded `.toISOString()` and runs FIRST, so a stored infinite bound turned that principal's every request into a **500** at §2.3 step 2 | Guard applied there too (defence in depth for rows written before S-22's CHECK); `membershipIsActive` parses the sentinel to `NaN` and the request becomes an ordinary 404. The loader docblock no longer implies the conversion is handled in one place. `jobs/worker.ts` has the same shape and is **left alone** — M1-003's file, routed to the post-merge integration task | the guard, and S-22's CHECK making it unreachable for new writes |
| **S-24** | The multi-row-UPDATE guard `return`ed, and the unit of work **commits on normal return** — so it made a history rewrite noisy while its comment claimed prevention | `throw`, which rolls the transaction back. The comment is now true | the code; the branch is unreachable while the EXCLUDE constraint stands, which is why it is a guard |
| **S-25(a)** | The L1.4 dependency-selection test planted a row for a module **outside** `core_scheduling`'s closure, so mutating the dependency map to take the oldest row failed **zero** tests — while §10 cited this file as proof | Rewritten around `connectors.manage` (hospital_integration → picklist → core_scheduling), driving the loader and evaluator directly because no route declares it. Baseline allows; a closed historical row on the **dependency** must not change that; the live dependency row still governs when it changes | **MEASURED: under the reviewer's exact mutation (dependency map takes the oldest row), it fails** |
| **S-25(b)** | "the ownership override lifts it" asserted 404 with an actor holding **neither** override nor ownership — it asserted nothing about the override | Both directions: 404 without `documents.manage`, **200 with it** (granted by the administrator, since a principal may not grant their own memberships) | `context-surface.test.ts` T-05 |
| **S-23** | record | `app_membership_holds` became **observer-dependent** when S-05 narrowed the grant read — asking about another membership now answers differently by caller, and the deny arm is the fail-OPEN one | §5.2, named as owned by the roles-administration slice |
| **S-26** | record | Flake disclosures moved from a commit message into **§1**, and the §1/§9 port discrepancy reconciled to **55473** throughout | §1, §9 |
