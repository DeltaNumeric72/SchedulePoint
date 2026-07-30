# 11 — Edge Cases & QA Catalogue for SchedulePoint

**Phase:** 12 — final broad research phase. This is a **forward-looking QA specification for SchedulePoint**, derived from the eleven completed ischedule.MD research reports. It is not a test plan for ischedule.MD and must never be executed against it.

**Primary evidence source:** reports 01–10 plus `source-page-index.md`, `evidence-register.md`, and `unresolved-questions.md`. No completed investigation is repeated here. Where a behaviour was never naturally observed, the case specifies the **future SchedulePoint test** and marks the source behaviour UNRESOLVED rather than inventing an observation.

**Source-site safety:** no new ischedule.MD navigation was required or performed for this phase. Nothing was created, modified, submitted, downloaded, exported, or deliberately invalidated. No edge case was provoked on the source site.

---

## Evidence classifications used

| Class | Meaning |
|---|---|
| **OBSERVED** | Directly supported by existing source evidence in reports 01–10 |
| **INFERRED** | Strongly suggested by evidence but not directly tested |
| **UNRESOLVED** | Requires a controlled test environment; source behaviour unknown |
| **SP-REQ** | SCHEDULEPOINT REQUIREMENT — mandatory replacement-product behaviour |
| **SP-IMP** | INTENTIONAL IMPROVEMENT — SchedulePoint should deliberately differ from ischedule.MD |

An inference is never promoted to an observation anywhere in this catalogue.

## Case field key (compact notation)

Every case carries all required fields. To keep 130 cases readable they are written compactly:

- **Class** = evidence classification · **Sev** = Critical/High/Medium/Low · **Pri** = MVP-blocker / pre-beta / pre-prod / post-MVP / deferred
- **Like** = likelihood · **Level** = recommended test level(s) · **Auto** = automation suitability (High/Med/Low/Manual)
- **Env** = required environment · **Own** = owning domain · **Dep** = dependencies
- **Refs** = related feature/workflow/screen/rule/state-machine IDs · **Ev** = evidence IDs (report §)
- **Risk / Pre (preconditions) / Data (required test data) / Steps / Expect (expected SchedulePoint result) / iSched (observed source result) / Decide (match-vs-improve) / Impact (user) / Sec (security-privacy) / Audit / Notify / Recover / Open (unresolved questions)**

**Environments referenced:** `SEED` = seeded single-tenant dev; `MULTI` = multi-tenant seeded; `CONC` = concurrency harness (2+ real sessions); `LIVE-SIM` = simulated live picklist; `PERF` = load/perf env; `A11Y` = assistive-tech env; `DR` = disaster-recovery/restore env. **No case in this catalogue may run against production.**

---

## 1. Organizations and tenant isolation (QA-TEN)

Derived from GRP-01 (per-group rosters, per-group roles), API-01..14 (every endpoint takes `groupId`), and the `SelectedGroupId` cookie / URL-hash / query-param triple-carry finding (10-technical §4).

#### QA-TEN-001 · Empty organization renders purposeful empty states
**Class:** SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** High · **Level:** Playwright, Domain · **Auto:** High · **Env:** SEED · **Own:** Tenancy · **Dep:** none
**Refs:** GRP-01, ADM-05, all screens · **Ev:** 02-role §4; 01-app §"Edge cases"
**Risk:** A brand-new org with no staff, shifts, or schedule crashes, shows raw errors, spins forever, or renders misleading zeros.
**Pre:** Tenant exists; zero staff, zero shift types, zero schedule. **Data:** empty-org fixture.
**Steps:** 1) Sign in as org admin. 2) Visit every primary screen. 3) Record rendering.
**Expect:** Every screen renders a named empty state with a clear next action; no stack trace, no `NaN`, no infinite spinner, no divide-by-zero in computed metrics (e.g. staffing balance).
**iSched:** UNRESOLVED — no empty org was ever available; source empty states were only observed for already-populated modules.
**Decide:** SP-IMP. **Impact:** first-run users abandon. **Sec:** none. **Audit:** none. **Notify:** none. **Recover:** n/a.
**Open:** Does the source render a usable empty org at all?

#### QA-TEN-002 · User belonging to zero organizations
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** Medium · **Level:** Authorization, Playwright · **Auto:** High · **Env:** MULTI · **Own:** Tenancy · **Dep:** QA-AUTH-001
**Refs:** GRP-01, SYS-01, PL-03 · **Ev:** 02-role §4
**Risk:** A user whose last membership is revoked lands in a broken state or silently retains access to the removed org's data.
**Pre:** Valid account, all memberships removed. **Data:** orphaned-user fixture.
**Steps:** 1) Authenticate. 2) Attempt to load any tenant-scoped screen. 3) Inspect API responses.
**Expect:** Clean "no organization access" screen with support contact; every tenant-scoped API returns 403/404 (not 500, not empty-200 that the UI misreads as "zero results").
**iSched:** UNRESOLVED. **Decide:** SP-IMP. **Impact:** confusing lockout or silent data exposure.
**Sec:** high — this is the boundary between "no access" and "stale access". **Audit:** log the denied access attempt. **Notify:** none. **Recover:** re-adding a membership restores access without re-provisioning.
**Open:** none.

#### QA-TEN-003 · Same person, different role per organization
**Class:** OBSERVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Authorization, Domain, API · **Auto:** High · **Env:** MULTI · **Own:** Identity/AuthZ · **Dep:** none
**Refs:** GRP-01, ROLE-01, ADM-05 · **Ev:** 02-role §5 (multiple individuals confirmed holding different Access Levels per group)
**Risk:** Permission checks resolve role globally instead of per-membership, granting a user their *highest* role everywhere.
**Pre:** One user, member of Org A as elevated role and Org B as basic role. **Data:** dual-membership fixture.
**Steps:** 1) Sign in, select Org A. 2) Assert elevated capabilities present. 3) Switch to Org B. 4) Assert elevated capabilities absent in UI **and** rejected at API level.
**Expect:** Authorization is evaluated against the `(user, organization)` membership tuple on **every** request, never against a global user role.
**iSched:** OBSERVED that role differs per group in the data model; whether enforcement is correspondingly per-group was never testable (single-role session only).
**Decide:** SP-REQ — adopt per-membership authorization as a first-class model.
**Impact:** privilege escalation across tenants. **Sec:** critical. **Audit:** every authz denial logged with org context. **Notify:** none. **Recover:** n/a.
**Open:** none — this is a design requirement regardless of source behaviour.

#### QA-TEN-004 · Group switch with a second tab open on the previous org
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Playwright, Concurrency · **Auto:** High · **Env:** MULTI, CONC · **Own:** Tenancy · **Dep:** QA-TEN-005
**Refs:** GRP-01, WF-03, SYS-01 · **Ev:** 02-role §4; 10-technical §4 (context carried in cookie + hash + query simultaneously)
**Risk:** Switching org in tab A silently re-scopes tab B's cookie-derived context, so an action taken in tab B writes to the wrong tenant.
**Pre:** Two tabs open on Org A. **Data:** dual-membership fixture with distinguishable data in each org.
**Steps:** 1) Tab A: switch to Org B. 2) Tab B (still showing Org A): trigger a read, then attempt a write.
**Expect:** Tab B detects the context change and either refuses the write with an explicit "your organization context changed — reload" message, or the write carries tab B's own explicit org id and is validated server-side against the record's tenant. **Never** silently apply Org A's intent to Org B.
**iSched:** UNRESOLVED — multi-tab org switching was never exercised.
**Decide:** SP-REQ. **Impact:** cross-tenant data corruption. **Sec:** critical.
**Audit:** log any request whose declared org differs from session context. **Notify:** none. **Recover:** rejected write leaves both orgs unchanged.
**Open:** none.

#### QA-TEN-005 · Organization context must be explicit per request, not cookie-implied
**Class:** OBSERVED → SP-IMP · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** API, Authorization · **Auto:** High · **Env:** MULTI · **Own:** Platform · **Dep:** none
**Refs:** GRP-01, API-01..14 · **Ev:** 10-technical §4 ("group context carried redundantly in up to three places")
**Risk:** Three sources of truth (cookie, URL hash, query param) disagree; server trusts the wrong one.
**Pre:** n/a. **Data:** n/a.
**Steps:** 1) Issue a request whose explicit org param disagrees with the session's stored org. 2) Assert outcome.
**Expect:** The server treats the **authenticated membership** as authoritative and rejects (does not silently coerce) any request whose declared org the user does not belong to. Client state is never the authority.
**iSched:** OBSERVED that all three carriers exist simultaneously; which the server trusts is INFERRED, never confirmed.
**Decide:** SP-IMP — collapse to one explicit, server-validated carrier.
**Impact:** cross-tenant leakage. **Sec:** critical. **Audit:** yes. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-TEN-006 · Cross-tenant resource identifier access (IDOR)
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Authorization, Security, API · **Auto:** High · **Env:** MULTI · **Own:** Platform · **Dep:** QA-TEN-003
**Refs:** all `*_ID` route params (PICKLIST_ID, BUILD_ID, USER_ID, SCHEDULE_ID) · **Ev:** 10-technical §4 (identifiers appear directly in routes/query strings)
**Risk:** A user in Org A requests a resource id belonging to Org B and receives it.
**Pre:** Known resource ids in two orgs. **Data:** `MULTI` fixture.
**Steps:** For every resource route: 1) authenticate as Org A member; 2) request an Org B resource id; 3) assert response.
**Expect:** 404 (preferred, non-enumerable) or 403 for **every** resource type — schedule, assignment, request, vacation, opportunity, swap, picklist, report, document, file, audit record, background job, calendar feed. Never 200.
**iSched:** UNRESOLVED — explicitly out of scope; authorization boundaries were never tested against the source, by rule.
**Decide:** SP-REQ. **Impact:** catastrophic breach. **Sec:** critical.
**Audit:** log every cross-tenant attempt with actor + target org. **Notify:** security alert on repeated attempts. **Recover:** n/a.
**Open:** none. **Note:** this test must be built as a generic, route-table-driven sweep so new routes are covered automatically.

#### QA-TEN-007 · Stale cached data from a previously-selected organization
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Playwright, Integration · **Auto:** High · **Env:** MULTI · **Own:** Frontend · **Dep:** QA-PERF-007
**Refs:** GRP-01, API-01 · **Ev:** 10-technical §10 (per-navigation re-fetch observed; a cache would change this)
**Risk:** If SchedulePoint adds client caching (which T-01/QA-PERF-001 requires), cached Org A data renders under Org B.
**Pre:** Client cache enabled. **Data:** distinguishable rosters per org.
**Steps:** 1) Load roster in Org A. 2) Switch to Org B. 3) Assert rendered roster.
**Expect:** Every cache key includes the organization id; switching org evicts or namespaces all tenant-scoped cache entries.
**iSched:** OBSERVED — source re-fetches per navigation, so it does not exhibit this bug, but also gains no cache benefit.
**Decide:** SP-IMP — add caching *and* the org-scoped key discipline together, never separately.
**Impact:** wrong-tenant data on screen. **Sec:** high. **Audit:** none. **Notify:** none. **Recover:** reload corrects. **Open:** none.

#### QA-TEN-008 · Reports and exports scoped to one tenant only
**Class:** SP-REQ · **Sev:** Critical · **Pri:** pre-prod · **Like:** Medium · **Level:** API, Authorization, Integration · **Auto:** High · **Env:** MULTI · **Own:** Reporting · **Dep:** QA-TEN-006
**Refs:** ADM-04, SM-02, five "Create X Report" dialogs · **Ev:** 08-supporting SM-02; 09-responsive RA-12 (report types enumerated)
**Risk:** A report generated by an Org A admin includes Org B rows, or a report id from Org B is downloadable by Org A.
**Pre:** Data in both orgs. **Data:** `MULTI`.
**Steps:** 1) Generate each report type in Org A. 2) Assert row-level tenancy. 3) Attempt to fetch Org A's report id as an Org B user.
**Expect:** Report queries are org-filtered at the data layer (not the view layer); generated artifacts are access-checked on retrieval, not just on creation.
**iSched:** UNRESOLVED — no report was ever generated. **Decide:** SP-REQ.
**Impact:** breach via reporting side-channel. **Sec:** critical. **Audit:** log report generation with org + requester. **Notify:** none. **Recover:** revoke artifact. **Open:** report internals (carried forward).

#### QA-TEN-009 · Calendar feed bound to one membership
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** Medium · **Level:** API, Security · **Auto:** High · **Env:** MULTI · **Own:** Integrations · **Dep:** QA-SEC-009
**Refs:** WF-23, SM-08 · **Ev:** 03-user WF-23 (feed URL carries email + groupId + opaque token)
**Risk:** A feed token issued for Org A returns Org B events after a membership change, or never expires when membership is revoked.
**Pre:** Multi-org user with an active feed. **Data:** feed fixture.
**Steps:** 1) Subscribe in Org A. 2) Revoke Org A membership. 3) Re-fetch feed. 4) Separately, add Org B membership and re-fetch.
**Expect:** Feed returns only the events of the membership it was issued for; revocation invalidates the token immediately; gaining a new membership does **not** retroactively widen an existing feed's scope.
**iSched:** OBSERVED the feed is `groupId`-scoped in its URL; revocation behaviour UNRESOLVED.
**Decide:** SP-REQ. **Impact:** ex-member retains schedule visibility. **Sec:** high.
**Audit:** log feed fetches (coarse). **Notify:** none. **Recover:** token rotation. **Open:** token stability (carried forward, unresolved-questions #35).

#### QA-TEN-010 · Background jobs carry tenant context
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** Medium · **Level:** Background job, Integration · **Auto:** High · **Env:** MULTI · **Own:** Platform · **Dep:** QA-NOT-010
**Refs:** API-03/04 ("jobs" resource) · **Ev:** 10-technical §8
**Risk:** A queued job (notification, report, build) executes without org context and processes or delivers across tenants.
**Pre:** Jobs enqueued in both orgs. **Data:** `MULTI`.
**Steps:** 1) Enqueue equivalent jobs in each org. 2) Execute worker. 3) Assert every read/write and every recipient is org-scoped.
**Expect:** Tenant id is a required, validated job payload field; a job missing it fails fast to dead-letter rather than defaulting to "any tenant."
**iSched:** UNRESOLVED — job semantics were never confirmed (unresolved-questions #78).
**Decide:** SP-REQ. **Impact:** cross-tenant notification/report delivery. **Sec:** critical.
**Audit:** job records include tenant + correlation id. **Notify:** ops alert on dead-letter. **Recover:** replay after fix. **Open:** none.

#### QA-TEN-011 · Audit records never span tenants
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** Low · **Level:** Domain, Authorization · **Auto:** High · **Env:** MULTI · **Own:** Platform · **Dep:** QA-SCH-015
**Refs:** WF-05a (per-cell audit log) · **Ev:** 04-master §3.3
**Risk:** An audit/provenance entry authored in Org A is visible when viewing an Org B record, leaking names and actions.
**Pre:** Audited changes in both orgs. **Data:** `MULTI`.
**Steps:** 1) Produce audit entries in both orgs. 2) View any audited record as an Org B user. 3) Assert entry set.
**Expect:** Audit entries are tenant-partitioned and filtered by the viewer's membership, not merely by the record id.
**iSched:** OBSERVED the audit log exists per cell; tenancy of the log was never testable.
**Decide:** SP-REQ. **Impact:** name/action leakage. **Sec:** high. **Audit:** self-referential — audit reads themselves logged at coarse level. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-TEN-012 · Authorization must not be enforced only in the interface
**Class:** INFERRED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Authorization, API, Security · **Auto:** High · **Env:** MULTI · **Own:** Platform · **Dep:** QA-TEN-003, QA-TEN-006
**Refs:** ROLE-01, NAV-02 (admin nav hidden vs. blocked) · **Ev:** 02-role §8 ("coarse-grained rather than screen-by-screen permission checks" — INFERRED, never confirmed)
**Risk:** Hiding a nav item is mistaken for securing the endpoint behind it.
**Pre:** Basic-role account. **Data:** role matrix fixture covering every role in the product.
**Steps:** For every admin-only route and API: 1) authenticate as each non-privileged role; 2) request the route directly; 3) assert rejection.
**Expect:** Every privileged route rejects server-side regardless of whether its UI entry point was rendered. UI hiding is presentation only, never the control.
**iSched:** INFERRED only — the source's per-role enforcement was never testable (no second-role account existed across eleven phases).
**Decide:** SP-REQ. **Impact:** privilege escalation. **Sec:** critical.
**Audit:** log all denials. **Notify:** alert on repeated denials from one actor. **Recover:** n/a.
**Open:** source enforcement model remains permanently unresolved for this research.

---

## 2. Authentication, sessions, roles, permissions (QA-AUTH)

Derived from WF-01/02 (login and reset never observable), 02-role §5–§8 (six access levels + independent flags), SYS-05 (impersonation), and 10-technical §7 (cookie names only; `HttpOnly` session cookie inferred).

#### QA-AUTH-001 · Session expiry mid-workflow
**Class:** UNRESOLVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Playwright, Integration · **Auto:** High · **Env:** SEED · **Own:** Identity · **Dep:** none
**Refs:** WF-01, all forms · **Ev:** 10-technical §7 (session never expired across a multi-hour session; duration unknown)
**Risk:** Session dies while a long form is open; the submit silently discards the user's work or 500s.
**Pre:** Short session TTL configured in test env. **Data:** long-form fixture.
**Steps:** 1) Open a multi-field form. 2) Let session expire. 3) Submit.
**Expect:** Submission is rejected with a re-authenticate prompt that **preserves the entered data**, restoring it after re-auth. No silent data loss, no partial write.
**iSched:** UNRESOLVED (unresolved-questions #75). **Decide:** SP-IMP.
**Impact:** lost work, user distrust. **Sec:** medium. **Audit:** log expiry-triggered rejections. **Notify:** none. **Recover:** data restored post-auth. **Open:** source TTL unknown.

#### QA-AUTH-002 · Idle timeout warning and extension
**Class:** UNRESOLVED → SP-REQ · **Sev:** Medium · **Pri:** pre-prod · **Like:** Medium · **Level:** Playwright, Accessibility · **Auto:** Med · **Env:** SEED · **Own:** Identity · **Dep:** QA-AUTH-001, QA-A11Y-014
**Refs:** WF-01 · **Ev:** 10-technical §7
**Risk:** Silent idle logout, or a countdown that assistive tech never announces.
**Pre:** Idle timeout configured. **Data:** n/a.
**Steps:** 1) Idle until warning. 2) Observe warning. 3) Extend. 4) Repeat and allow expiry.
**Expect:** A warning appears before expiry, is announced via a live region, is dismissible/extendable by keyboard alone, and never steals focus destructively.
**iSched:** UNRESOLVED. **Decide:** SP-IMP. **Impact:** surprise logout. **Sec:** low.
**Audit:** none. **Notify:** in-app only. **Recover:** extension restores session. **Open:** none.

#### QA-AUTH-003 · Logout in one tab invalidates all tabs
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Playwright, Concurrency · **Auto:** High · **Env:** CONC · **Own:** Identity · **Dep:** none
**Refs:** WF-01 · **Ev:** 03-user WF-01 (session confirmed shared across tabs in one profile)
**Risk:** Tab B keeps operating on a revoked session, and its next write succeeds against a stale credential.
**Pre:** Two authenticated tabs. **Data:** n/a.
**Steps:** 1) Sign out in tab A. 2) In tab B attempt a read, then a write.
**Expect:** Tab B's next request is rejected and it redirects to sign-in; no write succeeds on a signed-out session.
**iSched:** OBSERVED shared-session behaviour; logout never exercised (deliberately — it would have ended the research).
**Decide:** SP-REQ. **Impact:** action attributed to a signed-out user. **Sec:** high.
**Audit:** log post-logout request attempts. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-AUTH-004 · Password-reset token single-use and expiring
**Class:** UNRESOLVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Security, Integration · **Auto:** High · **Env:** SEED · **Own:** Identity · **Dep:** none
**Refs:** WF-02 · **Ev:** 03-user WF-02 (reset flow never observable — unauthenticated context unavailable)
**Risk:** Reset links are reusable, long-lived, or guessable.
**Pre:** Reset requested. **Data:** mail-capture harness.
**Steps:** 1) Request reset. 2) Use link. 3) Reuse link. 4) Use an expired link. 5) Request twice and try the first link.
**Expect:** Token is single-use, short-lived, invalidated by a newer request, and constant-time compared. Old sessions are terminated on password change.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** account takeover. **Sec:** critical.
**Audit:** log issue/consume/reject. **Notify:** email the account on password change. **Recover:** re-request. **Open:** source reset flow permanently unobserved.

#### QA-AUTH-005 · Deactivated user with a live session
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Authorization, Integration · **Auto:** High · **Env:** CONC · **Own:** Identity · **Dep:** QA-AUTH-006
**Refs:** ADM-05 (Remove per row) · **Ev:** 01-app ADM-05
**Risk:** An admin deactivates a user who continues acting on an already-issued session.
**Pre:** Active session for a user about to be deactivated. **Data:** two sessions.
**Steps:** 1) User session active. 2) Admin deactivates. 3) User attempts read then write.
**Expect:** Next request after deactivation is rejected (authorization is re-checked per request, not cached in the session blob).
**iSched:** UNRESOLVED — deactivation never exercised. **Decide:** SP-REQ.
**Impact:** departed staff continue changing schedules. **Sec:** critical.
**Audit:** log the post-deactivation attempt. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-AUTH-006 · Role change takes effect within the current session
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** Medium · **Level:** Authorization, Concurrency · **Auto:** High · **Env:** CONC · **Own:** AuthZ · **Dep:** QA-TEN-003
**Refs:** ADM-05, ROLE-01 · **Ev:** 02-role §5 (role is a per-membership attribute, editable inline)
**Risk:** Demotion doesn't apply until re-login, leaving a window of retained privilege.
**Pre:** Elevated user with an open session. **Data:** two sessions.
**Steps:** 1) Admin demotes the user. 2) User retries a privileged action without re-login.
**Expect:** Denied immediately. Privilege is resolved per request from the membership record.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** retained privilege. **Sec:** critical.
**Audit:** log role change (actor, subject, before/after) and any subsequent denial. **Notify:** optionally notify subject. **Recover:** n/a. **Open:** none.

#### QA-AUTH-007 · Independent permission flags are independently enforced
**Class:** OBSERVED (contradiction) → SP-IMP · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Authorization, Domain · **Auto:** High · **Env:** MULTI · **Own:** AuthZ · **Dep:** QA-TEN-012
**Refs:** ADM-05 flags (`Picklist Admin`, `Admin Emails`, `Proxy Locked`, `Notification Locked`, `Show In Grid`), ROLE-01 · **Ev:** 02-role §5
**Risk:** Flags are decorative — the reviewing account had `Picklist Admin: No` yet full picklist access, so a flag may grant nothing while implying it does.
**Pre:** Accounts with each flag on and off at the same access level. **Data:** flag matrix fixture.
**Steps:** For each flag: 1) provision two otherwise-identical accounts differing only in that flag; 2) attempt the capability the flag names; 3) assert divergence.
**Expect:** Every permission flag SchedulePoint ships must have a **defined, tested, observable** capability difference, or must not exist.
**iSched:** OBSERVED contradiction — a `Picklist Admin: No` account had full Picklist Manager access (02-role §5). See Contradiction C-02.
**Decide:** SP-IMP — no vestigial permission flags.
**Impact:** admins misconfigure permissions believing a flag protects something. **Sec:** high.
**Audit:** flag changes audited. **Notify:** none. **Recover:** n/a. **Open:** what `Picklist Admin` actually grants (unresolved #20).

#### QA-AUTH-008 · Locum/relief role constraints enforced server-side
**Class:** INFERRED → SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** Medium · **Level:** Domain, Authorization · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** QA-SCH-009
**Refs:** ADM-01 (`Locum Lockout Hours`), ADM-05 Locum level, VAC-02 Add Locum · **Ev:** 01-app ADM-01; 02-role §5
**Risk:** Locum-specific lockout/notice rules are applied only in the UI, so an API call bypasses them.
**Pre:** Locum member, lockout window configured. **Data:** locum fixture.
**Steps:** 1) Attempt an assignment/claim inside the lockout window via UI. 2) Repeat via API.
**Expect:** Both rejected with the same rule and message; the rule lives in the domain layer.
**iSched:** INFERRED — the setting exists; enforcement never observed. **Decide:** SP-REQ.
**Impact:** rule silently bypassed. **Sec:** medium. **Audit:** log rule rejections. **Notify:** none. **Recover:** n/a.
**Open:** exact semantics of Locum Lockout Hours.

#### QA-AUTH-009 · Proxy acts only within delegated scope
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** Medium · **Level:** Authorization, Domain · **Auto:** High · **Env:** MULTI · **Own:** Identity · **Dep:** QA-PICK-011
**Refs:** PL-02 Pick Proxy, WF-22, ADM-05 `Proxy Locked` · **Ev:** 03-user WF-22; 07-picklist §2
**Risk:** A proxy gains the delegator's full account rather than a narrow, time-boxed, picklist-only delegation.
**Pre:** Delegator with proxy configured. **Data:** proxy fixture.
**Steps:** 1) Proxy performs the delegated pick action. 2) Proxy attempts non-delegated actions as the delegator (profile edit, vacation request, admin config).
**Expect:** Only the explicitly delegated capability succeeds; everything else is denied. Every proxy action records **both** identities.
**iSched:** UNRESOLVED whether the proxy picks or only receives notifications (07-picklist §2). **Decide:** SP-REQ.
**Impact:** unbounded delegation. **Sec:** critical. **Audit:** dual-identity attribution mandatory.
**Notify:** notify the delegator when a proxy acts. **Recover:** revoke delegation. **Open:** proxy eligibility scope (unresolved #27).

#### QA-AUTH-010 · Impersonation is audited, bounded, and visibly flagged
**Class:** OBSERVED → SP-REQ · **Sev:** Critical · **Pri:** pre-beta · **Like:** Medium · **Level:** Security, Authorization, Playwright · **Auto:** High · **Env:** MULTI · **Own:** Identity · **Dep:** QA-AUTH-009
**Refs:** SYS-05 (`/admin/signas`, includes a "Stay signed in" option) · **Ev:** 02-role §3
**Risk:** Impersonation is indistinguishable from genuine user activity in logs, or persists beyond intent.
**Pre:** Privileged actor + target user. **Data:** `MULTI`.
**Steps:** 1) Start impersonation. 2) Perform an auditable action. 3) End impersonation. 4) Inspect audit records and UI.
**Expect:** A persistent, unmissable banner while impersonating; **every** action records actor **and** subject; impersonation auto-expires; it cannot be used to change the target's credentials or escalate the impersonator's own rights; the target's own audit view shows it was an impersonated action.
**iSched:** OBSERVED the feature and its form (never submitted — prohibited). Whether it retains impersonator or assumes target permissions is UNRESOLVED (#24).
**Decide:** SP-REQ. **Impact:** untraceable admin action attributed to a clinician. **Sec:** critical.
**Audit:** mandatory dual-identity. **Notify:** consider notifying the impersonated user. **Recover:** end session. **Open:** none.

#### QA-AUTH-011 · Archived user still referenced by historical schedules
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** High · **Level:** Domain, Database · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** QA-SCH-013
**Refs:** ADM-05 Remove, DA-01, WF-05a · **Ev:** 02-role §6 (placeholder/functional accounts exist and are assignable)
**Risk:** Deleting a user orphans or blanks historical assignments and audit entries.
**Pre:** User with past assignments and audit history. **Data:** historical fixture.
**Steps:** 1) Archive the user. 2) View past schedules, reports, and audit logs.
**Expect:** Archival is soft — historical assignments and audit entries still resolve the person's display name, marked as inactive; the user cannot be newly assigned; no record shows a null/"Unknown" actor.
**iSched:** OBSERVED that assignable identity slots include placeholders and shared accounts, implying soft handling; deletion behaviour UNRESOLVED.
**Decide:** SP-REQ. **Impact:** history becomes unreadable. **Sec:** low.
**Audit:** archival itself audited. **Notify:** none. **Recover:** un-archive restores assignability. **Open:** none.

#### QA-AUTH-012 · Anti-forgery protection on every state-changing request
**Class:** UNRESOLVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Security, API · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** none
**Refs:** all mutating endpoints · **Ev:** 10-technical §7 (no token observable on GET-only capture; mechanism INFERRED)
**Risk:** CSRF on schedule/vacation/picklist mutations.
**Pre:** Authenticated session. **Data:** n/a.
**Steps:** 1) Issue each state-changing request without the anti-forgery token. 2) With a token from another session. 3) With a valid token.
**Expect:** Only (3) succeeds. Enforcement is centrally applied so new endpoints are protected by default, not opt-in.
**iSched:** UNRESOLVED (#76) — no POST was ever triggered. **Decide:** SP-REQ.
**Impact:** attacker-triggered schedule changes. **Sec:** critical. **Audit:** log rejections. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-AUTH-013 · Session cookie flags
**Class:** INFERRED → SP-REQ · **Sev:** High · **Pri:** MVP-blocker · **Like:** Low · **Level:** Security · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** none
**Refs:** cookie names `remember`, `SelectedGroupId` · **Ev:** 10-technical §7 (auth cookie not JS-readable — `HttpOnly` inferred)
**Risk:** Auth cookie readable by injected script, or sent over plaintext.
**Pre:** n/a. **Data:** n/a.
**Steps:** Inspect Set-Cookie attributes for every cookie issued.
**Expect:** Auth/session cookie is `HttpOnly` + `Secure` + `SameSite`; only non-sensitive UI-state cookies are script-readable, and none carries PII.
**iSched:** INFERRED positive (auth cookie appears `HttpOnly`) — worth preserving deliberately.
**Decide:** SP-REQ (preserve the good pattern). **Impact:** session theft via XSS. **Sec:** critical.
**Audit:** none. **Notify:** none. **Recover:** rotate. **Open:** none.

#### QA-AUTH-014 · Multiple concurrent sessions for one user
**Class:** OBSERVED → SP-REQ · **Sev:** Medium · **Pri:** post-MVP · **Like:** High · **Level:** Concurrency, Playwright · **Auto:** Med · **Env:** CONC · **Own:** Identity · **Dep:** QA-AUTH-003
**Refs:** WF-01 · **Ev:** 03-user WF-01 (shared session across tabs)
**Risk:** Two devices diverge; one overwrites the other's view of "current" state.
**Pre:** Same user on two devices. **Data:** n/a.
**Steps:** 1) Act on device A. 2) Observe device B. 3) Sign out on A.
**Expect:** Device B reflects changes on next fetch or via real-time push; a global sign-out option exists; session list is viewable by the user.
**iSched:** OBSERVED tab-sharing only; cross-device behaviour UNRESOLVED. **Decide:** SP-IMP.
**Impact:** confusion. **Sec:** medium. **Audit:** session creation logged. **Notify:** optional new-device notice. **Recover:** global sign-out. **Open:** none.

---

## 3. Schedule periods, shifts, assignments, publication (QA-SCH)

Derived from ADM-02 (six-stage Build pipeline, `Erase Master Schedule`), SCH-02/03/04, WF-05/05a (cell editor + audit log), ADM-10/ADM-11 (Pattern/Staff rules), ADM-03 (FTE caps), ADM-07 (shift catalog), ADM-09 (Valid Groups).

#### QA-SCH-001 · Publishing an incomplete schedule
**Class:** UNRESOLVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Domain, Playwright · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** QA-SCH-002
**Refs:** ADM-02 Publish, SCH-02/03/04 · **Ev:** 05-engine §2 (no Draft/Running/Failed status exists; only Locked vs. unlocked)
**Risk:** A schedule with unfilled mandatory shifts publishes silently, and nobody notices a coverage hole until the day arrives.
**Pre:** Schedule with ≥1 unfilled mandatory shift. **Data:** partial-coverage fixture.
**Steps:** 1) Attempt publish. 2) Inspect blocking/warning behaviour. 3) Force-publish if permitted.
**Expect:** Publication is blocked, or requires explicit acknowledgement listing every unfilled mandatory shift; the acknowledgement is recorded in the audit trail with the actor's identity.
**iSched:** UNRESOLVED — Publish was never invoked (prohibited); no completeness gate was observable.
**Decide:** SP-REQ. **Impact:** uncovered clinical shift. **Sec:** low.
**Audit:** record what was incomplete at publish time. **Notify:** notify schedulers of gaps. **Recover:** fill and republish. **Open:** source publish semantics.

#### QA-SCH-002 · Publication prerequisites are explicit and re-checked at commit
**Class:** INFERRED → SP-REQ · **Sev:** High · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Domain, Concurrency · **Auto:** High · **Env:** CONC · **Own:** Scheduling · **Dep:** QA-CON-002
**Refs:** ADM-02 (Setup→Planner→Build→Fix Picks→Publish→Lock) · **Ev:** 05-engine §1 ("Generate Planner if you make changes to staff or shifts" warning implies staged state can go stale)
**Risk:** Setup changes after the Planner stage produce a publish based on stale derived state.
**Pre:** Build with generated planner. **Data:** build fixture.
**Steps:** 1) Generate planner. 2) Change staff/shift scope. 3) Publish without regenerating.
**Expect:** Publish re-validates that derived stages are current and refuses (not merely warns) if they are stale.
**iSched:** OBSERVED the warning text; whether publish enforces it is UNRESOLVED.
**Decide:** SP-IMP — turn an advisory warning into an enforced precondition.
**Impact:** published schedule doesn't match configured inputs. **Sec:** low.
**Audit:** record input-state hash at publish. **Notify:** none. **Recover:** regenerate + republish. **Open:** none.

#### QA-SCH-003 · Overlapping assignments for one person
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Domain, Database, API · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** none
**Refs:** SCH-02/03/04, ADM-07 (shift time windows) · **Ev:** 01-app ADM-07 (every shift has Time Start/End)
**Risk:** Two overlapping shifts assigned to one clinician — physically impossible coverage.
**Pre:** Two shifts with overlapping windows. **Data:** overlap fixture incl. exact-boundary and 1-minute-overlap cases.
**Steps:** 1) Assign both via UI. 2) Via API. 3) Via bulk import. 4) Via automated build.
**Expect:** Rejected (or explicitly flagged and acknowledged) through **every** path — UI, API, bulk, and generator. Boundary-touching shifts (A ends exactly when B starts) are allowed unless a rest rule says otherwise.
**iSched:** UNRESOLVED — no assignment was ever created. **Decide:** SP-REQ.
**Impact:** double-booked clinician. **Sec:** low. **Audit:** log override acknowledgements.
**Notify:** notify affected staff on conflict resolution. **Recover:** reassign. **Open:** none.

#### QA-SCH-004 · Overnight shift spanning midnight
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** MVP-blocker · **Like:** High · **Level:** Domain, Unit · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** QA-DATE-002
**Refs:** ADM-07 · **Ev:** 04-master §2 (shift codes with windows like 16:00→08:00 and 08:00→08:00 observed in the legend)
**Risk:** A shift ending before its start time (crossing midnight) is computed as negative duration, attributed to the wrong day, or double-counted.
**Pre:** Shift type 16:00→08:00 next day. **Data:** overnight fixture.
**Steps:** 1) Assign an overnight shift. 2) Check its display on both calendar days. 3) Check duration/credit maths, rest-period calc, and reports.
**Expect:** Duration computed across the boundary; the shift is anchored to one canonical date consistently everywhere; statistics count it exactly once.
**iSched:** OBSERVED that overnight shift types exist (e.g. a 16:00–08:00 backup shift); their calculation was never observable.
**Decide:** SP-REQ. **Impact:** wrong hours, wrong fairness credit. **Sec:** low.
**Audit:** none. **Notify:** none. **Recover:** recompute. **Open:** none.

#### QA-SCH-005 · Rest-period and maximum-hours violations
**Class:** OBSERVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Domain, Unit · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** QA-SCH-003
**Refs:** ADM-01 (`Lockout Minimum Hours`, `Locum Lockout Hours`), ADM-03 (`Max Shifts`), ADM-10 (spacing rules) · **Ev:** 01-app ADM-01; 05-engine §1
**Risk:** Manual assignment or a claim bypasses rest/max-hours rules that the generator respects.
**Pre:** Rules configured; staff at cap. **Data:** at-cap fixture.
**Steps:** 1) Generator assigns (expect compliance). 2) Manually assign a violating shift. 3) Claim an opportunity that violates rest. 4) Accept a swap that violates rest.
**Expect:** Every path evaluates the same rule engine. Violations are blocked, or require an explicit, audited override with a reason.
**iSched:** OBSERVED the settings exist and that a manual cell-edit path exists alongside the generated path; whether manual edits are rule-checked is UNRESOLVED.
**Decide:** SP-REQ — one rule engine, all paths.
**Impact:** unsafe clinical staffing, possible regulatory breach. **Sec:** low but compliance-relevant.
**Audit:** override reason + actor mandatory. **Notify:** notify affected clinician. **Recover:** reassign. **Open:** none.

#### QA-SCH-006 · Qualification/eligibility conflict
**Class:** OBSERVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Domain, Authorization · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** QA-SCH-005
**Refs:** ADM-03 (`Active` per shift type), ADM-06 (Staff Groups), ADM-09 (Valid Groups) · **Ev:** 01-app ADM-03; 05-engine ADM-09
**Risk:** An unqualified person is assigned to a specialised shift via manual edit, claim, or swap.
**Pre:** Staff member marked ineligible for shift type X. **Data:** eligibility fixture.
**Steps:** Attempt assignment of X to that person via each path (build, manual cell edit, opportunity claim, swap, bulk).
**Expect:** Blocked on every path with a message naming the missing qualification.
**iSched:** OBSERVED eligibility data exists (`Active` flag per staff per shift type); enforcement outside the generator UNRESOLVED.
**Decide:** SP-REQ. **Impact:** unqualified clinical coverage. **Sec:** low; safety-critical.
**Audit:** yes. **Notify:** yes. **Recover:** reassign. **Open:** none.

#### QA-SCH-007 · Duplicate shift definitions and duplicate assignments
**Class:** SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** Medium · **Level:** Database, Domain · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** none
**Refs:** ADM-07, SCH-02/03/04 · **Ev:** 01-app ADM-07
**Risk:** Two identical shift types (same code) or the same person assigned twice to one slot.
**Pre:** n/a. **Data:** duplicate fixture.
**Steps:** 1) Create a shift type with an existing short code. 2) Assign the same person to the same slot twice (UI, API, double-click, retry).
**Expect:** Unique constraints at the database level, not merely UI validation; idempotent assignment (repeat = no-op, not a second row).
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** double-counted credit, confusing grid.
**Sec:** low. **Audit:** none. **Notify:** none. **Recover:** dedupe migration. **Open:** none.

#### QA-SCH-008 · Concurrent editing of the same schedule cell
**Class:** INFERRED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Concurrency, Domain · **Auto:** High · **Env:** CONC · **Own:** Scheduling · **Dep:** QA-CON-001
**Refs:** WF-05/05a cell editor · **Ev:** 04-master §8 (each modal action appears immediately committed, with no draft/save step — INFERRED)
**Risk:** Two schedulers edit the same cell; last write silently wins and the first scheduler never learns their change was replaced.
**Pre:** Two scheduler sessions on the same cell. **Data:** `CONC`.
**Steps:** 1) Both open the cell. 2) A commits. 3) B commits a different value.
**Expect:** Optimistic concurrency — B is rejected with "this cell changed since you opened it," shown A's new value, and asked to redo deliberately.
**iSched:** INFERRED immediate-commit with no visible conflict handling; never tested (would require two sessions + a mutation).
**Decide:** SP-REQ. **Impact:** silently lost scheduling decisions. **Sec:** low.
**Audit:** both attempts recorded, including the rejected one. **Notify:** none. **Recover:** B re-applies. **Open:** none.

#### QA-SCH-009 · Concurrent publication of the same period
**Class:** UNRESOLVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Concurrency, Background job · **Auto:** High · **Env:** CONC · **Own:** Scheduling · **Dep:** QA-CON-002
**Refs:** ADM-02 Publish · **Ev:** 05-engine §2
**Risk:** Two admins publish overlapping periods simultaneously, producing interleaved or duplicated assignments and double notifications.
**Pre:** Two admin sessions, same period. **Data:** `CONC`.
**Steps:** Trigger publish simultaneously from both.
**Expect:** Serialised by a period-scoped lock; the second attempt is rejected or queued, never interleaved. Exactly one notification batch is sent.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** corrupted published schedule + duplicate mass notifications.
**Sec:** low. **Audit:** publish attempts + lock outcomes. **Notify:** exactly-once. **Recover:** see QA-SCH-011. **Open:** none.

#### QA-SCH-010 · Publication succeeds but notification dispatch fails
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** High · **Level:** Background job, Integration · **Auto:** High · **Env:** SEED · **Own:** Notifications · **Dep:** QA-NOT-009
**Refs:** ADM-02 Publish, ADM-01 `Final Picklist Emails` · **Ev:** 07-picklist §5; 01-app ADM-01
**Risk:** The schedule goes live but nobody is told, or the whole publish is rolled back because email failed.
**Pre:** Notification provider failing. **Data:** provider stub with induced failure.
**Steps:** 1) Publish with provider down. 2) Observe schedule state, job state, admin feedback. 3) Restore provider.
**Expect:** Publication commits; notification is a separately-retried job; the admin sees explicit "published, notifications pending/failed" status; retries are bounded and land in a dead-letter queue with an ops alert. Notification failure never rolls back publication, and publication success never implies delivery success.
**iSched:** UNRESOLVED — no delivery-status surface exists anywhere in the source (07-picklist §3).
**Decide:** SP-IMP — add explicit delivery observability the source lacks.
**Impact:** staff unaware of their schedule. **Sec:** low.
**Audit:** publish and dispatch recorded separately. **Notify:** ops alert. **Recover:** replay dispatch idempotently. **Open:** none.

#### QA-SCH-011 · Post-publication editing and rollback/unpublish
**Class:** UNRESOLVED → SP-REQ · **Sev:** Critical · **Pri:** pre-beta · **Like:** High · **Level:** Domain, Playwright · **Auto:** Med · **Env:** SEED · **Own:** Scheduling · **Dep:** QA-SCH-012
**Refs:** ADM-02 Lock/Unlock, WF-05a · **Ev:** 04-master §8 ("no explicit rollback or unpublish button was found anywhere"; Unlock reverses the lock, not the content)
**Risk:** A bad publish cannot be reversed; or edits after publish silently diverge from what staff were told.
**Pre:** Published schedule. **Data:** published fixture.
**Steps:** 1) Edit a published cell. 2) Attempt to revert the whole publication.
**Expect:** Post-publication edits are permitted but explicitly marked as amendments, are audited, and trigger targeted re-notification of affected staff only. A first-class **revert-to-previous-published-version** exists, is audited, and preserves the superseded version rather than deleting it.
**iSched:** UNRESOLVED — no rollback/unpublish control exists in the source (a genuine capability gap, not merely unobserved).
**Decide:** SP-IMP — this is a deliberate improvement over the source.
**Impact:** unrecoverable bad publish. **Sec:** low. **Audit:** mandatory. **Notify:** affected staff only, not everyone.
**Recover:** the whole point of the case. **Open:** none.

#### QA-SCH-012 · Published history preserved immutably
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** Medium · **Level:** Domain, Database · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** QA-SCH-011
**Refs:** ADM-02 (build history retained: sequential ids per period), WF-05a · **Ev:** 05-engine §2 ("a build is never silently replaced, only superseded")
**Risk:** Editing a schedule rewrites history, so "what were staff actually told on date X?" becomes unanswerable.
**Pre:** Published then amended schedule. **Data:** amendment fixture.
**Steps:** 1) Publish v1. 2) Amend and republish v2. 3) Query "what was published as of <timestamp>".
**Expect:** Every published version is retained and queryable as-of a timestamp; amendments never mutate a prior version in place.
**iSched:** OBSERVED the source retains build history (a genuine strength worth adopting) — but whether *published output* is versioned, as opposed to just build records, is UNRESOLVED.
**Decide:** SP-REQ (adopt and extend the strength). **Impact:** disputes unresolvable. **Sec:** medium (evidentiary).
**Audit:** inherent. **Notify:** none. **Recover:** restore any version. **Open:** none.

#### QA-SCH-013 · Inactive/archived staff and archived shift types referenced by a schedule
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** High · **Level:** Domain, Database · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** QA-AUTH-011
**Refs:** ADM-05, ADM-07 Delete, ADM-06 · **Ev:** 01-app ADM-07 (per-row Delete exists on the shift catalog)
**Risk:** Deleting a shift type or location that historical assignments reference breaks past schedules and reports.
**Pre:** Shift type with historical assignments. **Data:** historical fixture.
**Steps:** 1) Attempt to delete a referenced shift type. 2) Attempt to delete an unreferenced one.
**Expect:** Referenced entities can only be **deactivated** (hidden from new assignment) never hard-deleted; unreferenced ones may be deleted. Historical views continue to render the archived entity with an "archived" marker.
**iSched:** UNRESOLVED — Delete was never invoked. **Decide:** SP-REQ.
**Impact:** broken history and reports. **Sec:** low. **Audit:** deactivation audited. **Notify:** none. **Recover:** reactivate. **Open:** none.

#### QA-SCH-014 · Large schedule and long-name rendering
**Class:** OBSERVED → SP-REQ · **Sev:** Medium · **Pri:** pre-prod · **Like:** Medium · **Level:** Performance, Playwright, Accessibility · **Auto:** High · **Env:** PERF · **Own:** Frontend · **Dep:** QA-PERF-008, QA-A11Y-012
**Refs:** SCH-02/03/04 (8-week range × ~100 staff), CON-01 · **Ev:** 02-role §5 (94 and 103-row rosters); 09-responsive RA-03 (dense-table overflow)
**Risk:** A large group over a long range makes the grid unusable, and long names break layout or get silently truncated without a tooltip.
**Pre:** ≥200 staff, 8-week range, names at max length incl. non-Latin characters. **Data:** stress fixture.
**Steps:** 1) Render max range. 2) Measure interaction latency. 3) Inspect truncation and overflow at desktop and phone widths.
**Expect:** Virtualised/paged rendering keeps interaction responsive; truncated text exposes the full value via accessible tooltip/title; no layout break; the table (not the page) scrolls horizontally.
**iSched:** OBSERVED the source renders full ranges without virtualisation evidence and has a confirmed page-level overflow failure on dense tables.
**Decide:** SP-IMP. **Impact:** unusable at scale. **Sec:** low. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-SCH-015 · Every schedule mutation is attributably audited
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** MVP-blocker · **Like:** High · **Level:** Domain, Database, Integration · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** QA-TEN-011
**Refs:** WF-05a (per-cell provenance log with actor, action, timestamp, and a mechanism tag distinguishing self-service from admin action) · **Ev:** 04-master §3.3, §11
**Risk:** Changes cannot be explained after the fact — the single most valuable pattern found in the source is lost.
**Pre:** n/a. **Data:** n/a.
**Steps:** For every mutation path (generator, manual edit, claim, swap, proxy, impersonation, bulk, background job): 1) perform it; 2) assert an audit entry exists with actor, subject, mechanism, before/after, timestamp, org.
**Expect:** No mutation path may exist without producing an audit entry; entries are human-readable and immutable; the mechanism tag distinguishes self-service from administrative action.
**iSched:** OBSERVED — the source's per-cell audit log is a genuine strength (explicitly flagged in 04-master §11 as must-carry-forward). Exhaustiveness across all change types is UNRESOLVED (#36).
**Decide:** SP-REQ — adopt and make exhaustive.
**Impact:** unexplainable schedules, disputes. **Sec:** high (evidentiary). **Audit:** the case itself. **Notify:** none. **Recover:** n/a.
**Open:** whether source logs build-publish and erase events (#36).

#### QA-SCH-016 · Destructive bulk operations are gated proportionally to blast radius
**Class:** OBSERVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Playwright, Domain, Manual · **Auto:** Med · **Env:** SEED · **Own:** Scheduling · **Dep:** QA-CON-011
**Refs:** ADM-02 `Erase Master Schedule`, SCH Batch Add/Delete, LC-01b TRANSFER, LC-05 Batch Entry · **Ev:** 06-requests "Cross-cutting observations" (graduated confirmation friction); 01-app ADM-02
**Risk:** A single click erases an entire schedule.
**Pre:** Populated schedule. **Data:** restorable fixture.
**Steps:** For each destructive bulk action: 1) invoke; 2) inspect the confirmation gate; 3) confirm; 4) attempt recovery.
**Expect:** Friction scales with blast radius — wide/irreversible actions require typed confirmation naming the exact scope and record count, a dry-run preview of what will change, and either reversibility or an explicit "this cannot be undone" acknowledgement that is itself audited.
**iSched:** OBSERVED the source already implements graduated friction (typed "PUBLISH" for the vacation transfer) — a genuine strength — but also exposes `Erase Master Schedule` whose gating was never observed.
**Decide:** SP-REQ (adopt the graduated-friction pattern; add dry-run preview, which the source lacks).
**Impact:** catastrophic data loss. **Sec:** high. **Audit:** mandatory, incl. scope and count.
**Notify:** notify other admins after a wide destructive action. **Recover:** point-in-time restore (QA-CON-014). **Open:** none.

---

## 4. Requests, availability, vacation (QA-REQ)

Derived from LC-01/01a/01b (vacation lifecycle, batch approval, irreversible transfer), LC-02 (unresolved creation surface), VAC-01/02 (quotas, grants, negative-balance toggles), WF-08/09/10, ADM-01 (`Request Until Date`).

#### QA-REQ-001 · Request submitted before window opens or after deadline
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** MVP-blocker · **Like:** High · **Level:** Domain, API · **Auto:** High · **Env:** SEED · **Own:** Requests · **Dep:** none
**Refs:** ADM-01 `Request Until Date`, WF-10 ("(CLOSED)" vs "(UNTIL date)") · **Ev:** 03-user WF-10; 02-role §4 (window differs per group)
**Risk:** Deadline is enforced only by hiding the UI, so an API call or a stale open tab still submits.
**Pre:** Window closed. **Data:** closed-window fixture per org.
**Steps:** 1) Submit via UI after close. 2) Submit via API. 3) Submit from a tab loaded while open, sent after close.
**Expect:** All three rejected server-side with the same message and the deadline stated; the window is evaluated per organization (confirmed to differ per group).
**iSched:** OBSERVED the window state is displayed per group; enforcement UNRESOLVED.
**Decide:** SP-REQ. **Impact:** unfair late requests. **Sec:** low. **Audit:** log rejected late submissions. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-REQ-002 · Duplicate and overlapping requests for the same period
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Domain, Database · **Auto:** High · **Env:** SEED · **Own:** Requests · **Dep:** QA-CON-005
**Refs:** LC-01, WF-08 · **Ev:** 06-requests LC-01
**Risk:** The same week is requested twice (double-click, retry, two tabs), inflating quota counts.
**Pre:** One existing request. **Data:** duplicate fixture.
**Steps:** 1) Submit the same week twice rapidly. 2) Submit a partially overlapping range.
**Expect:** Exact duplicates are idempotent no-ops; overlaps are detected and either merged or rejected with an explicit conflict message. Quota counters never double-count.
**iSched:** UNRESOLVED — never submitted. **Decide:** SP-REQ.
**Impact:** corrupted quota accounting. **Sec:** low. **Audit:** yes. **Notify:** none. **Recover:** dedupe. **Open:** none.

#### QA-REQ-003 · Conflicting ON and OFF requests for the same date
**Class:** INFERRED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** Medium · **Level:** Domain · **Auto:** High · **Env:** SEED · **Own:** Requests · **Dep:** QA-REQ-002
**Refs:** LC-01, LC-02, ADM-08 `Allow Request` · **Ev:** 06-requests LC-02 (two request shapes coexist and are incompletely reconciled)
**Risk:** A user requests OFF for a shift group and ON for a specific shift on the same date; the engine honours both.
**Pre:** Both request types available. **Data:** conflict fixture.
**Steps:** 1) Create an OFF request for a shift group covering date D. 2) Create an ON request for a member shift on D.
**Expect:** Conflict detected at creation time with a clear explanation; the user chooses which to keep. The generator never receives contradictory constraints.
**iSched:** UNRESOLVED — the ON/shift-group request creation surface was never located (LC-02, unresolved #47).
**Decide:** SP-REQ. **Impact:** unsatisfiable constraints degrade generated schedules. **Sec:** low.
**Audit:** yes. **Notify:** none. **Recover:** user resolves. **Open:** LC-02 creation surface (carried forward).

#### QA-REQ-004 · Request for a date outside the permitted block
**Class:** OBSERVED → SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** Medium · **Level:** Domain · **Auto:** High · **Env:** SEED · **Own:** Requests · **Dep:** QA-REQ-001
**Refs:** VAC-02 (block start must be Monday, end must be Friday), LC-01 · **Ev:** 01-app VAC-02
**Risk:** Requests land outside the configured block through an API path that skips the UI's date constraints.
**Pre:** Block configured. **Data:** out-of-block dates incl. exact boundaries.
**Steps:** Submit for a date before the block, after the block, and exactly on each boundary.
**Expect:** Server enforces the block; boundary dates behave per an explicitly documented inclusive/exclusive rule (documented, not implied).
**iSched:** OBSERVED the source enforces weekday constraints via helper text in the UI; server enforcement UNRESOLVED.
**Decide:** SP-REQ. **Impact:** unschedulable requests. **Sec:** low. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-REQ-005 · Request by an inactive or newly-removed user
**Class:** SP-REQ · **Sev:** Medium · **Pri:** pre-prod · **Like:** Low · **Level:** Authorization, Domain · **Auto:** High · **Env:** CONC · **Own:** Requests · **Dep:** QA-AUTH-005
**Refs:** ADM-05, LC-01 · **Ev:** 01-app ADM-05
**Risk:** A deactivated user's in-flight request still counts against quota or gets approved.
**Pre:** Pending request; user then deactivated. **Data:** `CONC`.
**Steps:** 1) Create pending request. 2) Deactivate the user. 3) Inspect quota counters and the approval queue.
**Expect:** Pending requests from inactive users are surfaced distinctly to the approver and excluded from active quota maths; they are not silently auto-approved or silently dropped.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** phantom quota consumption. **Sec:** low.
**Audit:** yes. **Notify:** notify approver. **Recover:** approver resolves. **Open:** none.

#### QA-REQ-006 · Editing or withdrawing a request after it influenced a schedule
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Domain, Playwright · **Auto:** High · **Env:** SEED · **Own:** Requests · **Dep:** QA-SCH-011
**Refs:** WF-10 (DELETE present even on APPROVED rows), LC-01 · **Ev:** 03-user WF-10
**Risk:** Withdrawing an approved request that a published schedule already depends on silently creates a coverage hole.
**Pre:** Approved request already reflected in a published schedule. **Data:** published fixture.
**Steps:** 1) Withdraw the approved request. 2) Inspect the schedule, quota, and notifications.
**Expect:** Withdrawal after scheduling requires approver involvement (or at minimum flags the resulting gap prominently), never silently mutates a published schedule; the affected scheduler is notified.
**iSched:** OBSERVED a DELETE control exists on already-APPROVED rows — meaning post-approval retraction is possible in the source — but its downstream effect is UNRESOLVED.
**Decide:** SP-IMP — add the gap-detection the source appears to lack.
**Impact:** silent uncovered shift. **Sec:** low. **Audit:** yes. **Notify:** scheduler + affected staff. **Recover:** re-approve or backfill. **Open:** #31 (whether the two withdrawal surfaces hit one record).

#### QA-REQ-007 · Quota oversubscription for a week
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Domain, Concurrency · **Auto:** High · **Env:** CONC · **Own:** Requests · **Dep:** QA-REQ-008
**Refs:** VAC-01 (Weekly Quota vs Requested variance row, red when over), VAC-02 · **Ev:** 06-requests LC-01 (variance is advisory, not blocking — INFERRED)
**Risk:** More staff are approved off than the quota allows, discovered only when coverage fails.
**Pre:** Quota = N, N approved. **Data:** at-quota fixture.
**Steps:** 1) Submit request N+1. 2) Approve it. 3) Approve two pending requests concurrently at the boundary.
**Expect:** Over-quota approval is possible only via an explicit, audited override with a reason; the concurrent-approval case is serialised so the quota cannot be breached by a race.
**iSched:** OBSERVED the variance indicator exists and turns negative/red; INFERRED it is advisory only (nothing suggested hard blocking).
**Decide:** SP-IMP — keep the advisory signal, add an explicit override gate + race protection.
**Impact:** understaffed week. **Sec:** low. **Audit:** override reason mandatory. **Notify:** notify scheduler. **Recover:** revoke an approval. **Open:** none.

#### QA-REQ-008 · Concurrent approval of the last remaining quota slot
**Class:** UNRESOLVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Concurrency, Database · **Auto:** High · **Env:** CONC · **Own:** Requests · **Dep:** QA-CON-004
**Refs:** LC-01, LC-01a batch approval · **Ev:** 06-requests LC-01a
**Risk:** Two approvers (or one approver plus a batch-approval run) both consume the final slot.
**Pre:** Quota with exactly one slot free, two pending requests. **Data:** `CONC`.
**Steps:** 1) Approve both simultaneously from two sessions. 2) Repeat with one individual approval racing a batch approval covering the same range.
**Expect:** Exactly one succeeds; the other is rejected with "quota exhausted." Enforced by a transactional constraint, not an application-level pre-check.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** quota breach.
**Sec:** low. **Audit:** both attempts. **Notify:** both requesters get accurate outcomes. **Recover:** n/a. **Open:** none.

#### QA-REQ-009 · Negative vacation balance permitted only when configured
**Class:** OBSERVED → SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** Medium · **Level:** Domain, Unit · **Auto:** High · **Env:** SEED · **Own:** Requests · **Dep:** none
**Refs:** VAC-02 `Allow Negative Avail`, `Allow Negative Grant` · **Ev:** 01-app VAC-02
**Risk:** Balance goes negative when the setting forbids it, or the setting is ignored on one path.
**Pre:** Both settings, both values. **Data:** at-zero-balance fixture.
**Steps:** For each setting value: 1) request beyond balance via UI; 2) via API; 3) via batch entry.
**Expect:** Setting is honoured identically on every path; when negatives are allowed they are visibly flagged, not silently absorbed.
**iSched:** OBSERVED both toggles exist; enforcement UNRESOLVED. **Decide:** SP-REQ.
**Impact:** entitlement overdrawn. **Sec:** low. **Audit:** log negative-balance events. **Notify:** notify staff member. **Recover:** adjust grant. **Open:** none.

#### QA-REQ-010 · Vacation transfer to the schedule is idempotent and scoped
**Class:** OBSERVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Domain, Concurrency, Background job · **Auto:** High · **Env:** SEED, CONC · **Own:** Requests · **Dep:** QA-CON-003
**Refs:** LC-01b (typed-"PUBLISH" irreversible transfer) · **Ev:** 06-requests LC-01b ("It can NOT be undone")
**Risk:** Re-running the transfer over an already-transferred range duplicates entries or double-decrements balances.
**Pre:** Range already transferred. **Data:** transferred fixture.
**Steps:** 1) Re-run the transfer over the same range. 2) Run two transfers concurrently over overlapping ranges. 3) Run over a narrower sub-range.
**Expect:** Idempotent (re-run is a no-op or an explicit "already applied" result); overlapping concurrent runs are serialised; narrower scoping is supported rather than forcing the whole block.
**iSched:** OBSERVED the control, its irreversibility warning, and its default full-block scope; idempotency explicitly UNRESOLVED (#45).
**Decide:** SP-IMP — make it idempotent, scopable, previewable, and reversible (the source states it is irreversible).
**Impact:** duplicated vacation entries in a live schedule. **Sec:** low.
**Audit:** record scope + affected count. **Notify:** affected staff. **Recover:** must be reversible in SchedulePoint. **Open:** none.

#### QA-REQ-011 · Approval when the underlying request changed or vanished
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** Medium · **Level:** Concurrency, Domain · **Auto:** High · **Env:** CONC · **Own:** Requests · **Dep:** QA-CON-005
**Refs:** LC-01, WF-09 (Cancel/Save Comment/Remove/Deny in one modal) · **Ev:** 03-user WF-09
**Risk:** An approver approves a request the requester withdrew moments earlier (stale approval).
**Pre:** Pending request open in an approver's view. **Data:** `CONC`.
**Steps:** 1) Approver opens the request. 2) Requester withdraws it. 3) Approver clicks Approve.
**Expect:** Rejected with "this request is no longer pending"; the approver sees the current state. No resurrection of a withdrawn request.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** approving a non-existent request.
**Sec:** low. **Audit:** the stale attempt. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-REQ-012 · Weekend and holiday inclusion rules
**Class:** OBSERVED → SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** High · **Level:** Unit, Domain · **Auto:** High · **Env:** SEED · **Own:** Requests · **Dep:** QA-DATE-006
**Refs:** VAC-02 `Include Weekend Before/After`, `Include Holidays` · **Ev:** 01-app VAC-02
**Risk:** Each toggle combination silently changes how much entitlement a week consumes; an off-by-one costs staff a day.
**Pre:** All 8 toggle combinations. **Data:** combination matrix incl. a week adjacent to a holiday.
**Steps:** For each combination: request a week and assert the exact days deducted and the exact days marked off on the schedule.
**Expect:** Deduction and schedule marking agree exactly with the configured rule in all combinations; the rule is unit-tested independently of the UI.
**iSched:** OBSERVED all three toggles exist; their arithmetic was never observable.
**Decide:** SP-REQ. **Impact:** entitlement miscount, staff disputes. **Sec:** low.
**Audit:** none. **Notify:** none. **Recover:** recompute. **Open:** none.

#### QA-REQ-013 · Stale balance display after another actor's change
**Class:** SP-REQ · **Sev:** Medium · **Pri:** pre-prod · **Like:** High · **Level:** Concurrency, Playwright · **Auto:** High · **Env:** CONC · **Own:** Requests · **Dep:** QA-PERF-009
**Refs:** VAC-01 (Grant/Avail/Requested counters) · **Ev:** 06-requests LC-01 (counters derived from grid data)
**Risk:** A user acts on a balance figure that changed seconds ago in another session.
**Pre:** Two sessions on the vacation grid. **Data:** `CONC`.
**Steps:** 1) Session A approves. 2) Session B (not reloaded) submits based on the old balance.
**Expect:** Server re-validates against the current balance at commit time; the client shows a staleness indicator or refreshes on focus.
**iSched:** OBSERVED the counters exist and are derived live from grid data; staleness behaviour UNRESOLVED.
**Decide:** SP-REQ. **Impact:** decisions on stale numbers. **Sec:** low. **Audit:** none. **Notify:** none. **Recover:** refresh. **Open:** none.

#### QA-REQ-014 · Statistics correctness after withdrawal, transfer, or shift reassignment
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** High · **Level:** Domain, Database, Integration · **Auto:** High · **Env:** SEED · **Own:** Reporting · **Dep:** QA-RPT-005
**Refs:** ADM-04 (Credits/Target/Actual), cell editor's independent **Move Credit** vs **Move Shift** · **Ev:** 04-master §3.1 (assignment and fairness credit are separately movable — a major data-model finding)
**Risk:** Moving a shift without moving its credit (or vice versa) silently corrupts fairness statistics — and the source deliberately allows exactly this.
**Pre:** Assignments with credits. **Data:** credit fixture.
**Steps:** 1) Move a shift without its credit. 2) Move a credit without its shift. 3) Withdraw an approved vacation. 4) Recompute statistics after each.
**Expect:** The shift/credit split is preserved as a **deliberate, visible** feature — statistics always state which basis they use, and any divergence between "who worked it" and "who was credited" is explicitly reportable rather than hidden.
**iSched:** OBSERVED the split exists and both moves are independently available.
**Decide:** SP-REQ (adopt the model; add divergence visibility the source lacks).
**Impact:** unfair scheduling decisions based on wrong credit data. **Sec:** low.
**Audit:** both moves audited separately. **Notify:** none. **Recover:** recompute. **Open:** none.

---

## 5. Opportunities, swaps, transfers (QA-OPP)

Derived from LC-03 (opportunity board), LC-04 (swap, lifecycle unresolved), WF-11/12/13, and the audit-log wording that attributes a give-away to the *claiming* party.

#### QA-OPP-001 · Simultaneous acceptance of one opportunity
**Class:** UNRESOLVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Concurrency, Database · **Auto:** High · **Env:** CONC · **Own:** Scheduling · **Dep:** QA-CON-004
**Refs:** LC-03 · **Ev:** 06-requests LC-03 ("what resolves the race is UNRESOLVED"; claim side never observed)
**Risk:** Two clinicians both believe they claimed the same shift.
**Pre:** One open opportunity, two eligible sessions. **Data:** `CONC`.
**Steps:** Accept simultaneously from both sessions; repeat under induced network latency.
**Expect:** Exactly one wins via an atomic conditional update (claim only if still unclaimed); the loser gets an immediate, unambiguous "already taken" message — never a false success.
**iSched:** UNRESOLVED — single-account research could never observe the claim side. **Decide:** SP-REQ.
**Impact:** double-assignment or a clinician who thinks they are covered and is not. **Sec:** low.
**Audit:** both attempts, winner and loser. **Notify:** both parties told the true outcome. **Recover:** n/a. **Open:** #49.

#### QA-OPP-002 · Ineligible claimant blocked
**Class:** UNRESOLVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Authorization, Domain · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** QA-SCH-006
**Refs:** LC-03, ADM-03, ADM-06 · **Ev:** 06-requests LC-03 ("Locum restrictions UNRESOLVED")
**Risk:** Anyone who can see the board can claim anything, regardless of qualification, role, or lockout.
**Pre:** Opportunity requiring qualification X; claimant lacks X. **Data:** eligibility fixture incl. a Locum inside lockout.
**Steps:** Attempt claim via UI and via API for each ineligible category.
**Expect:** Rejected server-side; ideally ineligible users never see the opportunity, but visibility is never the control.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** unqualified coverage. **Sec:** high.
**Audit:** yes. **Notify:** none. **Recover:** n/a. **Open:** Locum eligibility rules.

#### QA-OPP-003 · Claim that would create an overlap or rest violation
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Domain · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** QA-SCH-003, QA-SCH-005
**Refs:** LC-03, ADM-01 lockout settings · **Ev:** 06-requests LC-03
**Risk:** Self-service claiming bypasses the rules the generator enforces.
**Pre:** Claimant already assigned adjacent/overlapping work. **Data:** conflict fixture.
**Steps:** Attempt to claim an overlapping shift, then one violating minimum rest.
**Expect:** Both blocked by the same shared rule engine used by the generator and by manual assignment.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** unsafe roster. **Sec:** low; safety-critical.
**Audit:** yes. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-OPP-004 · Opportunity withdrawn while someone is accepting
**Class:** UNRESOLVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** Medium · **Level:** Concurrency · **Auto:** High · **Env:** CONC · **Own:** Scheduling · **Dep:** QA-OPP-001
**Refs:** LC-03 (poster's Remove control) · **Ev:** 06-requests LC-03; 03-user WF-12
**Risk:** Poster removes the offer at the same instant a colleague accepts; both operations "succeed."
**Pre:** Open opportunity. **Data:** `CONC`.
**Steps:** Fire Remove and Accept simultaneously.
**Expect:** One deterministic winner; if acceptance wins, removal is rejected as "already claimed"; if removal wins, acceptance fails cleanly. Never both.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** ambiguous shift ownership. **Sec:** low.
**Audit:** both. **Notify:** both parties. **Recover:** n/a. **Open:** none.

#### QA-OPP-005 · Underlying assignment changes after posting
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** Medium · **Level:** Domain, Concurrency · **Auto:** High · **Env:** CONC · **Own:** Scheduling · **Dep:** QA-SCH-008
**Refs:** LC-03, WF-05a · **Ev:** 04-master §3.3
**Risk:** An admin reassigns or deletes the shift while it sits on the opportunity board, so the board offers something that no longer exists.
**Pre:** Posted opportunity. **Data:** `CONC`.
**Steps:** 1) Post. 2) Admin reassigns/deletes the underlying shift. 3) Another user attempts to claim.
**Expect:** The opportunity is automatically invalidated/withdrawn when its underlying assignment changes; claiming a stale offer fails with an explanatory message.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** phantom offers. **Sec:** low.
**Audit:** invalidation logged. **Notify:** notify the poster. **Recover:** repost. **Open:** none.

#### QA-OPP-006 · Expiry of an unclaimed opportunity
**Class:** UNRESOLVED → SP-REQ · **Sev:** Medium · **Pri:** pre-prod · **Like:** High · **Level:** Background job, Domain · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** QA-NOT-010
**Refs:** LC-03 · **Ev:** 06-requests LC-03 (no expiry mechanism found)
**Risk:** Opportunities for past dates linger on the board forever; or one expires mid-acceptance.
**Pre:** Opportunity approaching its shift date. **Data:** near-expiry fixture.
**Steps:** 1) Let it pass the date. 2) Separately, attempt acceptance exactly at the expiry boundary.
**Expect:** Automatic expiry at a defined, documented cutoff; boundary acceptance is resolved atomically (either clearly accepted or clearly expired, never ambiguous); the poster is notified it went unclaimed.
**iSched:** UNRESOLVED — no expiry mechanism was found. **Decide:** SP-IMP.
**Impact:** stale board, shift silently uncovered. **Sec:** low. **Audit:** expiry logged.
**Notify:** poster + scheduler. **Recover:** repost or escalate. **Open:** none.

#### QA-OPP-007 · Self-acceptance prevented
**Class:** SP-REQ · **Sev:** Low · **Pri:** pre-beta · **Like:** Medium · **Level:** Domain, Unit · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** none
**Refs:** LC-03 · **Ev:** 06-requests LC-03 (poster's own entries showed a Remove control, not an Accept)
**Risk:** A poster claims their own give-away, creating a confusing no-op audit trail.
**Pre:** Own posted opportunity. **Data:** n/a.
**Steps:** Attempt to accept your own opportunity via UI and API.
**Expect:** Blocked with a clear message; the poster's affordance is Remove, not Accept.
**iSched:** OBSERVED the poster sees Remove (not Accept) on their own entries — consistent with the requirement.
**Decide:** SP-REQ (match). **Impact:** trivial. **Sec:** none. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-OPP-008 · Duplicate acceptance and idempotency
**Class:** SP-REQ · **Sev:** High · **Pri:** MVP-blocker · **Like:** High · **Level:** API, Concurrency · **Auto:** High · **Env:** CONC · **Own:** Platform · **Dep:** QA-CON-006
**Refs:** LC-03 · **Ev:** 10-technical §8 (no client-side dedupe observed anywhere)
**Risk:** Double-click or a network retry produces two acceptance records or two audit entries.
**Pre:** Open opportunity. **Data:** n/a.
**Steps:** 1) Double-click Accept. 2) Replay the accept request with the same idempotency key. 3) Replay with a new key.
**Expect:** Accept carries a client-generated idempotency key; identical replays return the original result without side effects; only a genuinely new key can produce a new claim.
**iSched:** UNRESOLVED for mutations; the source demonstrably lacks client request de-duplication on reads (see QA-PERF-001).
**Decide:** SP-REQ. **Impact:** duplicate assignment. **Sec:** low. **Audit:** one entry per real claim.
**Notify:** exactly-once. **Recover:** n/a. **Open:** none.

#### QA-OPP-009 · Swap requires explicit counterpart confirmation
**Class:** UNRESOLVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Domain, Playwright · **Auto:** High · **Env:** MULTI, CONC · **Own:** Scheduling · **Dep:** QA-OPP-010
**Refs:** LC-04, WF-13 · **Ev:** 06-requests LC-04 (partner-acceptance vs scheduler-approval genuinely undetermined)
**Risk:** One clinician unilaterally moves work onto a colleague who never agreed.
**Pre:** Two staff with swappable shifts. **Data:** `MULTI`.
**Steps:** 1) Propose swap. 2) Assert nothing changes before the counterpart responds. 3) Accept. 4) Separately, decline.
**Expect:** No schedule change until the counterpart explicitly accepts (and, if configured, a scheduler approves). Proposals expire. Both parties always see current status.
**iSched:** UNRESOLVED — the source's swap model was never determined (#48, #32). This is a genuine product-definition gap.
**Decide:** SP-REQ — SchedulePoint must define this explicitly rather than inherit ambiguity.
**Impact:** non-consensual reassignment. **Sec:** medium. **Audit:** proposal, response, approval.
**Notify:** both parties at every transition. **Recover:** withdraw before acceptance. **Open:** source model unknown — blocks nothing for SchedulePoint since we define our own.

#### QA-OPP-010 · Swap validity re-checked at acceptance, not only at proposal
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Domain, Concurrency · **Auto:** High · **Env:** CONC · **Own:** Scheduling · **Dep:** QA-OPP-009, QA-SCH-005
**Refs:** LC-04 · **Ev:** 06-requests LC-04
**Risk:** A swap valid when proposed becomes invalid (overlap, rest violation, vacation approved) by the time it is accepted.
**Pre:** Proposed swap. **Data:** `CONC`.
**Steps:** 1) Propose. 2) Change one party's schedule so the swap would now violate a rule. 3) Accept.
**Expect:** Acceptance re-runs full validation and fails with the specific violated rule; validation at proposal time is never sufficient.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** invalid roster via a race. **Sec:** low.
**Audit:** the rejected acceptance. **Notify:** both parties. **Recover:** re-propose. **Open:** none.

#### QA-OPP-011 · Swap/transfer is atomic — both legs or neither
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Database, Domain · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** QA-CON-010
**Refs:** LC-04 · **Ev:** 06-requests LC-04 ("presumably exchanges the two named picks" — INFERRED)
**Risk:** A partial failure leaves one person released and the other not assigned — an uncovered shift.
**Pre:** Accepted swap. **Data:** fault-injection at the mid-transaction point.
**Steps:** Inject a failure between the two legs of the exchange; repeat for each leg.
**Expect:** Single transaction; on failure nothing changes and the user sees an explicit failure. No half-applied swap is ever persisted.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** uncovered shift, hardest class of bug to detect.
**Sec:** low. **Audit:** attempt + rollback. **Notify:** both parties on failure. **Recover:** automatic (rollback). **Open:** none.

#### QA-OPP-012 · Cross-tenant acceptance impossible
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Low · **Level:** Authorization, Security · **Auto:** High · **Env:** MULTI · **Own:** Platform · **Dep:** QA-TEN-006
**Refs:** LC-03, LC-04 · **Ev:** 02-role §4
**Risk:** A user claims an opportunity or accepts a swap belonging to an organization they are not a member of.
**Pre:** Opportunity in Org B; actor is Org A only. **Data:** `MULTI`.
**Steps:** Attempt claim/accept with Org B's resource id while authenticated in Org A.
**Expect:** 404/403; the resource id alone is never sufficient authority.
**iSched:** UNRESOLVED (authorization boundaries deliberately never tested). **Decide:** SP-REQ.
**Impact:** cross-tenant schedule corruption. **Sec:** critical. **Audit:** yes. **Notify:** security alert. **Recover:** n/a. **Open:** none.

---

## 6. Picklists (QA-PICK)

**Live picklist execution and real-time behaviour remain UNRESOLVED and are carried forward.** No picklist was ever active across eleven phases (07-picklist §2/§4). Every case below is therefore a **future SchedulePoint test**, never a source-site test. Phase 11 did confirm a SignalR hub named `picklist` connects on every page load (10-technical §8), which constrains the architecture but not the behaviour.

#### QA-PICK-001 · Empty picklist (no rooms, no staff, or neither)
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** Medium · **Level:** Domain, Playwright · **Auto:** High · **Env:** LIVE-SIM · **Own:** Picklist · **Dep:** none
**Refs:** PLM-01 · **Ev:** 07-picklist §1
**Risk:** Starting a draft with an empty work pool or empty participant list hangs or completes instantly with no explanation.
**Pre:** Picklist with zero rooms; another with zero staff; another with neither. **Data:** empty fixtures.
**Steps:** Attempt to start each.
**Expect:** Start is blocked with a specific, actionable reason naming what is missing. Never a started-but-unrunnable draft.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** stuck draft blocking a day's assignments.
**Sec:** low. **Audit:** blocked start logged. **Notify:** none. **Recover:** populate and retry. **Open:** none.

#### QA-PICK-002 · Duplicate rooms or duplicate staff in one picklist
**Class:** OBSERVED → SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** Medium · **Level:** Domain, Database · **Auto:** High · **Env:** SEED · **Own:** Picklist · **Dep:** QA-SCH-007
**Refs:** PLM-01 Work/Staff panels · **Ev:** 07-picklist §0 (an "Add Room" click created a real, blank, unnamed room instantly)
**Risk:** Blank or duplicate rooms enter the pool; a staff member appears twice in the order.
**Pre:** Populated picklist. **Data:** duplicate fixture.
**Steps:** 1) Add a room with an existing title. 2) Add a blank room. 3) Import staff twice.
**Expect:** Blank/unnamed work items cannot be persisted; duplicate detection warns; import is idempotent.
**iSched:** OBSERVED — a blank room *was* persisted instantly with no validation (the Phase 8 incident), then deleted. This is direct evidence the source permits blank work items.
**Decide:** SP-IMP. **Impact:** confusing draft, unassignable slot. **Sec:** low.
**Audit:** yes. **Notify:** none. **Recover:** delete. **Open:** none.

#### QA-PICK-003 · "Add" controls stage a draft and require explicit save
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** MVP-blocker · **Like:** High · **Level:** Playwright, Component · **Auto:** High · **Env:** SEED · **Own:** Frontend · **Dep:** none
**Refs:** PLM-01 Add Room · **Ev:** 07-picklist §0 (the safety incident — instant commit on click, no preview, no confirm)
**Risk:** An exploratory or accidental click permanently creates live data.
**Pre:** Any create-capable screen. **Data:** n/a.
**Steps:** For every "Add/New/Create" control in SchedulePoint: 1) click it; 2) assert no persistence occurred; 3) abandon; 4) assert still no record.
**Expect:** **No control labelled Add/New/Create may persist anything before an explicit, separate Save.** Abandoning the form leaves no trace.
**iSched:** OBSERVED — the source violates this, confirmed by a real incident with a real record created and removed.
**Decide:** SP-IMP — this is one of the clearest "do not replicate" findings in the entire research effort.
**Impact:** accidental live data creation; also the direct cause of the only safety incident in twelve phases.
**Sec:** medium. **Audit:** creation audited. **Notify:** none. **Recover:** delete. **Open:** none.

#### QA-PICK-004 · Missing contact information for a participant
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Domain, Integration · **Auto:** High · **Env:** LIVE-SIM · **Own:** Notifications · **Dep:** QA-NOT-002
**Refs:** ADM-05 (rows with no phone), PL-02 channels · **Ev:** 07-picklist §3 (several roles carry no phone; behaviour on send UNRESOLVED)
**Risk:** A participant's turn arrives and no channel can reach them; the draft stalls silently.
**Pre:** Participant with no phone and/or no email. **Data:** incomplete-contact fixture.
**Steps:** 1) Start a draft including them. 2) Reach their turn. 3) Observe.
**Expect:** Detected **before** the draft starts (pre-flight validation listing unreachable participants); at send time an unreachable channel is skipped with a recorded reason and escalation proceeds to the next reachable channel or to the scheduler.
**iSched:** OBSERVED that contactless accounts exist; send-time behaviour UNRESOLVED (no delivery log exists anywhere).
**Decide:** SP-IMP. **Impact:** stalled draft, missed shift. **Sec:** low.
**Audit:** record the skip + reason. **Notify:** alert the scheduler. **Recover:** scheduler acts on their behalf. **Open:** none.

#### QA-PICK-005 · Two users selecting the same room simultaneously
**Class:** UNRESOLVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Concurrency, Database · **Auto:** High · **Env:** LIVE-SIM, CONC · **Own:** Picklist · **Dep:** QA-CON-004
**Refs:** picklist room-selection state machine (07-picklist §2 Mermaid) · **Ev:** 07-picklist §4 (explicitly unresolvable in this research)
**Risk:** Two clinicians both believe they hold the same room.
**Pre:** Active draft; a race constructed (e.g. proxy acting while the delegator also acts). **Data:** `LIVE-SIM`.
**Steps:** Submit the same room selection from two sessions simultaneously.
**Expect:** Server-authoritative room ownership via an atomic conditional claim; exactly one succeeds; the loser is immediately re-presented with the true remaining pool.
**iSched:** UNRESOLVED — carried forward, not investigated. **Decide:** SP-REQ.
**Impact:** the single highest-risk correctness failure in the product's signature feature. **Sec:** low.
**Audit:** both attempts. **Notify:** both parties. **Recover:** loser re-picks. **Open:** #51 (carried forward).

#### QA-PICK-006 · Selection submitted after the turn timer expired
**Class:** INFERRED → SP-REQ · **Sev:** High · **Pri:** MVP-blocker · **Like:** High · **Level:** Concurrency, Domain · **Auto:** High · **Env:** LIVE-SIM · **Own:** Picklist · **Dep:** QA-PICK-007
**Refs:** ADM-01 `Alert Pick Time`, ADM-05 `Action Time` · **Ev:** 07-picklist §2 (timers inferred from settings; no countdown UI ever seen)
**Risk:** A selection lands just as the turn is auto-advanced, assigning a room to someone whose turn had passed.
**Pre:** Turn about to expire. **Data:** `LIVE-SIM` with controllable clock.
**Steps:** Submit a selection at, just before, and just after the expiry instant.
**Expect:** A single server-side authority decides; a late selection is rejected with "your turn has passed," never applied retroactively; the boundary is resolved atomically, not by client clock.
**iSched:** INFERRED that a per-pick time budget exists (settings imply it); no timer UI or behaviour was ever observed.
**Decide:** SP-REQ. **Impact:** wrong assignment + broken turn order. **Sec:** low.
**Audit:** the rejected late selection. **Notify:** inform the late picker. **Recover:** they wait for a later turn. **Open:** #51.

#### QA-PICK-007 · Automatic advancement, skips, and exclusions
**Class:** INFERRED → SP-REQ · **Sev:** High · **Pri:** MVP-blocker · **Like:** High · **Level:** Domain, Background job · **Auto:** High · **Env:** LIVE-SIM · **Own:** Picklist · **Dep:** QA-PICK-006
**Refs:** ADM-05 `Picks Excluded` (per-user excluded round numbers) · **Ev:** 07-picklist §2 (INFERRED from the field name; never observed operating)
**Risk:** The draft stalls on a non-responsive picker, or silently skips someone who should have had a turn.
**Pre:** Participants including one with configured exclusions and one who never responds. **Data:** `LIVE-SIM`.
**Steps:** 1) Run a draft. 2) Let one turn time out. 3) Assert exclusion rounds are skipped correctly.
**Expect:** Advancement is deterministic and fully audited (who was skipped, why, when); an excluded participant is skipped only for their configured rounds; a timed-out participant is recorded as timed-out, not as "declined."
**iSched:** INFERRED only. **Decide:** SP-REQ. **Impact:** unfair or stalled draft. **Sec:** low.
**Audit:** every skip with reason. **Notify:** notify the skipped party. **Recover:** scheduler override. **Open:** #51.

#### QA-PICK-008 · Pause and resume mid-draft
**Class:** UNRESOLVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** Medium · **Level:** Domain, Playwright · **Auto:** Med · **Env:** LIVE-SIM · **Own:** Picklist · **Dep:** QA-PICK-007
**Refs:** picklist pause/resume state machine · **Ev:** 07-picklist §4 (no pause/resume control was ever found anywhere)
**Risk:** No way to halt a draft that is going wrong; or pausing loses the current turn's state.
**Pre:** Active draft. **Data:** `LIVE-SIM`.
**Steps:** 1) Pause mid-turn. 2) Attempt a selection while paused. 3) Resume. 4) Assert the same picker retains their turn with a fresh, fair timer.
**Expect:** Pause suspends all timers and rejects selections with a clear "paused" message; resume restores the exact prior position; both transitions are audited and announced to participants.
**iSched:** UNRESOLVED — no such control exists in the source's observable surface.
**Decide:** SP-IMP — add the capability the source appears to lack. **Impact:** no recovery lever during a live problem.
**Sec:** low. **Audit:** both transitions. **Notify:** all participants. **Recover:** the case itself. **Open:** #51.

#### QA-PICK-009 · Locking during an active selection
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** Low · **Level:** Concurrency, Domain · **Auto:** High · **Env:** LIVE-SIM, CONC · **Own:** Picklist · **Dep:** QA-PICK-008
**Refs:** PLM-01 Locked/Unlocked toggle · **Ev:** 07-picklist §1 (locking removes controls from the DOM entirely rather than disabling them)
**Risk:** An admin locks the list at the instant a participant submits a selection.
**Pre:** Active draft. **Data:** `CONC`.
**Steps:** Fire Lock and a room selection simultaneously.
**Expect:** Deterministic ordering — either the selection commits then the lock applies, or the lock applies and the selection is cleanly rejected. Never a partially-applied selection on a locked list.
**iSched:** OBSERVED lock/unlock exists and materially changes available controls; concurrent behaviour UNRESOLVED.
**Decide:** SP-REQ. **Impact:** inconsistent final state. **Sec:** low. **Audit:** both. **Notify:** affected picker. **Recover:** unlock and redo. **Open:** none.

#### QA-PICK-010 · Scheduler override during an active draft
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** Medium · **Level:** Domain, Authorization · **Auto:** High · **Env:** LIVE-SIM · **Own:** Picklist · **Dep:** QA-SCH-015
**Refs:** cell editor Move Shift/Move Credit (works regardless of picklist state) · **Ev:** 07-picklist §2; 04-master §3
**Risk:** An admin edits an assignment mid-draft, and the draft's own state diverges from the schedule.
**Pre:** Active draft. **Data:** `LIVE-SIM`.
**Steps:** Admin reassigns a room already selected in the running draft; then one not yet selected.
**Expect:** The draft observes the change and reconciles (the room leaves/enters the available pool live); the override is audited and distinguished from a participant's own pick.
**iSched:** OBSERVED that the override path exists and is audited with a mechanism tag distinguishing self-service from admin action — a strength worth adopting.
**Decide:** SP-REQ. **Impact:** draft/schedule divergence. **Sec:** low.
**Audit:** mandatory, with mechanism tag. **Notify:** notify participants of pool changes. **Recover:** re-sync. **Open:** none.

#### QA-PICK-011 · Proxy conflict — delegator and proxy both act
**Class:** UNRESOLVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** Medium · **Level:** Concurrency, Authorization · **Auto:** High · **Env:** LIVE-SIM, CONC · **Own:** Picklist · **Dep:** QA-AUTH-009
**Refs:** PL-02 Pick Proxy · **Ev:** 07-picklist §2 (whether the proxy picks or only receives notifications is UNRESOLVED)
**Risk:** Two different people submit a selection for one turn.
**Pre:** Delegation active. **Data:** `CONC`.
**Steps:** Delegator and proxy submit different selections simultaneously.
**Expect:** One turn accepts exactly one selection; the loser sees "this turn was already completed by <the other party>"; the audit records which identity acted on whose behalf.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** contested assignment. **Sec:** medium (attribution).
**Audit:** dual identity. **Notify:** notify the delegator whenever a proxy acts. **Recover:** override. **Open:** proxy semantics (#27).

#### QA-PICK-012 · Connection loss and reconnection mid-draft
**Class:** UNRESOLVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Playwright, Integration, Concurrency · **Auto:** Med · **Env:** LIVE-SIM · **Own:** Frontend/Realtime · **Dep:** QA-PICK-013
**Refs:** SignalR `picklist` hub · **Ev:** 10-technical §8 (hub confirmed; message flow never observed); 07-picklist §4 (explicitly unresolved)
**Risk:** A participant's connection drops during their turn and they lose it without knowing; or reconnects into a stale view and picks an already-taken room.
**Pre:** Active draft. **Data:** `LIVE-SIM` with controllable network.
**Steps:** 1) Drop connection during a turn. 2) Restore. 3) Assert state. 4) Attempt a selection based on the pre-drop view.
**Expect:** The client detects disconnection and shows an unmistakable "reconnecting — do not rely on this view" state; on reconnect it re-syncs authoritative state before enabling any control; a selection based on stale state is rejected server-side.
**iSched:** UNRESOLVED — carried forward. **Decide:** SP-REQ.
**Impact:** lost turn or invalid pick. **Sec:** low. **Audit:** connection events. **Notify:** in-app. **Recover:** re-sync. **Open:** #51, #72.

#### QA-PICK-013 · Multiple tabs and multiple monitoring sessions
**Class:** UNRESOLVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Concurrency, Playwright · **Auto:** Med · **Env:** LIVE-SIM, CONC · **Own:** Frontend/Realtime · **Dep:** QA-PICK-012
**Refs:** DASH-01 monitor, PL-01 · **Ev:** 07-picklist §4; 10-technical §8 (a fresh hub connection per page load)
**Risk:** One participant with two tabs double-submits; several schedulers monitoring diverge in what they see.
**Pre:** Active draft, two tabs + two monitor sessions. **Data:** `CONC`.
**Steps:** 1) Submit from tab A and tab B. 2) Compare both monitors' displayed state continuously.
**Expect:** Server-side turn ownership makes the second submission a no-op; all monitors converge to identical state within a bounded interval; no monitor shows a permanently stale picture.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** duplicate picks, mismatched oversight.
**Sec:** low. **Audit:** all submissions. **Notify:** none. **Recover:** re-sync. **Open:** #51.

#### QA-PICK-014 · Completion with unresolved picks
**Class:** UNRESOLVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** Medium · **Level:** Domain · **Auto:** High · **Env:** LIVE-SIM · **Own:** Picklist · **Dep:** QA-PICK-007
**Refs:** picklist completion state machine · **Ev:** 07-picklist §2 (completion inferred automatic; no explicit Complete control found)
**Risk:** A draft marks itself complete with rooms unassigned or participants unserved.
**Pre:** Draft where some turns timed out. **Data:** `LIVE-SIM`.
**Steps:** Let a draft reach the end with unfilled rooms.
**Expect:** Completion states explicitly whether it is *fully* or *partially* resolved, lists what remains unassigned, and requires scheduler acknowledgement before the result is distributed.
**iSched:** UNRESOLVED. **Decide:** SP-IMP. **Impact:** silently uncovered rooms. **Sec:** low.
**Audit:** completion state + unresolved list. **Notify:** scheduler. **Recover:** manual assignment. **Open:** #51.

#### QA-PICK-015 · Reopening and correcting a completed picklist
**Class:** INFERRED → SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** Medium · **Level:** Domain, Playwright · **Auto:** Med · **Env:** SEED · **Own:** Picklist · **Dep:** QA-SCH-011
**Refs:** PLM-01 Locked/Unlocked (the only plausible reopen path found) · **Ev:** 07-picklist §5 (no distinct Reopen control exists)
**Risk:** Corrections after distribution silently contradict what participants were already told.
**Pre:** Completed, distributed picklist. **Data:** completed fixture.
**Steps:** 1) Reopen. 2) Correct a selection. 3) Inspect notifications and the prior distributed record.
**Expect:** Reopening is a first-class, audited action; corrections mark the result as amended, preserve the originally distributed version, and re-notify only affected participants.
**iSched:** INFERRED that Unlock is the only reopen mechanism; never tested (explicitly prohibited).
**Decide:** SP-IMP. **Impact:** participants act on superseded assignments. **Sec:** low.
**Audit:** reopen + each correction. **Notify:** affected only. **Recover:** revert to distributed version. **Open:** #54.

#### QA-PICK-016 · Picklist results synchronise to the schedule exactly once
**Class:** INFERRED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Integration, Domain, Background job · **Auto:** High · **Env:** LIVE-SIM · **Own:** Picklist · **Dep:** QA-CON-006
**Refs:** DA-01 (`pickListId`-scoped output), PLM-01 Import ("will erase all current data") · **Ev:** 07-picklist §1, §5
**Risk:** Results are written twice (duplicated assignments) or zero times (draft completes but the schedule never reflects it); or a re-import silently erases resolved picks.
**Pre:** Completed draft. **Data:** `LIVE-SIM` with fault injection.
**Steps:** 1) Complete a draft. 2) Assert schedule state. 3) Re-trigger sync. 4) Inject a failure mid-sync then retry. 5) Re-run Import over a resolved list.
**Expect:** Synchronisation is idempotent and transactional; retry after partial failure converges to exactly one correct result; a destructive re-import over resolved picks requires explicit confirmation naming what will be lost.
**iSched:** OBSERVED that Import warns it will erase current data — evidence the destructive path exists; the sync path itself is INFERRED.
**Decide:** SP-REQ. **Impact:** duplicated or missing assignments for a whole day. **Sec:** low.
**Audit:** sync attempts + outcome. **Notify:** on failure, alert scheduler. **Recover:** idempotent replay. **Open:** #51.

#### QA-PICK-017 · Patient-information boundary in picklist surfaces
**Class:** OBSERVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Security, Manual exploratory, Playwright · **Auto:** Med · **Env:** SEED · **Own:** Privacy · **Dep:** QA-SEC-006
**Refs:** SCH-01 "Today's Shifts", DA-01 · **Ev:** 07-picklist §6 (clinical case-level detail confirmed present on personal schedule views; picking surfaces themselves showed only room/shift labels)
**Risk:** Clinical/case detail leaks into scheduling surfaces, exports, notifications, or screenshots, subjecting a scheduling product to clinical-system obligations.
**Pre:** Fixture with case-level data present. **Data:** synthetic clinical detail only — never real.
**Steps:** Inspect every picklist, schedule, report, export, notification body, and error message for patient-identifiable content.
**Expect:** SchedulePoint's default is that **no patient-identifiable information enters the scheduling domain**. If case context is ever needed, it is a separately-permissioned, separately-audited, explicitly-scoped feature — never incidental.
**iSched:** OBSERVED that case-level detail (age indicators, procedure descriptions) is present on personal schedule views in the source.
**Decide:** SP-IMP — deliberate divergence. **Impact:** regulatory exposure.
**Sec:** critical (privacy). **Audit:** any access to case context, if the feature exists at all.
**Notify:** never include case detail in notification bodies. **Recover:** n/a. **Open:** none.

---

## 7. Reports, statistics, documents, files (QA-RPT)

Derived from ADM-04 (Credits/Target/Actual), SM-02 (Print/Share controls never activated), RA-12 (five "Create X Report" dialog types found passively), DOC-01/SM-05 (no search; upload/delete exist).

#### QA-RPT-001 · Empty, partial, and zero-row reports
**Class:** SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** High · **Level:** Playwright, Domain · **Auto:** High · **Env:** SEED · **Own:** Reporting · **Dep:** QA-TEN-001
**Refs:** ADM-04 ("No Picks" empty state), five report types · **Ev:** 01-app ADM-04; 09-responsive RA-12
**Risk:** A report with no data renders a blank page, a crash, or misleading zeros indistinguishable from real zeros.
**Pre:** Ranges with no data, partial data, full data. **Data:** sparse fixture.
**Steps:** Generate each report type over each range.
**Expect:** Empty renders an explicit "no data for this range" with the range restated; partial data is labelled as partial; a genuine zero is visually distinct from "not computed."
**iSched:** OBSERVED one empty state ("No Picks"); other report internals UNRESOLVED (never opened).
**Decide:** SP-REQ. **Impact:** decisions on misread data. **Sec:** low. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** report dialog internals (carried forward).

#### QA-RPT-002 · Invalid and inverted date ranges
**Class:** SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** High · **Level:** Unit, API · **Auto:** High · **Env:** SEED · **Own:** Reporting · **Dep:** QA-DATE-001
**Refs:** ADM-04 Start/End Date · **Ev:** 01-app ADM-04
**Risk:** End-before-start, absurdly wide ranges, or malformed dates produce empty results, huge queries, or 500s.
**Pre:** n/a. **Data:** boundary matrix (inverted, equal, 1-day, 10-year, malformed, null).
**Steps:** Submit each combination via UI and API.
**Expect:** Validated with specific messages; inverted ranges rejected (not silently swapped); very wide ranges either rejected or explicitly paginated/queued; malformed input never reaches the query layer.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** confusion; DB load. **Sec:** low (DoS-adjacent).
**Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-RPT-003 · Long-running report generation
**Class:** SP-REQ · **Sev:** Medium · **Pri:** pre-prod · **Like:** Medium · **Level:** Background job, Performance · **Auto:** High · **Env:** PERF · **Own:** Reporting · **Dep:** QA-NOT-010
**Refs:** five report types · **Ev:** 10-technical §8 (whether reports are sync or async is UNRESOLVED)
**Risk:** A large report blocks a request thread, times out at the proxy, and the user retries — multiplying load.
**Pre:** Large dataset. **Data:** `PERF`.
**Steps:** Generate the widest report; observe; retry during generation.
**Expect:** Reports beyond a threshold run as tracked background jobs with visible progress; retrying attaches to the existing job rather than starting a second one (see QA-RPT-004).
**iSched:** UNRESOLVED. **Decide:** SP-IMP. **Impact:** timeouts and retry storms.
**Sec:** low. **Audit:** job lifecycle. **Notify:** notify on completion. **Recover:** resume/re-run. **Open:** none.

#### QA-RPT-004 · Duplicate report-generation requests
**Class:** OBSERVED (pattern) → SP-REQ · **Sev:** Medium · **Pri:** pre-prod · **Like:** High · **Level:** API, Background job, Playwright · **Auto:** High · **Env:** SEED · **Own:** Reporting · **Dep:** QA-PERF-001
**Refs:** report dialogs · **Ev:** 10-technical §10 (the source demonstrably lacks request de-duplication)
**Risk:** Impatient double-clicking spawns N identical expensive jobs.
**Pre:** n/a. **Data:** n/a.
**Steps:** Double-click Generate; submit the identical request twice concurrently.
**Expect:** De-duplicated by (tenant, report type, parameters, requester) within a window; the second request attaches to the first job. Button disables on submit.
**iSched:** OBSERVED the source has no de-dup discipline on reads; report behaviour UNRESOLVED.
**Decide:** SP-REQ. **Impact:** wasted capacity. **Sec:** low (DoS-adjacent). **Audit:** job dedupe decisions.
**Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-RPT-005 · Statistics correctness across timezone and overnight boundaries
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** High · **Level:** Unit, Domain · **Auto:** High · **Env:** SEED · **Own:** Reporting · **Dep:** QA-SCH-004, QA-DATE-002
**Refs:** ADM-04 Credits/Target/Actual · **Ev:** 04-master §3.1 (credit ≠ assignment); 04-master §2 (overnight shift types exist)
**Risk:** An overnight shift is counted on the wrong day, twice, or not at all; credits and actuals disagree silently.
**Pre:** Overnight shifts, DST-boundary shifts, moved credits. **Data:** boundary fixture.
**Steps:** Compute statistics across each boundary; compare against hand-computed expected values.
**Expect:** Every statistic states its basis (credit vs. actual) and its date-attribution rule; totals reconcile exactly; a moved credit is visible as a divergence rather than hidden.
**iSched:** OBSERVED the credit/actual distinction is a real, deliberate data-model feature of the source.
**Decide:** SP-REQ. **Impact:** unfair scheduling driven by wrong fairness data. **Sec:** low.
**Audit:** none. **Notify:** none. **Recover:** recompute. **Open:** none.

#### QA-RPT-006 · Report authorization and cross-tenant retrieval
**Class:** SP-REQ · **Sev:** Critical · **Pri:** pre-prod · **Like:** Medium · **Level:** Authorization, Security · **Auto:** High · **Env:** MULTI · **Own:** Reporting · **Dep:** QA-TEN-008
**Refs:** report artifacts · **Ev:** 02-role §8 (PII broadly visible to elevated roles)
**Risk:** A report containing the full staff roster and contact details is retrievable by a lower-privileged or wrong-tenant user.
**Pre:** Generated reports in two orgs, several roles. **Data:** `MULTI` + role matrix.
**Steps:** Attempt retrieval of each report artifact as each role, and cross-tenant.
**Expect:** Authorization is re-checked at retrieval; artifact URLs are non-guessable and expire; a report never contains data the requester could not see in the UI.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** bulk PII disclosure. **Sec:** critical.
**Audit:** every retrieval. **Notify:** none. **Recover:** revoke artifact. **Open:** none.

#### QA-RPT-007 · Print and export failure handling
**Class:** SP-REQ · **Sev:** Low · **Pri:** post-MVP · **Like:** Medium · **Level:** Playwright, Integration · **Auto:** Med · **Env:** SEED · **Own:** Reporting · **Dep:** QA-RPT-003
**Refs:** SM-02 Print/Share controls · **Ev:** 08-supporting SM-02 (behaviour never activated)
**Risk:** Export fails silently, or a partial/corrupt file is delivered as if complete.
**Pre:** Induced failure mid-generation. **Data:** fault injection.
**Steps:** Trigger export with the generator failing partway.
**Expect:** No partial artifact is delivered; the user sees an explicit failure with a retry; partial files are cleaned up.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** corrupt data circulated. **Sec:** low.
**Audit:** failures logged. **Notify:** requester. **Recover:** retry. **Open:** none.

#### QA-RPT-008 · Invalid, oversized, and malicious file uploads
**Class:** SP-REQ · **Sev:** Critical · **Pri:** pre-beta · **Like:** High · **Level:** Security, Integration · **Auto:** High · **Env:** SEED · **Own:** Documents · **Dep:** none
**Refs:** DOC-01 UpLoad File · **Ev:** 08-supporting SM-05 (no stated size limit observable)
**Risk:** Executable content, zip bombs, oversized files, or path-traversal filenames are accepted.
**Pre:** n/a. **Data:** malicious-fixture set (wrong extension, spoofed MIME, oversized, `../` and unicode-RTL filenames, embedded script in SVG/HTML, EICAR test string).
**Steps:** Attempt upload of each.
**Expect:** Server-side type detection by content (not extension); enforced size limit with a clear message; filenames normalised/sanitised and never used as a filesystem path; malware scanning before availability; text/HTML/SVG never served inline from the app origin.
**iSched:** UNRESOLVED — upload never exercised. **Decide:** SP-REQ.
**Impact:** stored XSS / malware distribution to clinicians. **Sec:** critical.
**Audit:** every upload + scan verdict. **Notify:** alert on rejected malware. **Recover:** quarantine. **Open:** none.

#### QA-RPT-009 · Duplicate uploads and partial upload recovery
**Class:** SP-REQ · **Sev:** Medium · **Pri:** pre-prod · **Like:** Medium · **Level:** Integration, API · **Auto:** High · **Env:** SEED · **Own:** Documents · **Dep:** QA-RPT-008
**Refs:** DOC-01 · **Ev:** 08-supporting SM-05
**Risk:** An interrupted upload leaves an orphaned partial object; re-uploading the same file creates confusing duplicates.
**Pre:** n/a. **Data:** large file + interrupted-connection harness.
**Steps:** 1) Interrupt an upload. 2) Retry. 3) Upload an identical file twice deliberately.
**Expect:** Partial objects are never listed and are garbage-collected; retry is idempotent by content hash; deliberate duplicates are permitted but flagged as identical.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** storage waste, user confusion.
**Sec:** low. **Audit:** upload lifecycle. **Notify:** none. **Recover:** GC job. **Open:** none.

#### QA-RPT-010 · Cross-tenant and unauthorized document download
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Authorization, Security · **Auto:** High · **Env:** MULTI · **Own:** Documents · **Dep:** QA-TEN-006
**Refs:** DOC-01 categories (incl. financial/billing categories) · **Ev:** 08-supporting SM-05 (role-based category access UNRESOLVED)
**Risk:** A document id or storage URL grants access without an authorization check.
**Pre:** Documents in two orgs, restricted categories. **Data:** `MULTI`.
**Steps:** 1) Request another tenant's document id. 2) Request a restricted category's document as a basic role. 3) Test whether a storage URL works without a session.
**Expect:** Every download is authorization-checked per request; storage URLs are short-lived, signed, and never long-lived public links.
**iSched:** UNRESOLVED — deliberately never tested. **Decide:** SP-REQ.
**Impact:** disclosure of financial/clinical documents. **Sec:** critical.
**Audit:** every download with actor. **Notify:** none. **Recover:** rotate URLs. **Open:** category-level role access.

#### QA-RPT-011 · Retention, deletion, and orphaned files
**Class:** SP-REQ · **Sev:** Medium · **Pri:** post-MVP · **Like:** Medium · **Level:** Background job, Database · **Auto:** High · **Env:** SEED · **Own:** Documents · **Dep:** QA-RPT-009
**Refs:** DOC-01 Delete · **Ev:** 08-supporting SM-05 (no provenance beyond Upload Date; no versioning)
**Risk:** Deleting a record leaves the blob behind (or vice versa), and no retention policy ever removes stale artifacts.
**Pre:** Documents + generated report artifacts. **Data:** retention fixture.
**Steps:** 1) Delete a document. 2) Assert blob removal. 3) Age artifacts past retention. 4) Run GC.
**Expect:** Metadata and blob lifecycles are consistent; retention is configurable and enforced by a job; deletion is audited with actor and is soft where legally required.
**iSched:** UNRESOLVED. **Decide:** SP-IMP — add the provenance and retention the source lacks.
**Impact:** indefinite retention of sensitive files. **Sec:** high (privacy). **Audit:** deletion + GC.
**Notify:** none. **Recover:** restore within a grace window. **Open:** none.

#### QA-RPT-012 · Document search and listing at scale
**Class:** OBSERVED → SP-IMP · **Sev:** Low · **Pri:** post-MVP · **Like:** Medium · **Level:** Playwright, Performance · **Auto:** High · **Env:** PERF · **Own:** Documents · **Dep:** none
**Refs:** DOC-01 · **Ev:** 08-supporting SM-05 (**no search or filter exists anywhere** on the source's Documents screen — confirmed by full interactive-element read)
**Risk:** With hundreds of files across many categories, users cannot find anything.
**Pre:** Many documents. **Data:** `PERF` fixture.
**Steps:** Search by name, type, date, uploader; page through a large category.
**Expect:** Search and filter exist and are performant; results are tenant- and permission-scoped.
**iSched:** OBSERVED — the source has category navigation only, no search at all.
**Decide:** SP-IMP. **Impact:** unusable document library at scale. **Sec:** low (scoping still required).
**Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

---

## 8. Notifications and background jobs (QA-NOT)

Derived from PL-02/ADM-01 (two-tier escalation ladders, four channels), ADM-05 (`Admin Emails`, `Notification Locked`), and the confirmed absence of any delivery-status surface (07-picklist §3).

#### QA-NOT-001 · Channel delivery failure per channel
**Class:** UNRESOLVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Integration, Background job · **Auto:** High · **Env:** SEED · **Own:** Notifications · **Dep:** none
**Refs:** PL-02 channels (Email, SMS, Dial Mobile, Dial Home) · **Ev:** 07-picklist §3 (no delivery log exists anywhere in the source)
**Risk:** A channel fails silently and the escalation ladder proceeds as if it succeeded.
**Pre:** Provider stubs per channel. **Data:** induced failures (hard bounce, soft bounce, timeout, rejection).
**Steps:** Trigger a notification with each channel failing in each mode.
**Expect:** Per-channel outcome is recorded (queued/sent/delivered/failed + reason); a hard failure escalates immediately to the next channel rather than waiting out the full ladder interval.
**iSched:** UNRESOLVED. **Decide:** SP-IMP — add delivery observability the source entirely lacks.
**Impact:** clinician never reached; shift missed. **Sec:** low.
**Audit:** per-attempt record. **Notify:** alert scheduler on total failure. **Recover:** manual contact. **Open:** #53.

#### QA-NOT-002 · Missing or invalid contact details
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Domain, Integration · **Auto:** High · **Env:** SEED · **Own:** Notifications · **Dep:** QA-PICK-004
**Refs:** ADM-05 (rows with no phone), PL-03 · **Ev:** 07-picklist §3
**Risk:** A channel is enabled with no destination; the system either errors or silently drops.
**Pre:** Users missing each contact type; also malformed values. **Data:** contact matrix.
**Steps:** Enable each channel for each user; trigger.
**Expect:** Configuration-time warning that a channel has no destination; send-time skip recorded with reason; malformed values rejected at entry with validation.
**iSched:** OBSERVED contactless accounts exist and no configuration-time warning was visible.
**Decide:** SP-IMP. **Impact:** silent non-delivery. **Sec:** low. **Audit:** skip reasons.
**Notify:** prompt the user to complete their profile. **Recover:** update contact. **Open:** none.

#### QA-NOT-003 · Duplicate notification suppression
**Class:** UNRESOLVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Background job, Integration · **Auto:** High · **Env:** SEED · **Own:** Notifications · **Dep:** QA-CON-006
**Refs:** escalation ladder · **Ev:** 07-picklist §3 (duplicate protection UNRESOLVED)
**Risk:** Retries, job re-runs, or two ladder steps firing together spam a clinician at 3am.
**Pre:** n/a. **Data:** retry harness.
**Steps:** 1) Force job retry after a partial send. 2) Fire two ladder steps concurrently. 3) Re-run a completed job.
**Expect:** Deduplicated by (recipient, event, channel, window) with an idempotency key; a retry never re-sends an already-delivered message.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** alert fatigue, out-of-hours disturbance, trust loss.
**Sec:** low. **Audit:** dedupe decisions. **Notify:** n/a. **Recover:** n/a. **Open:** #53.

#### QA-NOT-004 · Retry storm containment
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** Medium · **Level:** Background job, Performance · **Auto:** High · **Env:** PERF · **Own:** Notifications · **Dep:** QA-NOT-003
**Refs:** escalation ladder + `Alert Pick Time` · **Ev:** 01-app ADM-01
**Risk:** A provider outage causes unbounded retries that compound when the provider recovers.
**Pre:** Provider down then recovering. **Data:** `PERF`.
**Steps:** Fail the provider for a sustained window with many pending notifications; then restore.
**Expect:** Exponential backoff with jitter, a bounded attempt count, a circuit breaker, and a dead-letter queue. On recovery, delivery is rate-limited and time-expired notifications are dropped rather than delivered late and confusingly.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** provider ban, mass late alerts. **Sec:** low.
**Audit:** breaker state changes. **Notify:** ops alert. **Recover:** replay from DLQ. **Open:** none.

#### QA-NOT-005 · Partial recipient failure in a batch
**Class:** SP-REQ · **Sev:** Medium · **Pri:** pre-prod · **Like:** High · **Level:** Background job · **Auto:** High · **Env:** SEED · **Own:** Notifications · **Dep:** QA-NOT-001
**Refs:** ADM-01 `Final Picklist Emails`, CON-01 bulk send · **Ev:** 01-app ADM-01
**Risk:** One bad address aborts the whole batch, or the batch reports success while some recipients failed.
**Pre:** Batch containing valid and invalid recipients. **Data:** mixed fixture.
**Steps:** Send to the mixed batch.
**Expect:** Per-recipient outcomes; valid recipients still receive; the sender sees an explicit per-recipient summary; failures are individually retryable.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** silent partial delivery. **Sec:** low.
**Audit:** per recipient. **Notify:** sender summary. **Recover:** retry failures only. **Open:** none.

#### QA-NOT-006 · Delivery to inactive users or the wrong tenant
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Authorization, Background job · **Auto:** High · **Env:** MULTI · **Own:** Notifications · **Dep:** QA-TEN-010
**Refs:** ADM-05 · **Ev:** 02-role §5
**Risk:** A departed clinician keeps receiving schedules; or a notification is addressed using another tenant's data.
**Pre:** Deactivated user with pending notifications; two orgs. **Data:** `MULTI`.
**Steps:** 1) Deactivate then trigger. 2) Trigger a batch in Org A and assert no Org B recipient appears.
**Expect:** Recipient list is resolved at send time (not at enqueue time) and filtered by active membership in the correct tenant.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** data leaves the organization. **Sec:** critical.
**Audit:** recipient resolution. **Notify:** n/a. **Recover:** n/a. **Open:** none.

#### QA-NOT-007 · Stale notification content
**Class:** SP-REQ · **Sev:** Medium · **Pri:** pre-prod · **Like:** High · **Level:** Background job, Domain · **Auto:** High · **Env:** SEED · **Own:** Notifications · **Dep:** QA-SCH-011
**Refs:** publication + amendment flows · **Ev:** 04-master §8
**Risk:** A queued notification describes a schedule that changed before the message was sent.
**Pre:** Queued notification; underlying data then amended. **Data:** delay harness.
**Steps:** 1) Enqueue. 2) Amend the schedule. 3) Let the job run.
**Expect:** Content is rendered at send time from current data, or the message is invalidated and replaced. It never asserts stale facts as current; where relevant it states "as of <timestamp>."
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** clinician acts on outdated information.
**Sec:** low. **Audit:** content version. **Notify:** n/a. **Recover:** send correction. **Open:** none.

#### QA-NOT-008 · Escalation ladder correctness across the personal/mandatory boundary
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Unit, Domain, Background job · **Auto:** High · **Env:** SEED · **Own:** Notifications · **Dep:** QA-DATE-004
**Refs:** PL-02 (Mandatory vs Personal ladders, offsets 0/30/60, per-channel toggles), ADM-01 group defaults · **Ev:** 07-picklist §3; 01-app PL-02
**Risk:** A notification crossing the personal-hours boundary mid-ladder switches rules inconsistently, or calls a clinician's home at 2am.
**Pre:** Ladders configured; trigger timed to cross the boundary. **Data:** boundary matrix incl. DST transitions.
**Steps:** Trigger just before, exactly at, and just after the boundary; let the ladder run across it.
**Expect:** The applicable ladder is chosen by an explicit, documented rule (evaluated once at trigger, or re-evaluated per step — documented either way); no step ever uses a channel disabled for the then-current window. User-level settings override group defaults deterministically.
**iSched:** OBSERVED both ladders and the override affordance ("Load Defaults"); override mechanics INFERRED, boundary behaviour UNRESOLVED.
**Decide:** SP-REQ. **Impact:** out-of-hours disturbance or missed urgent contact. **Sec:** low.
**Audit:** which ladder and step fired. **Notify:** n/a. **Recover:** n/a. **Open:** none.

#### QA-NOT-009 · Notification succeeds but the underlying transaction fails
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Integration, Database · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** QA-SCH-010, QA-CON-010
**Refs:** all notify-on-change flows · **Ev:** derived from 04-master §8 + 07-picklist §5
**Risk:** Staff are told a schedule changed when the change was rolled back — the inverse of QA-SCH-010 and equally damaging.
**Pre:** Fault injection after notification dispatch, before commit. **Data:** fault harness.
**Steps:** Force commit failure after the notification is enqueued/sent.
**Expect:** Notifications are dispatched only via a transactional outbox — enqueued inside the transaction, sent only after commit. A rolled-back transaction sends nothing.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** false schedule information distributed.
**Sec:** low. **Audit:** outbox records. **Notify:** correction if it ever escapes. **Recover:** correction message. **Open:** none.

#### QA-NOT-010 · Jobs running twice or never running
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Background job, Concurrency · **Auto:** High · **Env:** SEED, CONC · **Own:** Platform · **Dep:** QA-CON-006
**Refs:** API-03/04 "jobs" resource · **Ev:** 10-technical §8 (job semantics UNRESOLVED, #78)
**Risk:** Two workers process the same job (double notification, double sync) or a job is silently lost.
**Pre:** Multiple workers. **Data:** `CONC`.
**Steps:** 1) Run duplicate workers against one queue. 2) Kill a worker mid-job. 3) Assert eventual exactly-once effect.
**Expect:** At-least-once delivery with idempotent handlers producing exactly-once *effects*; visibility timeouts prevent double-processing; crashed jobs are redelivered, not lost; every job is observable (queued/running/succeeded/failed/dead-lettered).
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** duplicated or missing critical work.
**Sec:** low. **Audit:** full job lifecycle + correlation id. **Notify:** ops on DLQ. **Recover:** replay. **Open:** #78.

#### QA-NOT-011 · Dead-letter handling and operational visibility
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** Medium · **Level:** Background job, Manual exploratory · **Auto:** Med · **Env:** SEED · **Own:** Platform · **Dep:** QA-NOT-010
**Refs:** all async work · **Ev:** 07-picklist §3 (no failure surface exists in the source)
**Risk:** Failures accumulate invisibly; nobody knows notifications stopped.
**Pre:** Poison messages. **Data:** DLQ fixture.
**Steps:** Force repeated failures; inspect operator tooling; replay after fixing.
**Expect:** A DLQ exists with searchable reasons; an operator can inspect, correct, and replay; alerting fires on DLQ growth; replay is idempotent.
**iSched:** UNRESOLVED. **Decide:** SP-IMP. **Impact:** silent systemic failure — precisely the class of problem the source's missing delivery log would hide.
**Sec:** low. **Audit:** DLQ actions. **Notify:** ops. **Recover:** replay. **Open:** none.

#### QA-NOT-012 · Notification suppression flags honoured
**Class:** OBSERVED → SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** Medium · **Level:** Domain, Authorization · **Auto:** High · **Env:** SEED · **Own:** Notifications · **Dep:** QA-AUTH-007
**Refs:** ADM-05 `Notification Locked`, `Admin Emails`; PL-02 per-user ladder · **Ev:** 02-role §5
**Risk:** An admin-set suppression is ignored by one code path, or a user edits settings an admin locked.
**Pre:** Users with each flag combination. **Data:** flag matrix.
**Steps:** 1) Attempt to edit locked notification settings as the user. 2) Trigger notifications for each flag state.
**Expect:** Locked settings are read-only for the user and enforced server-side; `Admin Emails` gates exactly the defined admin message set and nothing else.
**iSched:** OBSERVED both flags exist; their effects were never confirmed (#11, #21).
**Decide:** SP-REQ (with QA-AUTH-007's "no vestigial flags" rule). **Impact:** unwanted or missing notifications.
**Sec:** low. **Audit:** flag changes. **Notify:** n/a. **Recover:** n/a. **Open:** #11, #21.

---

## 9. Dates, time zones, calendars (QA-DATE)

Derived from the confirmed three-format API inconsistency (10-technical §4), overnight shift types, `ALL+HOLIDAYS` rule scoping, and the webcal feed.

#### QA-DATE-001 · One canonical date/time representation
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** MVP-blocker · **Like:** High · **Level:** Unit, API, Database · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** none
**Refs:** API-05/06/07/12 · **Ev:** 10-technical §4 (**three** date formats observed across sibling endpoints in one session: ISO, `MM/DD/YYYY`, and `MMM D, YYYY`)
**Risk:** Format drift causes `03/04` to be parsed as 3 April in one endpoint and 4 March in another — a silent, high-consequence scheduling error.
**Pre:** n/a. **Data:** ambiguous dates (e.g. day ≤ 12), locale-varied inputs.
**Steps:** Round-trip dates through every endpoint and every UI surface; assert identical interpretation.
**Expect:** ISO 8601 everywhere on the wire and in storage; a calendar *date* type distinct from an *instant*; locale formatting only at the presentation edge.
**iSched:** OBSERVED — three coexisting formats confirmed. This is a concrete, real-world defect class.
**Decide:** SP-IMP — deliberate, enforced divergence. **Impact:** wrong-day assignments.
**Sec:** low. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** #77 (whether responses also differ).

#### QA-DATE-002 · Daylight-saving gap and repeated hour
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Unit, Domain · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** QA-DATE-001, QA-SCH-004
**Refs:** shift windows, rest calculations, escalation offsets · **Ev:** 04-master §2 (overnight windows exist); 07-picklist §3 (time-offset ladders)
**Risk:** A shift starting in a non-existent local hour (spring gap) or an ambiguous repeated hour (autumn) mis-computes duration, rest, or notification timing.
**Pre:** Org in a DST-observing zone. **Data:** DST transition dates for both directions.
**Steps:** Create shifts spanning each transition; compute duration, rest, credits, and ladder timings; render on the calendar and in the feed.
**Expect:** Documented, tested behaviour for both cases; durations reflect real elapsed time; no shift silently vanishes or doubles; notification offsets are computed on absolute time.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** wrong hours worked, missed or duplicated alerts.
**Sec:** low. **Audit:** none. **Notify:** none. **Recover:** recompute. **Open:** none.

#### QA-DATE-003 · Leap day, month-end, and year-end
**Class:** SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** Medium · **Level:** Unit, Domain · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** QA-DATE-001
**Refs:** recurring patterns, Build periods (~166–182 days), vacation blocks · **Ev:** 05-engine §3
**Risk:** A recurring rule anchored to the 29th/30th/31st misfires; a period crossing year-end mis-buckets statistics.
**Pre:** n/a. **Data:** Feb 29, month-ends, Dec 31→Jan 1, ISO week 53 years.
**Steps:** Generate schedules and statistics across each boundary.
**Expect:** Explicit documented rule for month-end recurrence; year-end crossing never splits or double-counts a shift; ISO week numbering handled correctly where weeks are used (vacation blocks are week-based).
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** missing or duplicated assignments at boundaries.
**Sec:** low. **Audit:** none. **Notify:** none. **Recover:** recompute. **Open:** none.

#### QA-DATE-004 · Browser timezone differs from organization timezone
**Class:** SP-REQ · **Sev:** High · **Pri:** MVP-blocker · **Like:** High · **Level:** Unit, Playwright · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** QA-DATE-001
**Refs:** all schedule displays, deadlines, ladders · **Ev:** 10-technical §6 (no timezone identifier appeared in any request; dates appear timezone-naive)
**Risk:** A clinician travelling or working remotely sees shifts shifted by hours, or a deadline expires at the wrong local moment.
**Pre:** Org zone fixed; browser set to several other zones incl. across the date line. **Data:** zone matrix.
**Steps:** View schedules, deadlines, and the calendar feed from each browser zone.
**Expect:** Schedule dates render in the **organization's** timezone consistently (a shift is a facility fact, not a viewer fact), with the zone stated explicitly; deadlines state their zone; no silent local-time reinterpretation.
**iSched:** OBSERVED no timezone data on the wire — INFERRED timezone-naive handling, which is workable only if one zone is assumed.
**Decide:** SP-REQ — make the zone explicit rather than assumed. **Impact:** missed shifts.
**Sec:** low. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-DATE-005 · Request deadline at midnight boundary
**Class:** SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** High · **Level:** Unit, API · **Auto:** High · **Env:** SEED · **Own:** Requests · **Dep:** QA-REQ-001, QA-DATE-004
**Refs:** ADM-01 `Request Until Date` · **Ev:** 01-app ADM-01
**Risk:** "Until 18 December" is ambiguous — start or end of that day, in whose timezone.
**Pre:** Deadline configured. **Data:** submissions at 23:59:59, 00:00:00, and 00:00:01 in several zones.
**Steps:** Submit at each instant.
**Expect:** Inclusivity and timezone are explicitly defined, displayed to users ("closes 18 Dec 23:59 <zone>"), and enforced identically on client and server.
**iSched:** OBSERVED the deadline is displayed as a bare date with no time or zone.
**Decide:** SP-IMP. **Impact:** disputed rejections. **Sec:** low. **Audit:** boundary rejections. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-DATE-006 · Holiday calendar correctness
**Class:** INFERRED → SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** Medium · **Level:** Domain, Unit · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** QA-REQ-012
**Refs:** ADM-10 `ALL+HOLIDAYS`, ADM-01 OR Daily Defaults (Holidays column), ADM-03 `Hol` quota · **Ev:** 04-master §5 (**no dedicated holiday-management screen was ever found** — holidays appear baked into the day-type model)
**Risk:** Holidays cannot be maintained per organization or per year, so rules referencing holidays silently use a wrong or stale set.
**Pre:** Holiday set configured. **Data:** moving holidays, region-specific holidays, a year rollover.
**Steps:** Assert holiday-scoped rules, quotas, and OR defaults apply on exactly the configured days across a year boundary.
**Expect:** Holidays are first-class, per-organization, per-year manageable data with an admin surface; every holiday-scoped rule resolves against it.
**iSched:** INFERRED — holidays are referenced by three separate features but no management screen exists in the observable surface.
**Decide:** SP-IMP — add the missing management surface. **Impact:** wrong staffing on holidays.
**Sec:** low. **Audit:** holiday-set changes. **Notify:** none. **Recover:** correct and recompute. **Open:** none.

#### QA-DATE-007 · Calendar feed content, timezone, and all-day semantics
**Class:** INFERRED → SP-REQ · **Sev:** Medium · **Pri:** pre-prod · **Like:** High · **Level:** Integration, Unit · **Auto:** High · **Env:** SEED · **Own:** Integrations · **Dep:** QA-DATE-004
**Refs:** WF-23 webcal feed, PL-03 "Calendar days to keep" · **Ev:** 03-user WF-23; 10-technical §9 (iCalendar format INFERRED, never fetched)
**Risk:** Feed events land on the wrong day in the subscriber's client, or overnight shifts render as all-day.
**Pre:** Feed subscribed. **Data:** overnight, DST-crossing, all-day, and vacation entries.
**Steps:** Validate the feed against the iCalendar spec; subscribe from clients in several zones.
**Expect:** Spec-valid output; timed events carry explicit zone information; genuine all-day entries (e.g. vacation) use date-only values; overnight shifts are single events spanning midnight, not two.
**iSched:** INFERRED format only — the feed was deliberately never fetched. **Decide:** SP-REQ.
**Impact:** clinicians trust a wrong calendar. **Sec:** medium (feed contains schedule PII).
**Audit:** coarse fetch logging. **Notify:** none. **Recover:** resubscribe. **Open:** feed format unverified.

#### QA-DATE-008 · Feed token rotation and revocation
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** Medium · **Level:** Security, Integration · **Auto:** High · **Env:** SEED · **Own:** Integrations · **Dep:** QA-SEC-009, QA-TEN-009
**Refs:** WF-23 (long-lived bearer token in the URL, no password re-entry) · **Ev:** 03-user WF-23
**Risk:** A leaked feed URL grants indefinite access to a clinician's schedule; there is no way to revoke it.
**Pre:** Active feed. **Data:** token fixture.
**Steps:** 1) Rotate the token. 2) Assert the old URL fails. 3) Revoke entirely. 4) Assert failure. 5) Confirm rotation does not require a password change.
**Expect:** Self-service rotation and revocation; old tokens immediately invalid; feed access is independently revocable from the login credential.
**iSched:** OBSERVED the token exists and is embedded in a shareable URL alongside the user's email; rotation/revocation UNRESOLVED (#35).
**Decide:** SP-REQ. **Impact:** persistent unauthorised schedule access. **Sec:** high.
**Audit:** rotation/revocation events. **Notify:** notify the user on rotation. **Recover:** rotate. **Open:** #35.

#### QA-DATE-009 · Stale calendar subscription after membership or retention change
**Class:** OBSERVED → SP-REQ · **Sev:** Medium · **Pri:** post-MVP · **Like:** Medium · **Level:** Integration · **Auto:** High · **Env:** MULTI · **Own:** Integrations · **Dep:** QA-TEN-009
**Refs:** PL-03 "Calendar days to keep" · **Ev:** 01-app PL-03
**Risk:** A subscriber's client keeps showing shifts after they leave the org, or the retention setting is ignored by the feed.
**Pre:** Feed with retention configured. **Data:** retention + membership fixtures.
**Steps:** 1) Change retention. 2) Re-fetch. 3) Remove membership. 4) Re-fetch.
**Expect:** Retention is honoured in feed output; removal of membership empties/invalidates the feed promptly; cache headers keep clients reasonably fresh.
**iSched:** OBSERVED the retention setting exists; feed behaviour UNRESOLVED.
**Decide:** SP-REQ. **Impact:** ex-member retains visibility. **Sec:** high. **Audit:** none. **Notify:** none. **Recover:** revoke. **Open:** none.

#### QA-DATE-010 · Recurring pattern rules across boundaries
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** Medium · **Level:** Domain, Unit · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** QA-DATE-003
**Refs:** ADM-10 (day-offset spacing rules e.g. `(-7)`, `(7)`, `(8)`; weekday scoping `SA/SU/H`) · **Ev:** 01-app ADM-10; 05-engine §1
**Risk:** A ±N-day spacing rule computed across a DST change, month end, or the edge of the build window silently fails to apply.
**Pre:** Rules with several offsets. **Data:** boundary-spanning fixtures.
**Steps:** Generate schedules where each rule's offset window crosses a boundary or extends beyond the build period.
**Expect:** Offsets are computed in calendar days consistently; rules whose window extends outside the build period consult adjacent published data rather than silently treating it as empty.
**iSched:** OBSERVED the rule language and offsets; runtime behaviour never observed (no build was ever run).
**Decide:** SP-REQ. **Impact:** spacing violations at period edges — a likely real-world failure mode. **Sec:** low.
**Audit:** rule evaluation trace. **Notify:** none. **Recover:** regenerate. **Open:** none.

#### QA-DATE-011 · Build period boundary continuity
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** Medium · **Level:** Domain, Integration · **Auto:** High · **Env:** SEED · **Own:** Scheduling · **Dep:** QA-DATE-010
**Refs:** ADM-02 (Build Start must be Monday, End must be Sunday; `Use Previous Schedule Statistics` with an explicit non-overlap warning) · **Ev:** 05-engine §1
**Risk:** Overlapping or gapped statistics windows double-count or lose fairness history between consecutive periods.
**Pre:** Two consecutive build periods. **Data:** adjacent, overlapping, and gapped configurations.
**Steps:** Configure each and generate; compare carried-forward statistics against expected.
**Expect:** Overlap is rejected (the source only warns); a gap is detected and reported; fairness continuity across periods is exact and verifiable.
**iSched:** OBSERVED the explicit warning text "Do NOT overlap dates" — a rule the source states but does not appear to enforce.
**Decide:** SP-IMP — enforce what the source merely advises. **Impact:** cumulatively unfair schedules.
**Sec:** low. **Audit:** period config. **Notify:** none. **Recover:** reconfigure + regenerate. **Open:** none.

---

## 10. Concurrency, idempotency, recovery (QA-CON)

#### QA-CON-001 · Optimistic concurrency on every mutable entity
**Class:** INFERRED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Domain, Database, Concurrency · **Auto:** High · **Env:** CONC · **Own:** Platform · **Dep:** none
**Refs:** all editable entities · **Ev:** 04-master §8 (immediate per-action commit inferred, no conflict UI observed)
**Risk:** Last-write-wins silently discards a colleague's change.
**Pre:** Two sessions on one entity. **Data:** `CONC`.
**Steps:** For each mutable entity type: both load, both edit, both save.
**Expect:** Version/etag checked at write; the loser receives a conflict response identifying what changed and by whom, and must re-apply deliberately.
**iSched:** UNRESOLVED — never tested. **Decide:** SP-REQ.
**Impact:** silent loss of scheduling work. **Sec:** low. **Audit:** conflicts logged. **Notify:** none. **Recover:** re-apply. **Open:** none.

#### QA-CON-002 · Serialisation of period-scoped operations
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Concurrency, Background job · **Auto:** High · **Env:** CONC · **Own:** Scheduling · **Dep:** QA-SCH-009
**Refs:** ADM-02 pipeline stages · **Ev:** 05-engine §1
**Risk:** Build, publish, and vacation-transfer run concurrently over the same period and interleave.
**Pre:** One period. **Data:** `CONC`.
**Steps:** Launch each pair of operations simultaneously over the same period.
**Expect:** A period-scoped lock serialises them; conflicting operations are rejected with "another operation is in progress," naming it and its owner.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** corrupted schedule. **Sec:** low.
**Audit:** lock acquisition/denial. **Notify:** none. **Recover:** retry after release. **Open:** none.

#### QA-CON-003 · Idempotency keys on all mutating APIs
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** API, Concurrency · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** none
**Refs:** all mutating endpoints · **Ev:** 10-technical §8 (no dedupe discipline observed anywhere in the source)
**Risk:** Network retries and double-submits create duplicate records.
**Pre:** n/a. **Data:** n/a.
**Steps:** Replay each mutating request with the same key; with a new key; concurrently with the same key.
**Expect:** Same key returns the original result with no additional side effect (including concurrently); new key creates anew; keys expire after a documented window.
**iSched:** UNRESOLVED for mutations. **Decide:** SP-REQ.
**Impact:** duplicate assignments, requests, notifications. **Sec:** low. **Audit:** dedupe hits. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-CON-004 · Atomic contention on a single scarce resource
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Concurrency, Database · **Auto:** High · **Env:** CONC · **Own:** Platform · **Dep:** QA-CON-003
**Refs:** QA-OPP-001, QA-PICK-005, QA-REQ-008 (the three scarce-resource races in the product) · **Ev:** 06-requests LC-03; 07-picklist §4
**Risk:** Check-then-act races award one resource twice.
**Pre:** One scarce unit; N concurrent claimants. **Data:** `CONC` with N=2, 10, 50.
**Steps:** Fire N simultaneous claims for each scarce-resource type.
**Expect:** Exactly one success at every N; losers get an accurate, immediate rejection. Enforced by an atomic conditional write or a unique constraint — never an application-level pre-check.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** the highest-consequence correctness class in the product.
**Sec:** low. **Audit:** all attempts. **Notify:** accurate outcomes to all. **Recover:** n/a. **Open:** none.

#### QA-CON-005 · Double-click and duplicate form submission
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Playwright, Component · **Auto:** High · **Env:** SEED · **Own:** Frontend · **Dep:** QA-CON-003
**Refs:** every submit control · **Ev:** 07-picklist §0 (a single click already commits in at least one place — so double-clicks are a live risk)
**Risk:** Impatient double-clicks create two records.
**Pre:** n/a. **Data:** n/a.
**Steps:** Double- and triple-click every submit; submit via Enter while a click is in flight.
**Expect:** The control disables on first activation and shows progress; the request carries an idempotency key; the UI never permits a second in-flight submission of the same form.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** duplicates. **Sec:** low. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-CON-006 · Lost response after a committed transaction
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** Medium · **Level:** API, Integration · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** QA-CON-003
**Refs:** all mutations · **Ev:** derived
**Risk:** The server commits but the response is lost; the client retries and duplicates the effect.
**Pre:** n/a. **Data:** response-dropping proxy.
**Steps:** Drop the response after commit; let the client retry.
**Expect:** The retry (same idempotency key) returns the original committed result; the user sees one success, not an error followed by a duplicate.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** duplicates or false failure reports.
**Sec:** low. **Audit:** replay detection. **Notify:** none. **Recover:** automatic. **Open:** none.

#### QA-CON-007 · Multiple tabs acting on one entity
**Class:** OBSERVED → SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** High · **Level:** Playwright, Concurrency · **Auto:** High · **Env:** CONC · **Own:** Frontend · **Dep:** QA-CON-001, QA-TEN-004
**Refs:** WF-03, all editors · **Ev:** 03-user WF-01 (tabs share one session)
**Risk:** Two tabs hold divergent views; the stale one overwrites the fresh one.
**Pre:** Two tabs, same entity. **Data:** `CONC`.
**Steps:** Edit in tab A, save; then save the stale form in tab B.
**Expect:** Tab B's save is rejected as a conflict; ideally tabs synchronise via a broadcast channel so B refreshes proactively.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** lost edits. **Sec:** low.
**Audit:** conflicts. **Notify:** none. **Recover:** re-apply. **Open:** none.

#### QA-CON-008 · Concurrent archive/delete versus in-flight use
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** Medium · **Level:** Concurrency, Domain · **Auto:** High · **Env:** CONC · **Own:** Platform · **Dep:** QA-SCH-013
**Refs:** ADM-05/07 Remove, DOC-01 Delete · **Ev:** 01-app ADM-05/ADM-07
**Risk:** An entity is deleted while another session is mid-operation on it, producing a dangling reference.
**Pre:** Two sessions. **Data:** `CONC`.
**Steps:** Session A opens an entity for edit; session B archives it; A saves.
**Expect:** A's save is rejected with "this item was archived by <actor>"; no dangling reference is written; archived entities remain referentially intact for history.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** broken references. **Sec:** low.
**Audit:** both. **Notify:** none. **Recover:** unarchive. **Open:** none.

#### QA-CON-009 · Background-job retry safety for schedule-affecting work
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Background job, Concurrency · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** QA-NOT-010
**Refs:** build, publish, vacation transfer, picklist sync · **Ev:** 06-requests LC-01b; 07-picklist §5
**Risk:** A retried job re-applies a bulk write, duplicating entries — most dangerous for the vacation transfer, which the source itself calls irreversible.
**Pre:** Jobs failing after partial completion. **Data:** fault harness.
**Steps:** Fail each bulk job at 50% and retry.
**Expect:** Jobs are resumable or fully idempotent; a retry converges to the same end state as a single clean run — never double-applies.
**iSched:** UNRESOLVED (#45). **Decide:** SP-REQ. **Impact:** duplicated bulk schedule data.
**Sec:** low. **Audit:** attempt + convergence. **Notify:** ops on repeated failure. **Recover:** resume. **Open:** #45.

#### QA-CON-010 · Partial transaction across aggregate boundaries
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Database, Domain · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** QA-OPP-011
**Refs:** swaps, transfers, publish+notify, picklist sync · **Ev:** derived
**Risk:** Multi-step operations leave the system half-changed.
**Pre:** n/a. **Data:** fault injection at each step boundary.
**Steps:** Fail each multi-step operation at each internal boundary.
**Expect:** Either full atomicity, or an explicit saga with compensating actions and a visible, self-healing intermediate state. No silent half-state ever persists.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** the hardest bugs to detect and explain.
**Sec:** low. **Audit:** step-level. **Notify:** ops. **Recover:** compensate/resume. **Open:** none.

#### QA-CON-011 · Optimistic-lock failure surfaced usefully to humans
**Class:** SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** High · **Level:** Playwright, Accessibility · **Auto:** High · **Env:** CONC · **Own:** Frontend · **Dep:** QA-CON-001, QA-A11Y-013
**Refs:** all editors · **Ev:** derived
**Risk:** A conflict surfaces as a raw 409 or a generic error the user cannot act on.
**Pre:** Forced conflict. **Data:** `CONC`.
**Steps:** Trigger a conflict; inspect the message, the diff shown, and the recovery path — including via screen reader.
**Expect:** Plain-language explanation naming who changed what and when, a visible comparison, and a one-click way to reload-and-reapply without retyping. The message is announced assistively.
**iSched:** UNRESOLVED. **Decide:** SP-IMP. **Impact:** users abandon or blindly overwrite.
**Sec:** low. **Audit:** none. **Notify:** none. **Recover:** guided. **Open:** none.

#### QA-CON-012 · Dependency outage degradation (DB, cache, worker, provider, storage)
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** Medium · **Level:** Integration, Disaster recovery · **Auto:** Med · **Env:** DR · **Own:** Platform · **Dep:** QA-NOT-004
**Refs:** whole system · **Ev:** 10-technical §12 (a third-party dependency has been silently 503-ing on every page load — a live example of unnoticed degradation)
**Risk:** One dependency failing takes the whole product down, or fails invisibly.
**Pre:** Each dependency independently disabled. **Data:** `DR`.
**Steps:** Disable each in turn; exercise core read and write paths; restore.
**Expect:** Cache outage degrades to direct reads; worker outage queues work and says so; provider outage degrades notifications only; storage outage blocks uploads only. Every degradation is visible to users and to ops — never silent.
**iSched:** OBSERVED a silently-broken third-party widget across the entire research period — direct evidence of the failure mode this case guards against.
**Decide:** SP-IMP. **Impact:** total outage or invisible partial failure. **Sec:** low.
**Audit:** degradation events. **Notify:** ops + user-facing banner. **Recover:** automatic on restore. **Open:** none.

#### QA-CON-013 · Failed migration and rollback
**Class:** SP-REQ · **Sev:** Critical · **Pri:** pre-prod · **Like:** Low · **Level:** Database, Disaster recovery · **Auto:** High · **Env:** DR · **Own:** Platform · **Dep:** none
**Refs:** whole system · **Ev:** derived
**Risk:** A half-applied migration corrupts data or wedges a deploy.
**Pre:** Migration set incl. a deliberately failing one. **Data:** production-shaped volume.
**Steps:** Run migrations against realistic data; fail one mid-way; roll back; re-apply.
**Expect:** Migrations are transactional where the engine allows, forward-only with explicit compatibility windows, tested at realistic volume, and rehearsed against a production-shaped restore before release.
**iSched:** n/a — out of scope for external observation. **Decide:** SP-REQ.
**Impact:** data corruption. **Sec:** high. **Audit:** migration ledger. **Notify:** ops. **Recover:** restore + replay. **Open:** none.

#### QA-CON-014 · Backup restoration and data reconciliation
**Class:** SP-REQ · **Sev:** Critical · **Pri:** pre-prod · **Like:** Low · **Level:** Disaster recovery, Manual exploratory · **Auto:** Low (rehearsed) · **Env:** DR · **Own:** Platform · **Dep:** QA-CON-013
**Refs:** whole system · **Ev:** derived from QA-SCH-016 (destructive bulk actions exist and at least one is labelled irreversible)
**Risk:** After an erroneous mass action, there is no tested path back.
**Pre:** Backups configured. **Data:** `DR`.
**Steps:** 1) Perform a destructive bulk action. 2) Restore to a point in time. 3) Reconcile: what was lost, what was replayed, what diverged. 4) Measure RTO/RPO.
**Expect:** Point-in-time restore is rehearsed on a schedule, meets documented RTO/RPO, and produces a reconciliation report of any divergence. Restoration is a practised procedure, not an improvisation.
**iSched:** n/a. **Decide:** SP-REQ. **Impact:** permanent loss of schedule data.
**Sec:** high (availability + integrity). **Audit:** restore events. **Notify:** stakeholders. **Recover:** the case itself. **Open:** none.

---

## 11. Privacy and security (QA-SEC)

### ★ Hard requirement SP-HR-1 — no email-derived identifier may reach a third-party avatar provider

> **SchedulePoint must never transmit an email address, an email hash, or any other stable email-derived identifier to a third-party avatar provider.** Avatars must be locally generated initials, organization-managed uploads, or a privacy-reviewed first-party image service.

This is a direct, deliberate divergence from an **OBSERVED** source behaviour: ischedule.MD sends a hashed user identifier to Gravatar on every page load, for every user, with no observed consent mechanism (10-technical §3, §14). Because the hash is (per Gravatar's documented convention) derived from the email address, it is correlatable back to the individual via public reverse-lookup services — leaking "this email belongs to a user of this healthcare scheduling product" to a third party on every single page view.

#### QA-SEC-001 · No third-party avatar request is ever made
**Class:** OBSERVED → SP-IMP (**SP-HR-1**) · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Security, Playwright, Unit · **Auto:** High · **Env:** SEED · **Own:** Privacy · **Dep:** none
**Refs:** avatar rendering on every screen · **Ev:** 10-technical §3, §14 (T-05)
**Risk:** An avatar component silently reintroduces a third-party call.
**Pre:** Any authenticated page. **Data:** users with and without uploaded avatars.
**Steps:** 1) Load every screen with a network allow-list that blocks all non-first-party hosts. 2) Assert zero requests to any avatar/gravatar/image-proxy host. 3) Assert avatars still render (initials fallback).
**Expect:** Zero third-party avatar requests under all conditions; initials render locally with no network call at all.
**iSched:** OBSERVED — the source makes this request on every page load.
**Decide:** SP-IMP. **Impact:** silent PII leakage for every user. **Sec:** critical (privacy).
**Audit:** none needed if the call never exists. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-SEC-002 · Regression guard: no new third-party host may appear
**Class:** SP-REQ (**SP-HR-1**) · **Sev:** High · **Pri:** MVP-blocker · **Like:** High · **Level:** Security, Integration (CI) · **Auto:** High · **Env:** SEED (CI) · **Own:** Privacy · **Dep:** QA-SEC-001
**Refs:** all pages · **Ev:** 10-technical §3 (six distinct third-party hosts observed in the source, incl. an unexpected image proxy)
**Risk:** A future dependency quietly adds an external call carrying user data.
**Pre:** CI pipeline. **Data:** allow-list of approved hosts.
**Steps:** Crawl all routes in CI; diff observed outbound hosts against the allow-list; fail the build on any addition.
**Expect:** The build fails until a new host is explicitly reviewed and allow-listed with a documented privacy justification.
**iSched:** OBSERVED the source's third-party surface grew organically (Gravatar, an image proxy, a broken support widget, three CDNs) — exactly what this guard prevents.
**Decide:** SP-REQ. **Impact:** creeping privacy erosion. **Sec:** high.
**Audit:** allow-list changes reviewed. **Notify:** none. **Recover:** revert. **Open:** none.

#### QA-SEC-003 · Network-level privacy assertion for user-derived identifiers
**Class:** SP-REQ (**SP-HR-1**) · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Security, Integration · **Auto:** High · **Env:** SEED · **Own:** Privacy · **Dep:** QA-SEC-002
**Refs:** all outbound traffic · **Ev:** 10-technical §14
**Risk:** A user identifier leaks in a hashed or encoded form that a simple string search misses.
**Pre:** Known test user with a known email. **Data:** the email plus its MD5, SHA-1, SHA-256, base64, and URL-encoded forms.
**Steps:** Exercise all major flows while capturing outbound traffic; search every request URL, header, and body for any of those forms.
**Expect:** No user-derived identifier — plain or hashed — appears in any request to any non-first-party host.
**iSched:** OBSERVED the hashed-email pattern exists in the source. **Decide:** SP-IMP.
**Impact:** re-identification by a third party. **Sec:** critical. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-SEC-004 · No third-party analytics, tracking, or session replay carrying PII
**Class:** SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Security, Manual exploratory · **Auto:** High · **Env:** SEED · **Own:** Privacy · **Dep:** QA-SEC-002
**Refs:** all pages · **Ev:** 10-technical §3 (no analytics/replay tool was observed in the source — a baseline worth preserving)
**Risk:** Session-replay or analytics tooling captures rosters, contact details, or clinical context.
**Pre:** Analytics configured (if any). **Data:** PII-bearing screens.
**Steps:** Inspect payloads from every analytics/replay/error-reporting tool for names, emails, phones, schedule content, and clinical detail.
**Expect:** Either no such tooling, or strict allow-list-based capture with PII masked by default and verified per release. Error reports scrub request bodies and URLs.
**iSched:** OBSERVED — the source ships no analytics or replay tooling. **Decide:** SP-REQ (preserve).
**Impact:** bulk PII export to a vendor. **Sec:** critical. **Audit:** tooling config changes. **Notify:** none. **Recover:** purge. **Open:** none.

#### QA-SEC-005 · No sensitive data in URLs, logs, or referrers
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** MVP-blocker · **Like:** High · **Level:** Security, Integration · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** none
**Refs:** all routes · **Ev:** 03-user WF-23 (the calendar feed URL embeds the user's email **and** a bearer token in query parameters)
**Risk:** URLs land in server logs, browser history, proxy logs, and `Referer` headers sent to third parties.
**Pre:** n/a. **Data:** flows involving identifiers and tokens.
**Steps:** Inspect every URL for PII/tokens; inspect logs for the same; check `Referer` on outbound links; check error pages.
**Expect:** No PII or secret ever appears in a URL path or query string; tokens travel in headers or POST bodies; logs redact identifiers; `Referrer-Policy` restricts leakage.
**iSched:** OBSERVED — the source's feed URL carries both an email and a token in the query string.
**Decide:** SP-IMP. **Impact:** credential and identity leakage via logs. **Sec:** critical.
**Audit:** log-redaction verified per release. **Notify:** none. **Recover:** rotate leaked tokens. **Open:** none.

#### QA-SEC-006 · Patient/clinical information boundary
**Class:** OBSERVED → SP-IMP · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Security, Manual exploratory · **Auto:** Med · **Env:** SEED · **Own:** Privacy · **Dep:** QA-PICK-017
**Refs:** SCH-01 "Today's Shifts", DA-01 · **Ev:** 07-picklist §6 (case-level detail incl. age indicators and procedure descriptions confirmed present in the source)
**Risk:** A scheduling product accumulates clinical data and inherits clinical-system obligations without clinical-system controls.
**Pre:** n/a. **Data:** synthetic only.
**Steps:** Audit every screen, export, report, notification body, log line, error message, and screenshot path for patient-identifiable content.
**Expect:** Patient-identifiable information is out of scope for SchedulePoint by default. Any deliberate exception is separately permissioned, separately audited, excluded from exports/notifications, and documented in the data map.
**iSched:** OBSERVED such detail is present in the source's personal schedule views.
**Decide:** SP-IMP. **Impact:** regulatory exposure. **Sec:** critical.
**Audit:** any clinical-context access. **Notify:** never in message bodies. **Recover:** n/a. **Open:** none.

#### QA-SEC-007 · Error messages reveal nothing sensitive
**Class:** UNRESOLVED → SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** Medium · **Level:** Security, API · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** none
**Refs:** all error paths · **Ev:** 10-technical §3 (no client error state was ever encountered in eleven phases)
**Risk:** Stack traces, SQL, internal hostnames, or "user exists" hints leak.
**Pre:** n/a. **Data:** malformed inputs, unauthorized ids, forced 500s.
**Steps:** Trigger 400/401/403/404/409/422/500 on every endpoint; inspect bodies and pages.
**Expect:** Generic, actionable user-facing messages plus a correlation id; details only in server logs; authentication and lookup errors do not distinguish "not found" from "not permitted."
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** reconnaissance aid. **Sec:** high.
**Audit:** correlation ids. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-SEC-008 · Server-side authorization on every endpoint (route-table sweep)
**Class:** INFERRED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Authorization, Security · **Auto:** High · **Env:** MULTI · **Own:** Platform · **Dep:** QA-TEN-012
**Refs:** every route · **Ev:** 02-role §8
**Risk:** A new endpoint ships without an authorization attribute and is open by default.
**Pre:** Full route table. **Data:** role × route matrix.
**Steps:** Enumerate every route from the framework's own route table; assert each has an explicit authorization policy; execute each as every role including anonymous.
**Expect:** Deny-by-default: a route without an explicit policy fails the build. The sweep is generated from the route table so new routes are covered automatically.
**iSched:** UNRESOLVED — never tested by rule. **Decide:** SP-REQ.
**Impact:** unauthenticated data access. **Sec:** critical. **Audit:** denials. **Notify:** alert on anomalies. **Recover:** n/a. **Open:** none.

#### QA-SEC-009 · Calendar-feed token strength, scope, and revocation
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** Medium · **Level:** Security · **Auto:** High · **Env:** SEED · **Own:** Integrations · **Dep:** QA-DATE-008
**Refs:** WF-23 · **Ev:** 03-user WF-23
**Risk:** A guessable, non-expiring, non-revocable feed token exposes a clinician's whole schedule.
**Pre:** Feed issued. **Data:** token samples (structure only — never recorded).
**Steps:** Assess entropy; test guessability; assert read-only scope (write attempts via the feed path must fail); rotate and revoke.
**Expect:** High-entropy, single-purpose, read-only, revocable, rotatable, and independently scoped to one membership. Never reusable for API access.
**iSched:** OBSERVED the token exists and is long-lived; strength and revocability UNRESOLVED (#35).
**Decide:** SP-REQ. **Impact:** schedule disclosure. **Sec:** high. **Audit:** issue/rotate/revoke. **Notify:** on rotation. **Recover:** revoke. **Open:** #35.

#### QA-SEC-010 · Document and report URL leakage
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** Medium · **Level:** Security · **Auto:** High · **Env:** MULTI · **Own:** Documents · **Dep:** QA-RPT-010
**Refs:** DOC-01, report artifacts · **Ev:** 08-supporting SM-05
**Risk:** A shared link grants indefinite public access to a sensitive document.
**Pre:** Stored documents. **Data:** `MULTI`.
**Steps:** Extract a storage URL; access it unauthenticated, after logout, from another tenant, and after the document is deleted.
**Expect:** All four fail. URLs are signed, short-lived, single-tenant, and invalidated on deletion.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** document disclosure. **Sec:** critical.
**Audit:** access attempts. **Notify:** none. **Recover:** rotate. **Open:** none.

#### QA-SEC-011 · Cookie protections
**Class:** INFERRED → SP-REQ · **Sev:** High · **Pri:** MVP-blocker · **Like:** Low · **Level:** Security · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** QA-AUTH-013
**Refs:** session + UI-state cookies · **Ev:** 10-technical §7
**Risk:** Missing `HttpOnly`/`Secure`/`SameSite`, or PII placed in a script-readable cookie.
**Pre:** n/a. **Data:** n/a.
**Steps:** Enumerate every cookie; assert attributes; assert no PII in any script-readable cookie.
**Expect:** Session cookie `HttpOnly`+`Secure`+`SameSite=Lax|Strict`; UI-state cookies carry only opaque, non-personal values.
**iSched:** INFERRED positive for the session cookie. **Decide:** SP-REQ (preserve + verify).
**Impact:** session theft. **Sec:** critical. **Audit:** none. **Notify:** none. **Recover:** rotate. **Open:** none.

#### QA-SEC-012 · Stored XSS via user-authored rich content
**Class:** OBSERVED → SP-REQ · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Security · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** none
**Refs:** picklist room description (a rich-text editor with an HTML source toggle), comments fields, `Report Box` · **Ev:** 07-picklist §1 (rich-text editor with embedded `</>` HTML view observed); 01-app ADM-01
**Risk:** A rich-text field with raw-HTML editing stores script that executes for every other user.
**Pre:** Rich-text and comment fields. **Data:** XSS payload set incl. HTML-mode injection, SVG, and event-handler attributes.
**Steps:** Submit payloads into every free-text and rich-text field; view as another user; check exports, notification bodies, and reports.
**Expect:** Server-side sanitisation with a strict allow-list; output encoding at every render site including exports and emails; a Content-Security-Policy that blocks inline execution.
**iSched:** OBSERVED a rich-text editor exposing a raw HTML view exists in the source — a real injection surface. Its sanitisation is UNRESOLVED (never submitted).
**Decide:** SP-REQ. **Impact:** account takeover across the tenant. **Sec:** critical.
**Audit:** none. **Notify:** none. **Recover:** purge + rotate sessions. **Open:** none.

#### QA-SEC-013 · Bulk-messaging abuse controls
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** Medium · **Level:** Security, Authorization · **Auto:** High · **Env:** MULTI · **Own:** Notifications · **Dep:** QA-NOT-006
**Refs:** CON-01 Send Email / Send SMS · **Ev:** 08-supporting SM-04 (composition form never opened)
**Risk:** Bulk messaging becomes a spam or phishing vector, or reaches recipients outside the tenant.
**Pre:** Bulk send available. **Data:** `MULTI`.
**Steps:** 1) Attempt to send to a recipient outside the tenant. 2) Inject arbitrary addresses. 3) Send at volume. 4) Inspect the message for spoofable content.
**Expect:** Recipients are selectable only from the tenant's own roster (never free-text); rate-limited and audited; the sender's identity is unambiguous in the message.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** phishing from a trusted domain.
**Sec:** high. **Audit:** every bulk send with recipient count + actor. **Notify:** none. **Recover:** n/a. **Open:** #62.

#### QA-SEC-014 · PII minimisation by role
**Class:** OBSERVED → SP-IMP · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Authorization, Domain · **Auto:** High · **Env:** MULTI · **Own:** Privacy · **Dep:** QA-TEN-012
**Refs:** CON-01, ADM-05, SCH-05 · **Ev:** 02-role §8 ("contact PII broadly visible … a real product would need a clear data-minimization story"); 08-supporting SM-03 (Contacts shows 66 rows vs. the admin table's 94 — an unexplained filtering difference)
**Risk:** Every user can see every colleague's personal mobile, home phone, and personal email.
**Pre:** Roles configured. **Data:** role matrix.
**Steps:** For each role, enumerate exactly which PII fields are returned by the API (not merely displayed).
**Expect:** Field-level minimisation — personal contact details are exposed only where a documented operational need exists (e.g. on-call contact during a shift), not by default in a general directory. The API never returns fields the UI hides.
**iSched:** OBSERVED broad PII visibility, plus an unexplained roster/contacts discrepancy suggesting some filtering exists but is undocumented (#60).
**Decide:** SP-IMP. **Impact:** unnecessary exposure of staff personal data. **Sec:** high.
**Audit:** bulk PII reads. **Notify:** none. **Recover:** n/a. **Open:** #60.

---

## 12. Performance and request efficiency (QA-PERF)

### ★ Hard requirement SP-HR-2 — one user action must not generate duplicate equivalent requests

> **A single user action must never unintentionally generate duplicate equivalent requests.** SchedulePoint must use request de-duplication, query coalescing, caching, idempotency, and server-side protection.

This is a direct response to an **OBSERVED** defect: selecting one picklist row in ischedule.MD fired the same GET roughly 25–40 times in immediate succession, with at least two distinct code paths calling the same endpoint under different parameter names (10-technical §5 API-14, §10).

#### QA-PERF-001 · One action, one request (unit + integration)
**Class:** OBSERVED → SP-IMP (**SP-HR-2**) · **Sev:** High · **Pri:** MVP-blocker · **Like:** High · **Level:** Unit, Integration · **Auto:** High · **Env:** SEED · **Own:** Frontend/Platform · **Dep:** none
**Refs:** every data-fetching component · **Ev:** 10-technical §10 (T-01)
**Risk:** Per-row or per-component fetching multiplies one interaction into dozens of identical calls.
**Pre:** Instrumented data layer. **Data:** list views with many rows.
**Steps:** For each interaction, count requests grouped by (method, endpoint, normalised params).
**Expect:** Exactly one in-flight request per unique tuple; concurrent identical requests are coalesced into one; components read from a shared store rather than fetching independently.
**iSched:** OBSERVED ~25–40× amplification on a single click.
**Decide:** SP-IMP. **Impact:** wasted capacity, slow UI, worse under load. **Sec:** low (DoS-adjacent).
**Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** #74 (source root cause).

#### QA-PERF-002 · One action, one request (Playwright end-to-end assertion)
**Class:** SP-REQ (**SP-HR-2**) · **Sev:** High · **Pri:** MVP-blocker · **Like:** High · **Level:** Playwright · **Auto:** High · **Env:** SEED (CI) · **Own:** Frontend · **Dep:** QA-PERF-001
**Refs:** all primary user journeys · **Ev:** derived
**Risk:** Amplification reappears through a component added later.
**Pre:** CI. **Data:** journey scripts.
**Steps:** Record network activity per journey step; assert the count per unique tuple against a committed budget; fail the build on regression.
**Expect:** A per-journey request budget is enforced in CI, so any regression fails before release.
**iSched:** OBSERVED the failure this guards against. **Decide:** SP-REQ.
**Impact:** silent performance regression. **Sec:** low. **Audit:** budget changes reviewed. **Notify:** none. **Recover:** revert. **Open:** none.

#### QA-PERF-003 · Server-side duplicate-request protection
**Class:** SP-REQ (**SP-HR-2**) · **Sev:** Medium · **Pri:** pre-prod · **Like:** Medium · **Level:** API, Performance · **Auto:** High · **Env:** PERF · **Own:** Platform · **Dep:** QA-CON-003
**Refs:** all endpoints · **Ev:** 10-technical §10
**Risk:** A buggy or malicious client floods an endpoint regardless of client-side discipline.
**Pre:** n/a. **Data:** burst generator.
**Steps:** Send N identical requests within a short window from one session.
**Expect:** Per-session rate limiting with a clear `429` and `Retry-After`; short-window response caching for identical idempotent reads; mutations protected by idempotency keys. The server never relies on client good behaviour.
**iSched:** UNRESOLVED — the source's server absorbed ~40 identical calls without visible throttling.
**Decide:** SP-REQ. **Impact:** capacity exhaustion. **Sec:** medium. **Audit:** rate-limit events. **Notify:** ops. **Recover:** automatic. **Open:** none.

#### QA-PERF-004 · Observability for request amplification
**Class:** SP-REQ (**SP-HR-2**) · **Sev:** Medium · **Pri:** pre-prod · **Like:** High · **Level:** Performance, Integration · **Auto:** High · **Env:** PERF · **Own:** Platform · **Dep:** QA-PERF-003
**Refs:** telemetry · **Ev:** 10-technical §10 (the defect was only discoverable by external traffic inspection — the product itself surfaced nothing)
**Risk:** Amplification exists in production and nobody notices, exactly as in the source.
**Pre:** Telemetry configured. **Data:** synthetic amplification.
**Steps:** Introduce a deliberate duplicate-fetch bug behind a flag; assert monitoring detects and alerts on the requests-per-interaction ratio.
**Expect:** Requests-per-user-action is a tracked metric with alerting; traces group requests by originating interaction via a correlation id.
**iSched:** OBSERVED — the source has no such visibility. **Decide:** SP-IMP.
**Impact:** undetected waste. **Sec:** low. **Audit:** none. **Notify:** ops alert. **Recover:** n/a. **Open:** none.

#### QA-PERF-005 · N+1 query behaviour at the data layer
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Database, Performance · **Auto:** High · **Env:** PERF · **Own:** Backend · **Dep:** QA-PERF-001
**Refs:** roster + schedule composition (API-01/05/07 fetch overlapping data separately) · **Ev:** 10-technical §5
**Risk:** Rendering a schedule issues one query per staff member per day.
**Pre:** Query logging on. **Data:** large fixture.
**Steps:** Render the widest schedule; count queries; assert against a budget that does not scale with row count.
**Expect:** Query count is bounded and independent of result-set size; batching/eager-loading is verified by an automated assertion, not by inspection.
**iSched:** UNRESOLVED at the DB layer (only the AJAX-layer N+1 was observable externally).
**Decide:** SP-REQ. **Impact:** slow at scale. **Sec:** low. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-PERF-006 · Real-time connection scoping and reconnection cost
**Class:** OBSERVED → SP-IMP · **Sev:** Medium · **Pri:** pre-prod · **Like:** High · **Level:** Performance, Integration · **Auto:** High · **Env:** PERF · **Own:** Realtime · **Dep:** QA-PICK-012
**Refs:** SignalR `picklist` hub · **Ev:** 10-technical §8 (**a fresh connection is established on every page load, on every page — even those with no live feature**)
**Risk:** Every navigation churns a real-time connection; at scale this is pure overhead, and reconnect storms follow any restart.
**Pre:** Many concurrent sessions. **Data:** `PERF`.
**Steps:** 1) Measure connection churn across navigation. 2) Restart the real-time service with N clients connected. 3) Observe reconnection.
**Expect:** Real-time connections open only on pages with a live feature; reconnection uses exponential backoff with jitter to avoid a thundering herd; connection count scales with *users needing live updates*, not with page views.
**iSched:** OBSERVED global per-page-load connection establishment.
**Decide:** SP-IMP (matches T-10). **Impact:** server overhead, restart storms. **Sec:** low.
**Audit:** connection metrics. **Notify:** ops. **Recover:** backoff. **Open:** #73.

#### QA-PERF-007 · Cache invalidation correctness
**Class:** SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Integration, Concurrency · **Auto:** High · **Env:** SEED · **Own:** Platform · **Dep:** QA-TEN-007
**Refs:** any caching introduced per QA-PERF-001 · **Ev:** 10-technical §10 (the source caches nothing across navigations — SchedulePoint adding caching introduces this new risk class)
**Risk:** Adding caching to fix amplification introduces stale-data bugs, including cross-tenant ones.
**Pre:** Caching enabled. **Data:** mutation + read pairs.
**Steps:** For each cached resource: mutate it, then immediately read it (same session, another session, another org).
**Expect:** Writes invalidate or update affected cache entries synchronously; cache keys include tenant and permission scope; a stale read is never possible after one's own write.
**iSched:** OBSERVED absence of caching (so no staleness, but no benefit either).
**Decide:** SP-REQ — introduce caching **and** its invalidation tests together. **Impact:** wrong data shown confidently.
**Sec:** high (cross-tenant risk). **Audit:** none. **Notify:** none. **Recover:** flush. **Open:** none.

#### QA-PERF-008 · Large datasets: schedules, rosters, reports
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** pre-prod · **Like:** High · **Level:** Performance, Playwright · **Auto:** High · **Env:** PERF · **Own:** Frontend/Backend · **Dep:** QA-SCH-014
**Refs:** SCH-02/03/04 (8 weeks × ~100 staff), ADM-05 (94/103-row rosters, 20-per-page paging observed) · **Ev:** 02-role §5
**Risk:** Rendering the maximum range with a large roster freezes the browser.
**Pre:** Stress fixture (≥200 staff, 8 weeks, ≥5000 assignments). **Data:** `PERF`.
**Steps:** Measure time-to-interactive, scroll smoothness, memory, and interaction latency at max scale.
**Expect:** Documented performance budgets met; virtualised rendering; server-side pagination/windowing for all large collections.
**iSched:** OBSERVED the source paginates admin tables (20/page) but renders full schedule ranges without evident virtualisation.
**Decide:** SP-REQ. **Impact:** unusable for large departments. **Sec:** low.
**Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-PERF-009 · Slow networks, cancellation, and abandoned requests
**Class:** SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** High · **Level:** Playwright, Performance · **Auto:** High · **Env:** PERF · **Own:** Frontend · **Dep:** QA-PERF-001
**Refs:** all data-loading screens · **Ev:** 09-responsive §1 (mobile use is a real scenario); 10-technical §10 (one request observed still pending at capture end)
**Risk:** Rapid navigation leaves stale in-flight responses that overwrite newer data ("last response wins" rather than "latest request wins").
**Pre:** Throttled network. **Data:** slow-3G profile.
**Steps:** Navigate rapidly between date ranges/screens; let slow responses land after newer ones.
**Expect:** Superseded requests are cancelled; late responses for a superseded request are discarded, never rendered; loading states are honest about what is still pending.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** user sees data for the wrong date range.
**Sec:** low. **Audit:** none. **Notify:** none. **Recover:** refresh. **Open:** none.

#### QA-PERF-010 · Multiple tabs and memory growth
**Class:** SP-REQ · **Sev:** Medium · **Pri:** post-MVP · **Like:** Medium · **Level:** Performance · **Auto:** Med · **Env:** PERF · **Own:** Frontend · **Dep:** QA-PERF-006
**Refs:** long-lived monitoring views (DASH-01) · **Ev:** 01-app DASH-01 (a live monitor is designed to stay open)
**Risk:** A monitoring dashboard left open all day leaks memory or accumulates connections until the tab dies.
**Pre:** Long-running session. **Data:** `PERF`.
**Steps:** Leave monitoring views open for an extended period across many updates and several tabs; sample memory and connection counts.
**Expect:** Stable memory; listeners and connections cleaned up on unmount; bounded in-memory history.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** the always-on monitor — the one screen meant to run all day — degrades.
**Sec:** low. **Audit:** none. **Notify:** none. **Recover:** reload. **Open:** none.

#### QA-PERF-011 · Excessive polling
**Class:** OBSERVED → SP-IMP · **Sev:** Medium · **Pri:** pre-prod · **Like:** Medium · **Level:** Performance, Integration · **Auto:** High · **Env:** PERF · **Own:** Realtime · **Dep:** QA-PERF-006
**Refs:** long-polling transport; "last synced N minutes ago" + manual refresh · **Ev:** 10-technical §8; 07-picklist §4
**Risk:** Aggressive polling across many idle sessions dominates load.
**Pre:** Many idle sessions. **Data:** `PERF`.
**Steps:** Measure request volume from idle sessions over time.
**Expect:** Idle sessions generate near-zero traffic; polling (where used) backs off when idle or when the tab is hidden; push is preferred where a live feature genuinely needs it.
**iSched:** OBSERVED long-polling on every page plus a manual-refresh/staleness pattern — see Contradiction C-04.
**Decide:** SP-IMP. **Impact:** cost and capacity. **Sec:** low. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** #73.

---

## 13. Accessibility and responsive behaviour (QA-A11Y)

### ★ Hard requirements SP-HR-3 to SP-HR-6

> **SP-HR-3** — Every interactive element must have a clearly visible keyboard-focus indicator.
> **SP-HR-4** — Every icon-only control must have a meaningful accessible name.
> **SP-HR-5** — Every critical workflow must be fully operable by keyboard.
> **SP-HR-6** — Errors, validation results, and important status changes must be programmatically communicated.

SP-HR-3 and SP-HR-4 respond to concrete **OBSERVED** defects (09-responsive RA-07: global `outline: none` with no replacement, on every element sampled; RA-13: icon-only Prev/Next date buttons with no accessible name on nearly every schedule screen). SP-HR-6 responds to an **UNRESOLVED** gap that must not be inherited (RA-17: no validation or error state was ever observable).

#### QA-A11Y-001 · Visible focus indicator on every interactive element
**Class:** OBSERVED → SP-IMP (**SP-HR-3**) · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Component, Accessibility, Playwright · **Auto:** High · **Env:** A11Y (CI) · **Own:** Design system · **Dep:** none
**Refs:** every interactive element · **Ev:** 09-responsive RA-07 / F-01
**Risk:** Keyboard users cannot see where they are.
**Pre:** n/a. **Data:** n/a.
**Steps:** 1) Automated: assert no rule sets `outline: none` without a replacement indicator. 2) Tab through every screen capturing each focus stop. 3) Measure indicator contrast against adjacent colours.
**Expect:** Every focusable element shows an indicator meeting at least 3:1 contrast against adjacent colours, visible in both light and dark themes and in forced-colors mode. A lint rule blocks bare `outline: none`.
**iSched:** OBSERVED — `outline-style: none` on every element sampled, with no alternative indicator found.
**Decide:** SP-IMP. **Impact:** keyboard navigation effectively unusable. **Sec:** none.
**Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** #63 (whether *any* source element has focus styling).

#### QA-A11Y-002 · Accessible name on every icon-only control
**Class:** OBSERVED → SP-IMP (**SP-HR-4**) · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Component, Accessibility · **Auto:** High · **Env:** A11Y (CI) · **Own:** Design system · **Dep:** none
**Refs:** date navigation, toolbar icons, dropdown toggles · **Ev:** 09-responsive RA-13 / F-02 (Prev/Next arrows unlabelled across nearly every schedule screen; zero `aria-label` on the busiest page)
**Risk:** Screen-reader users hear "button" with no indication of function.
**Pre:** n/a. **Data:** n/a.
**Steps:** 1) Automated accessible-name check on every control across all routes. 2) Screen-reader pass over the date-navigation controls specifically.
**Expect:** Every control exposes a non-empty, descriptive accessible name ("Previous week", not "Previous"). The icon-button component **requires** a label prop at the type level so an unlabelled instance cannot compile.
**iSched:** OBSERVED — three unlabelled buttons on one page, including the ubiquitous Prev/Next pair.
**Decide:** SP-IMP. **Impact:** core navigation unusable non-visually. **Sec:** none.
**Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** #64.

#### QA-A11Y-003 · Every critical workflow fully keyboard-operable
**Class:** SP-REQ (**SP-HR-5**) · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Playwright, Accessibility, Manual · **Auto:** High · **Env:** A11Y · **Own:** Frontend · **Dep:** QA-A11Y-001
**Refs:** view schedule, submit request, approve, claim opportunity, propose/accept swap, make a pick, publish · **Ev:** 09-responsive RA-11 (pointer-only controls could not be ruled out)
**Risk:** A drag-only or click-only control makes a critical task impossible without a mouse — the picklist Work panel's drag-handle reordering is a concrete candidate.
**Pre:** n/a. **Data:** journey scripts.
**Steps:** Complete each critical workflow end-to-end using only the keyboard, including any drag-reorder interaction.
**Expect:** Every workflow completes by keyboard alone; every drag interaction has an equivalent keyboard mechanism (e.g. move-up/move-down commands).
**iSched:** UNRESOLVED — pointer-only controls were never ruled out (testing them would have required activating controls).
**Decide:** SP-REQ. **Impact:** complete exclusion of some users from core tasks. **Sec:** none.
**Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-A11Y-004 · Errors, validation, and status changes announced programmatically
**Class:** UNRESOLVED → SP-REQ (**SP-HR-6**) · **Sev:** Critical · **Pri:** MVP-blocker · **Like:** High · **Level:** Component, Accessibility, Playwright · **Auto:** High · **Env:** A11Y · **Own:** Design system · **Dep:** QA-A11Y-005
**Refs:** all forms, toasts, conflict messages, save confirmations · **Ev:** 09-responsive RA-17 (no validation state was ever observable); RA-18 (4 `aria-live` regions exist but their purpose is unknown)
**Risk:** A validation error or a conflict message appears visually only; non-visual users never learn the submission failed.
**Pre:** n/a. **Data:** invalid-input fixtures per form.
**Steps:** For every form: submit invalid input with a screen reader active; assert the error is announced, focus moves to (or references) the first invalid field, and the field is programmatically associated with its message.
**Expect:** Errors use `aria-describedby` + `aria-invalid`; a summary is announced via an assertive live region; toasts and status changes use a polite live region; success confirmations are announced too — not only failures.
**iSched:** UNRESOLVED — no form was ever submitted, so no error state exists in the evidence base.
**Decide:** SP-REQ. **Impact:** silent failure for assistive-tech users. **Sec:** none.
**Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** #69.

#### QA-A11Y-005 · Form labels and required-field communication
**Class:** UNRESOLVED → SP-REQ · **Sev:** High · **Pri:** MVP-blocker · **Like:** High · **Level:** Component, Accessibility · **Auto:** High · **Env:** A11Y (CI) · **Own:** Design system · **Dep:** none
**Refs:** every form · **Ev:** 09-responsive RA-17
**Risk:** Placeholder-as-label or asterisk-only "required" marking leaves the requirement unannounced.
**Pre:** n/a. **Data:** n/a.
**Steps:** Automated label-association check on every input; assert `required`/`aria-required` on every mandatory field; verify required-ness is conveyed in text, not by colour or asterisk alone.
**Expect:** Every input has a programmatically associated visible label; required fields are marked in the accessible name or description; placeholders are never the only label.
**iSched:** UNRESOLVED. **Decide:** SP-REQ. **Impact:** unusable forms non-visually. **Sec:** none.
**Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** #69.

#### QA-A11Y-006 · Heading hierarchy on every page
**Class:** OBSERVED → SP-IMP · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Accessibility (CI) · **Auto:** High · **Env:** A11Y (CI) · **Own:** Frontend · **Dep:** none
**Refs:** all pages · **Ev:** 09-responsive RA-12 / F-03 (**zero** h1/h2/h3 on the busiest screen; the visible page title is not a heading element at all)
**Risk:** Heading-based navigation — a primary screen-reader technique — is unavailable.
**Pre:** n/a. **Data:** n/a.
**Steps:** Extract the heading outline of every route; assert exactly one `h1` and no skipped levels; assert the visible page title *is* the `h1`.
**Expect:** Enforced in CI for every route.
**iSched:** OBSERVED — only hidden modal-title h4s existed on the page checked.
**Decide:** SP-IMP. **Impact:** disorientation, slow navigation. **Sec:** none. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-A11Y-007 · Modal semantics, focus containment, and restoration
**Class:** OBSERVED (mixed) → SP-REQ · **Sev:** High · **Pri:** MVP-blocker · **Like:** High · **Level:** Component, Accessibility, Playwright · **Auto:** High · **Env:** A11Y · **Own:** Design system · **Dep:** QA-A11Y-001
**Refs:** every dialog · **Ev:** 09-responsive RA-09/RA-10 (focus trap and Escape **work** — a genuine strength) and RA-14 / F-04 (8 of 9 dialogs lack `aria-labelledby`; none sets `aria-modal`)
**Risk:** A modal opens without being announced as a modal or named; or focus is not restored to the trigger on close.
**Pre:** n/a. **Data:** every modal.
**Steps:** For each modal: open; assert `role="dialog"`, `aria-modal="true"`, and a resolving `aria-labelledby`; assert initial focus placement, Tab wrap-around, Escape close, and **focus restoration to the triggering control**.
**Expect:** All of the above pass for every modal. Focus trapping and Escape (already good in the source) are preserved as non-negotiable baselines.
**iSched:** OBSERVED — trap and Escape work; naming and `aria-modal` are largely absent.
**Decide:** SP-REQ (preserve strengths, fix gaps). **Impact:** confusing or trapping non-visual experience.
**Sec:** none. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-A11Y-008 · Skip link and logical focus order
**Class:** OBSERVED → SP-IMP · **Sev:** Medium · **Pri:** pre-beta · **Like:** High · **Level:** Accessibility, Playwright · **Auto:** High · **Env:** A11Y · **Own:** Frontend · **Dep:** QA-A11Y-001
**Refs:** app shell · **Ev:** 09-responsive RA-11 / F-07 (**no skip link exists**; 11+ links must be tabbed on every page load) and RA-08 (focus order itself was logical)
**Risk:** Every page load costs a keyboard user a dozen redundant tab presses.
**Pre:** n/a. **Data:** n/a.
**Steps:** Assert the first focusable element is a skip link that becomes visible on focus and moves focus to `main`; verify focus order matches visual order on each screen.
**Expect:** Skip link present on every page; focus order matches visual order; no positive `tabindex` values anywhere.
**iSched:** OBSERVED — order good, skip link absent. **Decide:** SP-IMP.
**Impact:** slow, tiring navigation. **Sec:** none. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-A11Y-009 · No keyboard traps outside intentional modals
**Class:** OBSERVED → SP-REQ · **Sev:** High · **Pri:** MVP-blocker · **Like:** Medium · **Level:** Accessibility, Playwright · **Auto:** High · **Env:** A11Y · **Own:** Frontend · **Dep:** QA-A11Y-007
**Refs:** custom widgets (comboboxes, grids, rich-text editor) · **Ev:** 09-responsive RA-11 (none found in the sample); 10-technical §3 (heavy use of a third-party widget suite — a common trap source)
**Risk:** A custom grid or rich-text editor captures Tab and cannot be escaped by keyboard.
**Pre:** n/a. **Data:** every custom widget.
**Steps:** Tab into and out of every custom widget in both directions; verify documented escape mechanisms.
**Expect:** Focus always escapes by keyboard; any widget that intentionally captures Tab (e.g. a rich-text editor) documents and implements an escape key that is discoverable.
**iSched:** OBSERVED no traps in the sampled non-modal sequence; custom widgets not exhaustively traversed.
**Decide:** SP-REQ. **Impact:** user stuck, must reload. **Sec:** none. **Audit:** none. **Notify:** none. **Recover:** reload. **Open:** none.

#### QA-A11Y-010 · Status not conveyed by colour alone
**Class:** OBSERVED → SP-IMP · **Sev:** Medium · **Pri:** pre-beta · **Like:** High · **Level:** Component, Accessibility, Manual · **Auto:** Med · **Env:** A11Y · **Own:** Design system · **Dep:** none
**Refs:** request status badges, negative balances, shift-code colouring · **Ev:** 09-responsive RA-16 / F-06 (pending vs approved distinguished **only** by amber/green fill on an identical icon)
**Risk:** Colourblind users cannot distinguish pending from approved; screen-reader users get nothing at all.
**Pre:** n/a. **Data:** all status states.
**Steps:** Render every status in greyscale and under colourblindness simulation; inspect the accessible name of each status indicator.
**Expect:** Every status carries a text label, distinct glyph, or pattern in addition to colour, and exposes its status in its accessible name.
**iSched:** OBSERVED — colour-only status badges confirmed. **Decide:** SP-IMP.
**Impact:** misread approval status leading to wrong assumptions about time off. **Sec:** none.
**Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-A11Y-011 · Contrast in all themes and forced-colors mode
**Class:** SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** High · **Level:** Accessibility (CI) · **Auto:** High · **Env:** A11Y (CI) · **Own:** Design system · **Dep:** QA-A11Y-001
**Refs:** all UI · **Ev:** 09-responsive RA-16 (dense colour-coded UI throughout)
**Risk:** Dense colour-coded grids fail contrast, especially in dark or forced-colors mode.
**Pre:** n/a. **Data:** full palette incl. all shift-code colours.
**Steps:** Automated contrast audit of every text/background pair and every non-text indicator, in each theme and in forced-colors mode.
**Expect:** Text meets 4.5:1 (3:1 for large text); non-text indicators meet 3:1; forced-colors mode remains usable and information is not lost.
**iSched:** UNRESOLVED — contrast was never measured. **Decide:** SP-REQ.
**Impact:** unreadable for low-vision users. **Sec:** none. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-A11Y-012 · Table and grid semantics
**Class:** OBSERVED (mixed) → SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** Medium · **Level:** Accessibility, Component · **Auto:** High · **Env:** A11Y · **Own:** Design system · **Dep:** none
**Refs:** schedule grid, admin tables · **Ev:** 09-responsive RA-15 (real `<th>` elements exist, but `role="columnheader"` is absent while `role="grid"` is used — an inconsistent mix of two models)
**Risk:** A hybrid HTML-table / ARIA-grid model announces confusingly or loses header associations.
**Pre:** n/a. **Data:** schedule grid + each admin table.
**Steps:** Screen-reader pass asserting row/column header announcement on cell navigation; verify one consistent semantic model per component.
**Expect:** Commit to one model per component — semantic `<table>` with proper `<th scope>` for static tables, or a complete, correct ARIA grid for interactive ones. Never a partial mix.
**iSched:** OBSERVED the inconsistent mix. **Decide:** SP-REQ.
**Impact:** the product's densest, most important screen is hardest to read non-visually. **Sec:** none.
**Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** none.

#### QA-A11Y-013 · Live regions used correctly and sparingly
**Class:** OBSERVED → SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** Medium · **Level:** Accessibility, Component · **Auto:** Med · **Env:** A11Y · **Own:** Design system · **Dep:** QA-A11Y-004
**Refs:** loading banners, sync indicators, real-time picklist updates · **Ev:** 09-responsive RA-18 (4 `aria-live` regions exist; purpose unknown)
**Risk:** Either nothing is announced, or a live picklist floods the user with continuous announcements.
**Pre:** n/a. **Data:** loading, error, and live-update scenarios.
**Steps:** Screen-reader pass across loading, error, success, and a simulated live picklist.
**Expect:** `polite` for routine status, `assertive` reserved for errors and turn-critical alerts; announcements are throttled and meaningful; loading states announce start and completion, not every intermediate tick.
**iSched:** OBSERVED regions exist; behaviour UNRESOLVED (#67). **Decide:** SP-REQ.
**Impact:** silence or overwhelming noise. **Sec:** none. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** #67.

#### QA-A11Y-014 · Timed workflows and accessibility
**Class:** INFERRED → SP-REQ · **Sev:** High · **Pri:** pre-beta · **Like:** High · **Level:** Accessibility, Playwright · **Auto:** Med · **Env:** A11Y, LIVE-SIM · **Own:** Picklist · **Dep:** QA-PICK-006, QA-A11Y-013
**Refs:** picklist turn timers, session/idle timeout · **Ev:** 07-picklist §2 (per-pick time budget inferred); 09-responsive RA-18
**Risk:** A user relying on assistive technology cannot complete a timed pick before it expires — a real exclusion risk in the product's signature feature.
**Pre:** Timed turn active. **Data:** `LIVE-SIM`.
**Steps:** Complete a timed pick using a screen reader and keyboard only; measure time needed against the allowance; test any extension mechanism.
**Expect:** Remaining time is announced at meaningful intervals (not continuously); an extension is available and reachable by keyboard; the time allowance is validated as achievable via assistive technology, not just by a sighted mouse user.
**iSched:** INFERRED that timers exist; no timer UI was ever observed.
**Decide:** SP-REQ. **Impact:** systematic exclusion from a core workflow. **Sec:** none.
**Audit:** extensions logged. **Notify:** none. **Recover:** extension. **Open:** #51.

#### QA-A11Y-015 · Responsive layout: tables scroll within their own container
**Class:** OBSERVED → SP-IMP · **Sev:** Medium · **Pri:** pre-beta · **Like:** High · **Level:** Playwright, Accessibility · **Auto:** High · **Env:** A11Y · **Own:** Frontend · **Dep:** QA-SCH-014
**Refs:** Contacts and all admin tables · **Ev:** 09-responsive RA-03 / F-05 (**270px page-level overflow** at phone width, `body` `overflow-x: visible`, no scroll affordance)
**Risk:** The whole page scrolls sideways; users never discover the cut-off columns and actions.
**Pre:** Phone width. **Data:** every data table.
**Steps:** At each breakpoint, assert `document.documentElement.scrollWidth <= innerWidth`; assert wide tables scroll within their own container; verify a visible scroll affordance; verify the scroll container is keyboard-reachable and focusable.
**Expect:** No page-level horizontal scroll at any supported width; wide tables scroll internally with a visible cue and keyboard access.
**iSched:** OBSERVED the failure concretely, with measurements. **Decide:** SP-IMP.
**Impact:** actions unreachable on mobile. **Sec:** none. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** #66.

#### QA-A11Y-016 · Responsive: navigation, orientation, touch targets, zoom, reflow
**Class:** OBSERVED (mixed) → SP-REQ · **Sev:** Medium · **Pri:** pre-beta · **Like:** High · **Level:** Playwright, Accessibility, Manual · **Auto:** Med · **Env:** A11Y · **Own:** Frontend · **Dep:** QA-A11Y-015
**Refs:** app shell, calendar grids, toolbars, modals · **Ev:** 09-responsive RA-01 (sidebar→hamburger breakpoint works), RA-02 (calendar shrinks to fit but becomes very dense), RA-05 (toolbars wrap), RA-18 (zoom/reflow never tested)
**Risk:** Small touch targets, unreadable dense calendars, clipped modals, orientation-change layout breaks, or loss of content at 400% zoom.
**Pre:** Phone/tablet/desktop; both orientations. **Data:** all major screens.
**Steps:** 1) Verify hamburger navigation is fully keyboard- and screen-reader-operable when opened. 2) Measure touch targets (≥44×44 CSS px). 3) Rotate orientation mid-task. 4) Zoom to 200% and 400% and assert reflow without loss of content or function. 5) Verify modals are not clipped and are dismissible on small screens. 6) Verify the on-screen keyboard does not obscure the focused input.
**Expect:** All pass; the calendar offers a usable narrow-screen presentation rather than only shrinking; no content or functionality is lost at 400% zoom.
**iSched:** OBSERVED a working breakpoint and graceful wrapping (strengths), plus very dense phone calendars; zoom/reflow UNRESOLVED (#70).
**Decide:** SP-REQ. **Impact:** mobile users — a core audience for a scheduling product — are underserved.
**Sec:** none. **Audit:** none. **Notify:** none. **Recover:** n/a. **Open:** #70, #65.

---

## 14. Prioritization summary tables

**Total cases: 175** across 13 categories (QA-TEN 12, QA-AUTH 14, QA-SCH 16, QA-REQ 14, QA-OPP 12, QA-PICK 17, QA-RPT 12, QA-NOT 12, QA-DATE 11, QA-CON 14, QA-SEC 14, QA-PERF 11, QA-A11Y 16).

### 14.1 MVP blockers (must pass before first production use)

| QA ID | Title | Category | Owning domain |
|---|---|---|---|
| QA-TEN-003 | Per-membership role resolution | Tenancy | Identity/AuthZ |
| QA-TEN-005 | Explicit, server-validated org context | Tenancy | Platform |
| QA-TEN-006 | Cross-tenant IDOR sweep | Tenancy | Platform |
| QA-TEN-012 | Authorization not UI-only | Tenancy | Platform |
| QA-AUTH-004 | Reset token single-use/expiring | Identity | Identity |
| QA-AUTH-005 | Deactivated user, live session | Identity | Identity |
| QA-AUTH-012 | Anti-forgery on all mutations | Security | Platform |
| QA-AUTH-013 | Session cookie flags | Security | Platform |
| QA-SCH-001 | Incomplete-schedule publication gate | Scheduling | Scheduling |
| QA-SCH-002 | Publication prerequisites re-checked | Scheduling | Scheduling |
| QA-SCH-003 | Overlapping assignments blocked | Scheduling | Scheduling |
| QA-SCH-004 | Overnight shift correctness | Scheduling | Scheduling |
| QA-SCH-005 | Rest/max-hours on every path | Scheduling | Scheduling |
| QA-SCH-006 | Qualification enforcement | Scheduling | Scheduling |
| QA-SCH-008 | Concurrent cell editing | Concurrency | Scheduling |
| QA-SCH-009 | Concurrent publication | Concurrency | Scheduling |
| QA-SCH-015 | Every mutation audited | Audit | Platform |
| QA-SCH-016 | Destructive bulk-action gating | Scheduling | Scheduling |
| QA-REQ-001 | Deadline enforced server-side | Requests | Requests |
| QA-REQ-008 | Concurrent last-slot approval | Concurrency | Requests |
| QA-REQ-010 | Vacation transfer idempotent | Requests | Requests |
| QA-OPP-001 | Simultaneous opportunity acceptance | Concurrency | Scheduling |
| QA-OPP-002 | Ineligible claimant blocked | Scheduling | Scheduling |
| QA-OPP-003 | Claim rule violations blocked | Scheduling | Scheduling |
| QA-OPP-008 | Duplicate acceptance idempotency | Concurrency | Platform |
| QA-OPP-009 | Swap counterpart confirmation | Scheduling | Scheduling |
| QA-OPP-010 | Swap re-validated at acceptance | Scheduling | Scheduling |
| QA-OPP-011 | Swap atomicity | Concurrency | Platform |
| QA-OPP-012 | Cross-tenant acceptance blocked | Tenancy | Platform |
| QA-PICK-003 | "Add" must stage, not commit | UX safety | Frontend |
| QA-PICK-005 | Two users, same room | Concurrency | Picklist |
| QA-PICK-006 | Selection after turn expiry | Concurrency | Picklist |
| QA-PICK-007 | Advancement, skips, exclusions | Picklist | Picklist |
| QA-PICK-012 | Connection loss/reconnection | Realtime | Frontend |
| QA-PICK-016 | Results sync exactly once | Integration | Picklist |
| QA-PICK-017 | Patient-information boundary | Privacy | Privacy |
| QA-RPT-010 | Cross-tenant document download | Security | Documents |
| QA-NOT-006 | No delivery to inactive/wrong tenant | Notifications | Notifications |
| QA-NOT-009 | Notification only after commit | Integrity | Platform |
| QA-NOT-010 | Jobs exactly-once in effect | Background | Platform |
| QA-DATE-001 | One canonical date representation | Platform | Platform |
| QA-DATE-002 | DST gap/repeat correctness | Platform | Platform |
| QA-DATE-004 | Org vs browser timezone | Platform | Platform |
| QA-CON-001 | Optimistic concurrency everywhere | Concurrency | Platform |
| QA-CON-002 | Period-scoped serialisation | Concurrency | Scheduling |
| QA-CON-003 | Idempotency keys on mutations | Concurrency | Platform |
| QA-CON-004 | Atomic scarce-resource contention | Concurrency | Platform |
| QA-CON-009 | Job retry safety for bulk writes | Concurrency | Platform |
| QA-CON-010 | Partial transaction handling | Integrity | Platform |
| QA-SEC-001 | No third-party avatar request (**SP-HR-1**) | Privacy | Privacy |
| QA-SEC-002 | Third-party host regression guard (**SP-HR-1**) | Privacy | Privacy |
| QA-SEC-003 | No user-derived identifier off-platform (**SP-HR-1**) | Privacy | Privacy |
| QA-SEC-004 | No PII-bearing analytics/replay | Privacy | Privacy |
| QA-SEC-005 | No sensitive data in URLs/logs | Security | Platform |
| QA-SEC-006 | Patient-information boundary | Privacy | Privacy |
| QA-SEC-008 | Server-side authz route sweep | Security | Platform |
| QA-SEC-011 | Cookie protections | Security | Platform |
| QA-SEC-012 | Stored XSS via rich content | Security | Platform |
| QA-PERF-001 | One action, one request (**SP-HR-2**) | Performance | Frontend/Platform |
| QA-PERF-002 | Request budget in CI (**SP-HR-2**) | Performance | Frontend |
| QA-A11Y-001 | Visible focus indicator (**SP-HR-3**) | Accessibility | Design system |
| QA-A11Y-002 | Icon-only accessible names (**SP-HR-4**) | Accessibility | Design system |
| QA-A11Y-003 | Keyboard-operable workflows (**SP-HR-5**) | Accessibility | Frontend |
| QA-A11Y-004 | Status/error announcement (**SP-HR-6**) | Accessibility | Design system |
| QA-A11Y-005 | Labels and required fields | Accessibility | Design system |
| QA-A11Y-007 | Modal semantics + focus restoration | Accessibility | Design system |
| QA-A11Y-009 | No keyboard traps | Accessibility | Frontend |

**MVP blocker count: 67.**

### 14.2 Critical tenant-isolation cases
QA-TEN-003, QA-TEN-004, QA-TEN-005, QA-TEN-006, QA-TEN-010, QA-TEN-012, QA-OPP-012, QA-RPT-006, QA-RPT-010, QA-NOT-006, QA-SEC-008. *(All require `MULTI`; none may ever run against production.)*

### 14.3 Critical privacy and security cases
QA-SEC-001, QA-SEC-002, QA-SEC-003 (**SP-HR-1** trio), QA-SEC-004, QA-SEC-005, QA-SEC-006, QA-SEC-008, QA-SEC-010, QA-SEC-011, QA-SEC-012, QA-SEC-014, QA-AUTH-004, QA-AUTH-010, QA-AUTH-012, QA-PICK-017, QA-DATE-008, QA-RPT-008.

### 14.4 Critical concurrency cases
QA-CON-001, QA-CON-002, QA-CON-003, QA-CON-004, QA-CON-009, QA-CON-010, QA-SCH-008, QA-SCH-009, QA-REQ-008, QA-OPP-001, QA-OPP-004, QA-OPP-011, QA-PICK-005, QA-PICK-006, QA-PICK-011, QA-NOT-010.

### 14.5 Critical scheduling-integrity cases
QA-SCH-001, QA-SCH-003, QA-SCH-004, QA-SCH-005, QA-SCH-006, QA-SCH-011, QA-SCH-012, QA-SCH-015, QA-SCH-016, QA-REQ-010, QA-OPP-010, QA-PICK-016, QA-DATE-002, QA-DATE-010, QA-DATE-011.

### 14.6 Critical accessibility cases
QA-A11Y-001 (**SP-HR-3**), QA-A11Y-002 (**SP-HR-4**), QA-A11Y-003 (**SP-HR-5**), QA-A11Y-004 (**SP-HR-6**), QA-A11Y-005, QA-A11Y-007, QA-A11Y-009, QA-A11Y-014.

### 14.7 Pre-beta requirements (beyond MVP blockers)
QA-TEN-001, QA-TEN-002, QA-TEN-004, QA-TEN-007, QA-AUTH-001, QA-AUTH-003, QA-AUTH-006, QA-AUTH-007, QA-AUTH-010, QA-SCH-007, QA-SCH-011, QA-REQ-002, QA-REQ-003, QA-REQ-004, QA-REQ-006, QA-REQ-007, QA-REQ-009, QA-REQ-011, QA-REQ-012, QA-OPP-004, QA-OPP-005, QA-OPP-007, QA-PICK-001, QA-PICK-002, QA-PICK-004, QA-PICK-008, QA-PICK-009, QA-PICK-010, QA-PICK-011, QA-PICK-013, QA-PICK-014, QA-RPT-001, QA-RPT-002, QA-RPT-008, QA-NOT-001, QA-NOT-002, QA-NOT-003, QA-NOT-008, QA-NOT-012, QA-DATE-003, QA-DATE-005, QA-DATE-006, QA-DATE-010, QA-DATE-011, QA-CON-005, QA-CON-006, QA-CON-007, QA-CON-008, QA-CON-011, QA-SEC-007, QA-SEC-014, QA-PERF-005, QA-PERF-007, QA-PERF-009, QA-A11Y-006, QA-A11Y-008, QA-A11Y-010, QA-A11Y-011, QA-A11Y-012, QA-A11Y-013, QA-A11Y-014, QA-A11Y-015, QA-A11Y-016.

### 14.8 Deferred / post-MVP
QA-AUTH-014 (multi-device session management), QA-RPT-007 (export failure polish), QA-RPT-011 (retention/GC), QA-RPT-012 (document search), QA-DATE-009 (historical timezone-rule changes), QA-PERF-010 (long-session memory).

### 14.9 Tests requiring dedicated environments

| Environment | Purpose | Cases |
|---|---|---|
| `MULTI` | ≥2 tenants, one shared user with differing roles | QA-TEN-002..012, QA-AUTH-006/007/009/010, QA-OPP-012, QA-RPT-006/010, QA-NOT-006, QA-SEC-008/013/014 |
| `CONC` | 2+ genuinely concurrent authenticated sessions | QA-TEN-004, QA-AUTH-003/005/006/014, QA-SCH-008/009, QA-REQ-005/008/011/013, QA-OPP-001/004/005/010, QA-PICK-005/009/011/013, QA-CON-001..011 |
| `LIVE-SIM` | Simulated live picklist with controllable clock and network | QA-PICK-001/004..014/016, QA-A11Y-014 |
| `PERF` | Load/scale harness with instrumented telemetry | QA-RPT-003/012, QA-NOT-004, QA-SCH-014, QA-PERF-003..011 |
| `A11Y` | Screen readers, forced-colors, zoom, real devices | QA-A11Y-001..016, QA-AUTH-002, QA-CON-011 |
| `DR` | Restore/migration rehearsal environment | QA-CON-012, QA-CON-013, QA-CON-014 |

### 14.10 Tests that must NEVER run against production

**Every case in this catalogue is a SchedulePoint test.** None may be executed against ischedule.MD, and the following classes must additionally never run against **any** production environment, including SchedulePoint's own:

- All tenant-isolation and IDOR cases (QA-TEN-002..012, QA-OPP-012, QA-RPT-006/010, QA-SEC-008) — they deliberately attempt unauthorized access.
- All destructive and recovery cases (QA-SCH-016, QA-CON-012/013/014, QA-RPT-011).
- All concurrency-race cases (QA-CON-004, QA-OPP-001, QA-PICK-005, QA-REQ-008) — they deliberately create contention on live records.
- All notification and messaging cases (QA-NOT-001..012, QA-SEC-013) — they would contact real people.
- All load/performance cases (QA-PERF-003..011).
- All malicious-input cases (QA-RPT-008, QA-SEC-012).
- All impersonation cases (QA-AUTH-010).

---

## 15. Contradictions in the evidence base

Conflicting evidence is recorded, not silently resolved.

### C-01 · Role model: three access levels vs. six
- **Conflict:** 01-app §5 documented three Access Levels (Staff, Scheduler, Locum) from one page of the users table; 02-role §5 found **six** (adding View, Telecom, Genius) via full pagination plus a dropdown-option read.
- **Reports:** 01-application-map, 02-role-permission-matrix.
- **Status:** **Resolved by supersession** — Phase 1's table is explicitly marked superseded. Recorded here as a *methodology* finding: partial enumeration produced a confidently-wrong model, corrected only by exhaustive pagination.
- **Implementation impact:** low (the corrected model is authoritative).
- **Recommended decision:** SchedulePoint defines its own role model; treat neither as a specification. **Blocks product definition:** no. **Blocks architecture:** no.
- **Future test:** none — but adopt the lesson: enumerate reference data exhaustively, never from one page.

### C-02 · Permission flags vs. actual capability
- **Conflict:** ADM-05 exposes `Picklist Admin` as a per-user permission flag, yet the reviewing account had `Picklist Admin: No` while retaining **full** Picklist Manager and Dashboard access (02-role §5).
- **Reports:** 02-role-permission-matrix §5.
- **Status:** **Genuine unresolved contradiction.** Either the flag grants something narrower than its name implies, or it is vestigial, or enforcement is elsewhere. Unresolved-questions #20.
- **Implementation impact:** **high** — it is unsafe to model SchedulePoint's permissions on a scheme whose own flags demonstrably do not gate the capability they name.
- **Recommended decision:** SchedulePoint ships **no vestigial permission flags** (QA-AUTH-007). Every flag must have a tested, observable capability difference or must not exist.
- **Blocks product definition:** no. **Blocks architecture:** **yes, partially** — the permission model must be designed independently rather than mirrored.
- **Future test:** QA-AUTH-007.

### C-03 · Two withdrawal surfaces, one or two records?
- **Conflict:** WF-10 shows a per-row DELETE on the My Requests panel (present even on APPROVED rows); WF-09 shows a Remove action in the Vacation grid's badge modal. Whether these act on the same underlying record is unknown (unresolved #31).
- **Reports:** 03-user-workflows WF-09/WF-10; 06-requests LC-01/LC-02.
- **Status:** **Unresolved ambiguity**, compounded by LC-02's creation surface never being located.
- **Implementation impact:** **medium** — it is unclear whether the source models one request entity with two views, or two distinct entities.
- **Recommended decision:** SchedulePoint models **one request entity** with one canonical lifecycle and multiple views over it; every view exposes the same state machine and the same withdrawal semantics.
- **Blocks product definition:** **yes, mildly** — the request domain model must be decided deliberately, not inferred.
- **Future test:** QA-REQ-006, QA-REQ-011.

### C-04 · Real-time push vs. polling for picklist state
- **Conflict:** 07-picklist §4 concluded the staleness indicator ("last synced N minutes ago") plus a manual refresh button was "evidence against a fully live push model." 10-technical §8 then confirmed a SignalR hub named `picklist` **connects on every page load**. These are in tension: a genuine push channel exists, yet the UI presents a poll-and-refresh affordance.
- **Reports:** 07-picklist-system §4; 10-technical-observations §8.
- **Status:** **Genuine contradiction, unresolved.** Plausible reconciliations (none confirmed): the hub carries only picklist-turn events while list metadata is polled; or the hub exists but the Picklist Manager list view does not subscribe to it; or push exists and the refresh control is legacy.
- **Implementation impact:** **high for architecture** — it determines whether SchedulePoint needs push, polling, or both, and where.
- **Recommended decision:** SchedulePoint chooses **push for turn-critical picklist state** (where staleness has real consequences) and **explicit user-initiated refresh for administrative list views**, documented as a deliberate split rather than an accident. Real-time connections are page-scoped (QA-PERF-006).
- **Blocks product definition:** no. **Blocks architecture:** **yes** — this decision must be made explicitly before the picklist is built.
- **Future test:** QA-PICK-012, QA-PICK-013, QA-PERF-006, QA-PERF-011.

### C-05 · Instant-commit "Add" vs. explicit-Save forms
- **Conflict:** Nearly every form in the source (Build Setup, Pattern/Staff Rule Setup, Valid Group Setup, Group Settings) has explicit Save/Cancel. But the picklist "Add Room" control **committed a live record on a single click** with no draft stage (07-picklist §0). The source is internally inconsistent about when a click persists data.
- **Reports:** 07-picklist-system §0; 05-scheduling-engine §1.
- **Status:** **Confirmed inconsistency in the source** (evidenced by an actual incident, not inference).
- **Implementation impact:** **high for UX safety** — this inconsistency directly caused the only safety incident across twelve research phases.
- **Recommended decision:** SchedulePoint enforces a single, universal rule: **no control labelled Add/New/Create persists anything before an explicit Save.** Enforced by component contract and tested for every such control (QA-PICK-003).
- **Blocks product definition:** no. **Blocks architecture:** no. **Blocks design-system definition:** **yes**.
- **Future test:** QA-PICK-003, QA-CON-005.

### C-06 · Contacts roster size vs. Users roster size
- **Conflict:** For the same group, Contacts showed 66 rows while the Users admin table showed 94 (08-supporting SM-03). An undocumented filter exists.
- **Reports:** 08-supporting-modules SM-03; 02-role §5.
- **Status:** **Unresolved** (#60). Most plausible: functional/`View`/`Telecom` accounts are excluded from the directory.
- **Implementation impact:** **medium** — it implies "user," "staff member," and "directory contact" are three different concepts in the source, only one of which is visible.
- **Recommended decision:** SchedulePoint distinguishes **person accounts**, **functional/shared accounts**, and **placeholder assignable slots** explicitly in the data model (a distinction 02-role §6 already evidenced), and defines directory membership by an explicit rule rather than an emergent filter.
- **Blocks product definition:** **yes, mildly** — the identity model needs an explicit decision.
- **Future test:** QA-SEC-014, QA-AUTH-011.

### C-07 · Mobile reflow: "no visible reflow" vs. working breakpoints
- **Conflict:** 01-app §4 recorded that a phone-viewport resize "did not visibly reflow" the layout (inconclusive). 09-responsive RA-01/RA-02 later found a genuine sidebar→hamburger breakpoint and measured shrink-to-fit behaviour.
- **Reports:** 01-application-map §4 (Mobile row); 09-responsive-accessibility RA-01/RA-02.
- **Status:** **Resolved in favour of Phase 10**, which used a proper resize methodology and took measurements. Phase 1's entry was explicitly self-labelled inconclusive.
- **Implementation impact:** low.
- **Recommended decision:** treat Phase 10's measurements as authoritative. **Blocks:** nothing.
- **Future test:** QA-A11Y-015, QA-A11Y-016 (including the still-open exact breakpoint, #65).

---

## 16. Gaps carried forward (not closed by this phase, by instruction)

These remain **UNRESOLVED** for ischedule.MD and are addressed in SchedulePoint only as forward-looking test requirements:

| Gap | Source status | SchedulePoint coverage |
|---|---|---|
| Live picklist execution (current picker, timers, room selection, confirmation, failure/retry) | UNRESOLVED — no picklist was ever active across twelve phases | QA-PICK-005..014, QA-A11Y-014 |
| Real-time concurrency (connection loss, multi-tab, concurrent selection, stale state) | UNRESOLVED — required a live draft plus a second session | QA-PICK-012/013, QA-CON-004, QA-PERF-006 |
| Report-dialog internals (five "Create X Report" types, incl. DayXShift) | UNRESOLVED — dialogs never opened | QA-RPT-001..007 |
| The two unopened PDFs in the documents library | UNRESOLVED — never opened, by instruction, in every phase | none — deliberately out of scope |
| Form validation and error presentation | UNRESOLVED — no form was ever submitted | QA-A11Y-004/005, QA-SEC-007 |
| Zoom and reflow behaviour | UNRESOLVED — never tested | QA-A11Y-016 |
| Session and idle timeout duration | UNRESOLVED — session never expired | QA-AUTH-001/002 |
| Anti-forgery mechanics | UNRESOLVED — no POST was ever triggered | QA-AUTH-012 |
| Date-format inconsistency (three formats across sibling endpoints) | **OBSERVED** in requests; response-side consistency UNRESOLVED | QA-DATE-001 |
| SignalR message payloads | UNRESOLVED — hub confirmed, messages never observed | QA-PICK-012, C-04 |
| Duplicate-request root cause | **OBSERVED** effect (~25–40×); cause UNRESOLVED | QA-PERF-001..004 |
| Tour-library behaviour | UNRESOLVED — library loads, never fires | none — no SchedulePoint requirement derives from it |
| LC-02 request-creation surface | UNRESOLVED after four phases of search | QA-REQ-003, C-03 |
| Lower-privileged role views | UNRESOLVED — no second-role account ever existed | QA-TEN-012, QA-AUTH-007, QA-SEC-014 |

---

## 17. Safety and boundary notes for this phase

- **No ischedule.MD navigation was performed during Phase 12.** The catalogue was derived entirely from the eleven saved reports and their companion indexes.
- Nothing was created, modified, submitted, downloaded, uploaded, imported, exported, printed, or deliberately invalidated on the source site.
- No edge case was provoked on the source site; every case is written as a future SchedulePoint test.
- No credentials, tokens, cookies, authorization headers, patient information, private URLs, live identifiers, or unnecessary personal data appear in this report. Where an identifier pattern is referenced it uses the sanitized placeholders established in Phase 11 (`GROUP_ID`, `USER_ID`, `PICKLIST_ID`, `YYYY-MM-DD`).
- **No safety incident occurred in this phase.**

## 18. Evidence and follow-up

- Cases merge by stable QA ID; every case cross-references the source report and section that evidences it.
- The Phase 7 checklist inconsistency was corrected in `MASTER-CHECKLIST.md` as part of this phase (five documented lifecycles, three Mermaid diagrams, with the two deliberate omissions explained).
- Findings merged into [source-page-index.md](source-page-index.md), [unresolved-questions.md](unresolved-questions.md), [evidence-register.md](evidence-register.md), [manifest.json](manifest.json).
- **After Phase 12, broad research against ischedule.MD is closed.** Any future source-site interaction requires a specific, separately-authorized comparison need.
