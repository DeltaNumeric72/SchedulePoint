# Independent Codex Architecture Review

**Review date:** 2026-07-31  
**Architecture checkpoint reviewed:** `55bb7d81a170541f4dd62249b668df4ac9a5d6e2`  
**Reviewer posture:** independent principal software architect, security reviewer, and healthcare-software systems reviewer  
**Overall recommendation:** **REDESIGN REQUIRED**

## 1. Executive conclusion

The proposal has a sound high-level direction: a modular monolith, PostgreSQL, an outbox, immutable schedule versions, server-authoritative picklist state, a solver-neutral scheduling boundary, first-class entitlements, and an ingestion privacy boundary are all appropriate architectural instincts. The package is unusually traceable and candid about unproven gates.

It is not, however, safe to approve. Four defects permit severe tenant, schedule-integrity, picklist-integrity, or privacy failure. Eleven further defects prevent major production capabilities from being delivered without material redesign. The documentation validator proves document shape and vocabulary; it does not prove that the stated transactions, constraints, runtime boundaries, or privacy controls can work.

All 58 authoritative capabilities are named in the proposal, but naming is not architectural support. At least twenty-one capabilities have a direct design gap, and many others inherit an unsafe cross-cutting tenancy, authorization, event, or deployment mechanism. Automated scheduling remains mandatory and manual scheduling is correctly limited to fallback, override, fixed-assignment input, and recovery. `G-PROD` and `G-CONN` remain unpassed, as they must. Optional customer enablement is generally kept separate from product capability, but the unresolved locum-billing rule is an exception.

### Finding count

| Severity | Count |
|---|---:|
| Critical | 4 |
| High | 11 |
| Medium | 10 |
| Low | 2 |
| **Total** | **27** |

### Recommendation upgrade conditions

`REDESIGN REQUIRED` may be upgraded to `APPROVED AFTER CHANGES` only after all Critical and High findings are resolved in revised architecture documents and ADRs, the affected capability and gate mappings are corrected, the product owner disposes of `PO-DEC-10`, and a new independent review finds no remaining severe isolation, privacy, concurrency, or irreversible-integrity path. It may be upgraded to `APPROVED` only after those corrections are verified, every architecture-blocking product decision is explicitly approved or its pending default is clearly isolated, and the architecture has executable design evidence for tenant isolation, schedule publication, picklist concurrency, solver feasibility, and de-identification. This review does not approve any ADR or gate.

## 2. Scope, method, and preflight

The authoritative scope was taken from [report 19](../../../schedulepoint-research/reports/19-schedulepoint-production-capability-baseline.md); approved product decisions from [reports 20](../../../schedulepoint-research/reports/20-contradiction-resolution-register.md) and [24](../../../schedulepoint-research/reports/24-production-completeness-gates.md); automated-scheduling requirements from [report 21](../../../schedulepoint-research/reports/21-automated-scheduling-production-requirements.md); and traceability obligations from [report 22](../../../schedulepoint-research/reports/22-functional-traceability-matrix.md). Reports 11, 17, 18, 23, unresolved questions, and the master checklist were independently compared with the proposal. Every file under `docs/architecture/`, including all numbered documents, ADRs, diagrams, drafts, references, the manifest, and the validator, was reviewed.

No source-product site was visited and no source behavior was invented. Technical browsing was restricted to official primary documentation needed to verify PostgreSQL, OR-Tools, and Web Push claims.

### Preflight record

| Check | Result |
|---|---|
| Git checkpoint | `55bb7d81a170541f4dd62249b668df4ac9a5d6e2` |
| Working tree before review | Clean |
| Existing research validator | Passed |
| `python3 docs/architecture/validate.py` | Passed, 39/39 assertions |
| Numbered architecture documents | 19 |
| Proposed ADRs | 15; all `PROPOSED` |
| Diagram sources | 5 Mermaid files |
| Draft repository instructions | 2 files |
| Architecture manifest | Present |
| Capability mappings | 58 unique capability entries |
| Independent report-19 capability count | 58 unique capability entries |
| Sandbox tests in report 18 | 39 unique test IDs; report prose incorrectly says 36 (CAR-026) |

## 3. Findings

### Critical

#### CAR-001 — Session-global active group can redirect a valid command to the wrong schedule

- **Stable review ID:** CAR-001
- **Severity:** Critical
- **Title:** Session-global active group can redirect a valid command to the wrong schedule
- **Exact affected file:** `docs/architecture/05-tenancy-entitlements-authorization.md`; `docs/architecture/01-architecture-overview.md`; `docs/architecture/14-security-and-privacy.md`
- **Affected section:** 05 §4.1 “Tenant context resolution”; 01 §3 invariant I-01; 14 threat T-01
- **Affected ADR:** ADR-0003, ADR-0004
- **Affected capability IDs:** CAP-001, CAP-002, CAP-003, CAP-006, CAP-014, CAP-019, CAP-031
- **Affected decision IDs:** PO-DEC-02, PO-DEC-06
- **Affected gates:** G-ARCH, G-BETA, G-PROD
- **Issue:** The session stores one mutable `organizationId`/`activeGroupId`, while commands intentionally ignore client context. That prevents forged tenant IDs but creates a confused-deputy path across tabs and long-lived forms. It contradicts the authoritative `QA-TEN-004` outcome: a context switch must be detected or a tab-local organization/group must be validated, never silently substituted. A user may legitimately belong to multiple groups even if multi-organization accounts are deferred.
- **Realistic failure scenario:** A scheduler opens a draft for Group A, then switches to Group B in a second tab. Submitting the still-valid form in the first tab resolves the current session as Group B. If object identifiers are not globally bound and revalidated, a manual assignment, publication, or picklist action is written against Group B or fails in a misleading way. In the worst case a wrong schedule is published or a clinical work item is allocated in the wrong group.
- **Why existing validation did not catch it:** The validator checks that tenant-context language exists; it does not simulate multiple tabs, session mutation, or object-to-context binding.
- **Recommended correction:** Redesign command context as an immutable, request-scoped tuple that includes the expected organization/group and session context version. Validate that tuple against server-side membership and the targeted aggregate, and reject stale context rather than silently substituting the newest session selection. WebSocket commands need the same context/version binding.
- **Regression or architecture test:** Extend QA-TEN-004/SBX-004 with two browser contexts sharing one session: switch groups in one, then submit mutations, publication, report, upload, job, and WebSocket commands from the stale context. Every stale command must fail before any write or event.
- **Blocks architecture approval:** Yes
- **Blocks implementation:** Yes, for any tenant/group-scoped write path
- **Blocks beta:** Yes
- **Blocks production:** Yes
- **Confidence:** High

#### CAR-002 — Session-scoped RLS variables can survive pooled-connection reuse

- **Stable review ID:** CAR-002
- **Severity:** Critical
- **Title:** Session-scoped RLS variables can survive pooled-connection reuse
- **Exact affected file:** `docs/architecture/02-technology-stack.md`; `docs/architecture/05-tenancy-entitlements-authorization.md`; `docs/architecture/decisions/ADR-0003-database-and-tenancy-strategy.md`
- **Affected section:** 02 §2.3; 05 §4.3 “Database enforcement”; ADR-0003 §§Decision and Security consequences
- **Affected ADR:** ADR-0003
- **Affected capability IDs:** CAP-003 and every tenant-scoped capability
- **Affected decision IDs:** PO-DEC-02, PO-DEC-04
- **Affected gates:** G-ARCH, G-PROD
- **Issue:** The design says the RLS context is set on connection checkout and cleared on release. That is session state. A missed reset, cancellation, pool error, or query outside the intended wrapper can reuse the preceding tenant. PostgreSQL documents that `SET LOCAL` lasts only to transaction end, while ordinary `SET` persists at session scope; transaction-scoped settings are the safe primitive for pooled RLS context ([PostgreSQL `SET`](https://www.postgresql.org/docs/current/sql-set.html)). The architecture does not require every tenant query to execute in an explicit transaction with `SET LOCAL`, nor prevent the application role from bypassing RLS.
- **Realistic failure scenario:** A worker checks out a connection for Organization A, sets the tenant, then exits through an exception before clearing it. The pool hands the connection to Organization B. A diagnostic, ORM preflight query, or code path that runs before B's context setter reads or updates A's rows.
- **Why existing validation did not catch it:** The validator matches the phrases “RLS” and “connection checkout”; it neither evaluates PostgreSQL setting lifetime nor exercises pool error paths.
- **Recommended correction:** Require one database unit-of-work wrapper that begins a transaction, executes `set_config(..., true)`/`SET LOCAL` before any tenant query, verifies the context, and ends it on commit or rollback. Deny tenant-table access outside that wrapper, use a non-owner `FORCE ROW LEVEL SECURITY` role, define privileged maintenance roles separately, and test pool cancellation and reuse.
- **Regression or architecture test:** A concurrency harness should force exceptions, cancellations, timeouts, nested transactions, and pool reuse across two organizations while continuously probing every tenant table under application and worker roles. Any row from the wrong tenant is a hard failure.
- **Blocks architecture approval:** Yes
- **Blocks implementation:** Yes, for persistence infrastructure
- **Blocks beta:** Yes
- **Blocks production:** Yes
- **Confidence:** High

#### CAR-003 — Picklist selection is not one atomic compare-and-set transition

- **Stable review ID:** CAR-003
- **Severity:** Critical
- **Title:** Picklist selection is not one atomic compare-and-set transition
- **Exact affected file:** `docs/architecture/06-data-architecture.md`; `docs/architecture/10-picklist-and-realtime.md`; `docs/architecture/decisions/ADR-0008-realtime-picklist-transport.md`
- **Affected section:** 06 §§3.5 and 4 invariant D-3; 10 §§4–8; ADR-0008 “Decision”
- **Affected ADR:** ADR-0008, ADR-0009
- **Affected capability IDs:** CAP-030, CAP-031, CAP-032, CAP-033, CAP-034, CAP-060
- **Affected decision IDs:** PO-DEC-18, PO-DEC-19
- **Affected gates:** G-ARCH, G-PROD
- **Issue:** The partial unique index `(picklist_id, work_item_id) WHERE accepted` prevents two claimants from taking the same work item. It does not prevent one turn from accepting two different work items, and D-3 incorrectly describes it as “at most one work item claimed per picklist.” Verification of active participant, timer, proxy, list state, and client version is described separately from insertion; no single conditional update or lock binds them. There is no uniqueness/CAS invariant for one accepted result per turn, no aggregate version predicate, and no coordination rule for multiple timer sweepers or real-time coordinators.
- **Realistic failure scenario:** A physician and proxy act simultaneously and choose different rooms. Both rows satisfy the work-item uniqueness index. A pause or administrator intervention races between authorization and insert, so a selection commits after the turn has advanced. Two coordinators then emit different `TurnResolved`/`TurnStarted` sequences. A reconnecting client cannot determine which ordered history is authoritative.
- **Why existing validation did not catch it:** The validator checks that a uniqueness constraint and “persist then broadcast” are mentioned. It does not prove that the constraint matches the business invariant or that all state predicates share one transaction boundary.
- **Recommended correction:** Redesign the aggregate around an explicit turn identity and monotonic picklist version. One database transaction must conditionally consume exactly one open turn, claim exactly one available item, write the attributed selection and event/outbox records, and advance or pause state. Add database constraints for one accepted selection per turn and one current turn, deterministic timer ownership, event sequence numbers, and idempotency by command ID.
- **Regression or architecture test:** SBX-021–027 must add physician/proxy/admin three-way races, different-item races, pause during commit, duplicate commands, multiple sweepers, reordered events, reconnect after multiple turns, and completion/correction races. Assert one serialized event history and one accepted outcome per turn.
- **Blocks architecture approval:** Yes
- **Blocks implementation:** Yes, for picklist execution
- **Blocks beta:** Yes
- **Blocks production:** Yes
- **Confidence:** High

#### CAR-004 — The ingestion boundary cannot prove that identifying values never enter the platform

- **Stable review ID:** CAR-004
- **Severity:** Critical
- **Title:** The ingestion boundary cannot prove that identifying values never enter the platform
- **Exact affected file:** `docs/architecture/06-data-architecture.md`; `docs/architecture/10-picklist-and-realtime.md`; `docs/architecture/12-integrations-and-ingestion-privacy.md`; `docs/architecture/14-security-and-privacy.md`
- **Affected section:** 06 §§3.5 and 3.7; 10 opening invariant and §2; 12 §§2, 4.1–4.2, 7; 14 §§2–3
- **Affected ADR:** ADR-0011, ADR-0012
- **Affected capability IDs:** CAP-030, CAP-055, CAP-060, CAP-061, CAP-062, CAP-063, CAP-064, CAP-065, CAP-068
- **Affected decision IDs:** PO-DEC-08
- **Affected gates:** G-ARCH, G-CONN, G-PROD
- **Issue:** The data flow is `source → connector adapter → canonical DTO → boundary`. A faulty or compromised adapter can copy a patient name, identifier, or free text into an allowed field such as `externalReference`, `title`, `category`, or `location`; a positive list of field names does not validate semantic content. The raw payload also necessarily reaches transport, parser, process memory, and error paths before the stated boundary, yet proxy/APM/crash-dump/temp-file/dead-letter behavior is not designed. Separately, manual picklist items permit a free-text `description` and “sanitised descriptions,” an assurance no general sanitizer can prove. This contradicts the approved platform-owned boundary and makes the zero-persistence gate non-evidentiary.
- **Realistic failure scenario:** A connector maps `patientName` to the allowed `title`, or a coordinator types a patient name in a manual work-item description. The record passes the key allowlist and is copied into the database, outbox, logs, report, backup, and real-time event. The certification suite reports success because the prohibited source key is absent.
- **Why existing validation did not catch it:** The validator verifies that allowlist and quarantine prose exists. It does not follow values across the pre-boundary execution environment or challenge free text and semantic relabeling.
- **Recommended correction:** Move the trusted boundary before all application observability and durable infrastructure, define a constrained value schema with enumerated or opaque fields, remove unrestricted descriptions/notes from protected work items, and specify a minimal raw-ingress enclave with no body logging, tracing, retries, dumps, or durable queues. Connector certification must include malicious value relabeling and all failure surfaces. If semantic de-identification cannot be proven, reject rather than sanitize.
- **Regression or architecture test:** Expand SBX-029 with canary identifiers in every source field and value, including values placed under allowed keys, malformed encodings, archives, exceptions, timeouts, DLQ paths, traces, metrics, logs, temp storage, quarantine, backups, reports, notifications, and support tooling. Search all storage and telemetry after both success and failure.
- **Blocks architecture approval:** Yes
- **Blocks implementation:** Yes, for any import or protected manual-entry path
- **Blocks beta:** Yes for picklist manual/integrated modes
- **Blocks production:** Yes
- **Confidence:** High

### High

#### CAR-005 — The selected Node.js topology cannot host the selected solver as documented

- **Stable review ID:** CAR-005
- **Severity:** High
- **Title:** The selected Node.js topology cannot host the selected solver as documented
- **Exact affected file:** `docs/architecture/01-architecture-overview.md`; `docs/architecture/02-technology-stack.md`; `docs/architecture/03-system-context-and-containers.md`; `docs/architecture/08-automated-scheduling-engine.md`; `docs/architecture/17-deployment-and-operations.md`
- **Affected section:** 01 §§2–3; 02 §§1 and 2.1; 03 §§2–3; 08 §1; 17 §§1–2
- **Affected ADR:** ADR-0001, ADR-0002, ADR-0006, ADR-0015
- **Affected capability IDs:** CAP-015, CAP-016, CAP-017, CAP-059, CAP-067
- **Affected decision IDs:** PO-DEC-13, PO-DEC-23
- **Affected gates:** G-ARCH, G-PROD
- **Issue:** ADR-0002 selects Node.js/TypeScript “across all four process classes,” and the deployment design says one codebase and one image. ADR-0006 simultaneously states that CP-SAT runs outside Node.js and requires a process boundary. Official OR-Tools distributions support C++, .NET, Java, and Python, not Node.js ([OR-Tools installation guide](https://developers.google.com/optimization/install/)). A logical `SolverPort` does not define the required language runtime, serialization, native library, cancellation channel, image, patching, or security boundary.
- **Realistic failure scenario:** Implementation reaches the solver worker and must introduce an unplanned Python/Java/.NET child process or service. Cancellation and deadlines cannot cross the improvised boundary reliably, native dependencies are absent from the “one image,” deployment health probes are wrong, and the security/observability model no longer matches the approved topology.
- **Why existing validation did not catch it:** It checks that both Node.js and a solver port are named, not whether the official solver has a compatible runtime binding.
- **Recommended correction:** Make an explicit ADR choice among a supported-language solver worker, a separately packaged local subprocess with a versioned protocol, or a different maintained solver with a supported binding. Define image/runtime boundaries, protocol versioning, tenant authentication, cancellation, resource limits, observability, failure isolation, and replacement behavior.
- **Regression or architecture test:** Build a deployment-level spike that serializes a representative problem, starts, cancels, times out, crashes, restarts, and reproduces a solve through the selected supported runtime while preserving tenant and trace context.
- **Blocks architecture approval:** Yes
- **Blocks implementation:** Yes, for automated scheduling and deployment scaffolding
- **Blocks beta:** No if beta explicitly excludes solver execution; otherwise yes
- **Blocks production:** Yes
- **Confidence:** High

#### CAR-006 — The solver contract omits required rule data and overpromises control and explanation

- **Stable review ID:** CAR-006
- **Severity:** High
- **Title:** The solver contract omits required rule data and overpromises control and explanation
- **Exact affected file:** `docs/architecture/06-data-architecture.md`; `docs/architecture/08-automated-scheduling-engine.md`; `docs/architecture/18-capability-traceability.md`
- **Affected section:** 06 §§3.1–3.3 and invariant D-4; 08 §§2–7; 18 CAP-013, CAP-015–017, CAP-059
- **Affected ADR:** ADR-0006
- **Affected capability IDs:** CAP-013, CAP-015, CAP-016, CAP-017, CAP-045, CAP-058, CAP-059, CAP-067
- **Affected decision IDs:** PO-DEC-05, PO-DEC-12, PO-DEC-13, PO-DEC-23
- **Affected gates:** G-ARCH, G-PROD
- **Issue:** `ScheduleProblem.constraints: Constraint[]` is an abstraction, not a versioned rule language or compiler. The data model lacks the traceability document's `membership_work_profiles`, weekday-specific FTE, maximum-assignment classes, and a typed representation for all report-21 rules. It does not define validation/migration of rule expressions or hard/soft conversion. Cooperative cancellation polling cannot interrupt a blocking native solve without a callback or process-control mechanism. Reproducibility records seed/version/hash but not solver parameters, deterministic worker count, native binary/image, compiler version, or environment. “Minimal infeasibility core” via bounded relaxation and per-assignment “dominated alternative” rationales require potentially combinatorial counterfactual solves and have no bounded degraded contract. D-4 also permits only one non-terminal build per period, preventing multiple queued candidates/configurations needed for comparison and progressive work.
- **Realistic failure scenario:** A weekday FTE limit has nowhere canonical to live; an adapter silently treats it as a generic soft constraint. A time-limited CP-SAT run cannot observe the cancellation flag. A retry with the same seed on a new solver image returns a different schedule. An infeasible problem exhausts the explanation budget and produces neither the promised named core nor an explicit degraded result. Administrators cannot audit why a fixed assignment caused infeasibility.
- **Why existing validation did not catch it:** The validator counts mentions of all scheduling concepts but does not check that input fields exist, constraints are typed, cancellation can reach the solver, or explanation/reproducibility claims are operationally achievable.
- **Recommended correction:** Specify a solver-neutral, versioned rule AST and canonical data schema covering every report-21 input; formal hard/soft invariants; compiler validation and migrations; deterministic-run policy and retained executable provenance; an interruptible solve boundary; bounded explanation tiers with honest failure states; and build concurrency keyed to configuration/candidate rather than an entire period.
- **Regression or architecture test:** Create versioned benchmark fixtures for every hard and soft rule class, weekday FTE, qualifications/expiry, locum priority, linked shifts, sequences, templates, call spacing, fixed-lock infeasibility, and fairness. Verify model compilation, hard-constraint non-relaxation, cancellation latency, retry semantics, cross-version reproducibility claims, explanation time bounds, and comparison of concurrent candidates.
- **Blocks architecture approval:** Yes
- **Blocks implementation:** Yes, for solver domain and build persistence
- **Blocks beta:** No if beta remains explicitly manual and this limitation is visible; otherwise yes
- **Blocks production:** Yes
- **Confidence:** High

#### CAR-007 — Assignment constraints make immutable version cloning unsafe or impossible

- **Stable review ID:** CAR-007
- **Severity:** High
- **Title:** Assignment constraints make immutable version cloning unsafe or impossible
- **Exact affected file:** `docs/architecture/06-data-architecture.md`; `docs/architecture/07-schedule-and-publication.md`
- **Affected section:** 06 §§3.3–4, especially D-1; 07 §§1–4
- **Affected ADR:** ADR-0007
- **Affected capability IDs:** CAP-014, CAP-017, CAP-018, CAP-019, CAP-020, CAP-023, CAP-027, CAP-045, CAP-046, CAP-047, CAP-049
- **Affected decision IDs:** None
- **Affected gates:** G-BETA, G-PROD
- **Issue:** Assignments belong to versions, but the exclusion rule prohibits overlapping active assignments for a member without scoping the conflict to a version. Cloning a published version into a draft therefore conflicts with its own identical published assignments unless old rows are marked `superseded`, which would mutate historical truth. Published immutability is prose, not a database rule preventing updates/deletes to assignments, events, or child rows of a published version. The lifecycle also represents `locked` both as a status and `is_locked`, while publication states in the table omit approval/publishing states shown in the state diagram. `assignment_versions` suggests mutable assignments even though a published version is described as immutable.
- **Realistic failure scenario:** An administrator starts a post-publication amendment. Copying unchanged assignments to the new draft violates D-1. A workaround marks the published rows superseded, so historical reports and calendar reconstruction no longer match what staff originally saw. Alternatively, an ORM update modifies a published child row because no database guard forbids it.
- **Why existing validation did not catch it:** It checks for words such as “immutable,” “version,” and “exclusion constraint,” but not whether their scopes are compatible.
- **Recommended correction:** Redesign identity and conflict constraints so candidate versions can coexist while publication selects one current version. Enforce published-graph immutability in the database, distinguish assignment identity from versioned snapshots, define lock as one orthogonal concept, and make publication/supersession constraints complete and deferrable within one transaction.
- **Regression or architecture test:** In a database design test, publish V1, clone it unchanged to V2, amend one assignment, compare both, publish V2, revert by publishing V3, and prove V1/V2 bytes and reports are unchanged. Concurrent V2/V3 publication must yield one current version and one outbox event.
- **Blocks architecture approval:** Yes
- **Blocks implementation:** Yes, for the schedule schema and publication aggregate
- **Blocks beta:** Yes
- **Blocks production:** Yes
- **Confidence:** High

#### CAR-008 — Authorization precedence and freshness are undefined across four layers

- **Stable review ID:** CAR-008
- **Severity:** High
- **Title:** Authorization precedence and freshness are undefined across four layers
- **Exact affected file:** `docs/architecture/05-tenancy-entitlements-authorization.md`; `docs/architecture/06-data-architecture.md`; `docs/architecture/10-picklist-and-realtime.md`
- **Affected section:** 05 §§1, 3, 4.2, 4.4–4.5, 7; 06 §3.1; 10 §§4–5
- **Affected ADR:** ADR-0004, ADR-0005, ADR-0008
- **Affected capability IDs:** CAP-006, CAP-008, CAP-010, CAP-032, CAP-034, CAP-042, CAP-044, CAP-057 and every protected capability
- **Affected decision IDs:** PO-DEC-02, PO-DEC-04, PO-DEC-11, PO-DEC-19
- **Affected gates:** G-ARCH, G-BETA, G-PROD
- **Issue:** The four layers are named but no normative truth table defines precedence. `role_capabilities` grants capabilities while `capability_grants.granted` can apparently grant or deny them; the behavior of explicit deny versus role allow, disabled modules, organization-level roles, module dependencies, suspended memberships, and expired entitlements is unspecified. Background jobs capture context but are not required to reauthorize at execution. WebSockets authorize at connect/subscribe time, so a role, proxy, suspension, or entitlement revocation can remain effective indefinitely. No permission-cache invalidation or authorization-version mechanism exists.
- **Realistic failure scenario:** A scheduler's picklist capability is revoked while a page remains connected. The same socket continues to submit authorized commands because policy was resolved at connect time. A queued export runs after the user's access is removed and writes a downloadable report. An explicit deny is overridden by a role bundle on one path but not another.
- **Why existing validation did not catch it:** The validator verifies the four layer names and deny-by-default language, not a deterministic evaluator or revocation behavior.
- **Recommended correction:** Define one pure, versioned authorization function and complete truth table, including explicit deny semantics, dependency failure, and data-retention behavior for disabled modules. Every HTTP/real-time command and every job execution must evaluate current state against the target object; cached decisions require bounded TTL plus invalidation/version checks. Disconnect or reauthorize live subscriptions on privilege change.
- **Regression or architecture test:** Generate the cross-product of entitlement, module availability, membership state/role, explicit grant/deny, object ownership, impersonation, and proxy state. Run it against HTTP, worker, WebSocket, report download, object storage, and calendar management paths, including revocation during an in-flight session/job.
- **Blocks architecture approval:** Yes
- **Blocks implementation:** Yes, for the policy framework
- **Blocks beta:** Yes
- **Blocks production:** Yes
- **Confidence:** High

#### CAR-009 — Hash-only Web Push registrations cannot be used for delivery

- **Stable review ID:** CAR-009
- **Severity:** High
- **Title:** Hash-only Web Push registrations cannot be used for delivery
- **Exact affected file:** `docs/architecture/06-data-architecture.md`; `docs/architecture/14-security-and-privacy.md`; `docs/architecture/18-capability-traceability.md`
- **Affected section:** 06 §3.1 `push_registrations`; 14 §5; 18 CAP-041
- **Affected ADR:** ADR-0010
- **Affected capability IDs:** CAP-041
- **Affected decision IDs:** PO-DEC-07
- **Affected gates:** G-PROD
- **Issue:** The proposal stores only `token_hash` and states that push tokens are hashed. Web Push requires the application server to retain the subscription endpoint and encryption key material (`p256dh` and `auth`) to send a message; the subscription contains all delivery information ([W3C Push API](https://www.w3.org/TR/push-api/)). A one-way hash can deduplicate or look up a submitted token, but cannot address or encrypt delivery.
- **Realistic failure scenario:** A user consents to push and a registration row is active. When a picklist turn starts, the notification worker has no endpoint or encryption material to contact the push service. The channel silently cannot operate despite CAP-041 being mapped as implemented.
- **Why existing validation did not catch it:** The validator treats “hash” as a security-positive keyword and never checks the delivery protocol's required material.
- **Recommended correction:** Define a provider-specific secret envelope or managed secret reference that is retrievable only by the delivery worker, while separately storing a hash for deduplication. Specify encryption, rotation, invalidation, endpoint redaction, backup handling, and consent/revocation.
- **Regression or architecture test:** A provider-contract test must register, deliver, rotate, invalidate, and revoke a real test subscription; verify that logs/traces never contain endpoint/key material and that a database reader without the delivery role cannot recover it.
- **Blocks architecture approval:** Yes
- **Blocks implementation:** Yes, for push storage and provider boundary
- **Blocks beta:** No if push is explicitly excluded from beta
- **Blocks production:** Yes because CAP-041 is production-required
- **Confidence:** High

#### CAR-010 — Notification retries and escalation can duplicate messages after ambiguous provider outcomes

- **Stable review ID:** CAR-010
- **Severity:** High
- **Title:** Notification retries and escalation can duplicate messages after ambiguous provider outcomes
- **Exact affected file:** `docs/architecture/06-data-architecture.md`; `docs/architecture/11-notifications-and-communications.md`
- **Affected section:** 06 §3.6; 11 §§2, 4–7
- **Affected ADR:** ADR-0009, ADR-0010
- **Affected capability IDs:** CAP-024, CAP-027, CAP-031, CAP-040, CAP-041, CAP-043, CAP-056
- **Affected decision IDs:** PO-DEC-07, PO-DEC-15, PO-DEC-21
- **Affected gates:** G-BETA, G-PROD
- **Issue:** The architecture calls delivery “exactly-once apparent,” but the deduplication key includes `attempt`, so every retry is intentionally a different key. If a provider accepts a message and the response is lost, the worker cannot know whether retry duplicates delivery unless the provider contract supports stable idempotency. Provider callback authentication, replay defense, callback-to-attempt correlation, and reconciliation are absent. Escalation has no explicit acknowledgement/cancellation record or atomic predicate preventing the next step from being sent after acknowledgement. Mandatory safety notices are not normatively separated from preference, quiet-hour, and opt-out rules.
- **Realistic failure scenario:** An SMS provider accepts a picklist-turn alert and times out before responding. The retry sends a second alert. The user acknowledges the first while an escalation worker has already claimed the voice step; the voice call is sent anyway, then retried after another ambiguous response. Audit shows attempts but cannot establish what the user received.
- **Why existing validation did not catch it:** It verifies the existence of outbox, deduplication, retry, and escalation nouns; it does not model the uncertainty boundary after an external side effect.
- **Recommended correction:** Define channel contracts with a stable logical-delivery idempotency key where supported, explicit ambiguous states and reconciliation otherwise, authenticated/replay-safe callbacks, acknowledgement state, and a conditional escalation claim. Publish a notification-class matrix defining mandatory versus suppressible content, quiet-hour overrides, proxies, and minimum payloads.
- **Regression or architecture test:** Fault-inject provider acceptance followed by timeout, duplicate/reordered callbacks, callback forgery, acknowledgement racing escalation, preference changes mid-flight, provider outage, and worker crash. Assert no duplicate domain state and the documented, bounded delivery behavior.
- **Blocks architecture approval:** Yes
- **Blocks implementation:** Yes, for provider contracts and escalation state
- **Blocks beta:** No if beta uses non-safety in-app delivery only; otherwise yes
- **Blocks production:** Yes
- **Confidence:** High

#### CAR-011 — The canonical typed-request decision is not represented by safe subtype lifecycles

- **Stable review ID:** CAR-011
- **Severity:** High
- **Title:** The canonical typed-request decision is not represented by safe subtype lifecycles
- **Exact affected file:** `docs/architecture/06-data-architecture.md`; `docs/architecture/09-requests-vacation-opportunities-transfers.md`; `docs/architecture/18-capability-traceability.md`
- **Affected section:** 06 §3.4; 09 §§1–4; 18 CAP-021–CAP-023
- **Affected ADR:** No dedicated ADR; ADR-0001 and ADR-0007 are indirectly affected
- **Affected capability IDs:** CAP-021, CAP-022, CAP-023
- **Affected decision IDs:** PO-DEC-03, PO-DEC-14
- **Affected gates:** G-ARCH, G-BETA, G-PROD
- **Issue:** The narrative correctly says request and vacation lifecycles differ, but the schema has one overloaded `requests.status` and many subtype-specific nullable fields without per-type constraints or transition enforcement. It then models vacation selections separately without the promised canonical link. Withdrawal, expiry, approval, and “applied” mean different things by subtype, but there is no type-state transition matrix. Deadline semantics, weekend/holiday behavior, negative entitlement, open-mode approval, and concurrent last-quota allocation are incomplete. The architecture also treats C-03's working default as settled despite PO-DEC-03 remaining pending.
- **Realistic failure scenario:** A `shift-preference` request reaches `applied` despite lacking a shift type, while a time-off request is withdrawn after being committed to a published version without triggering a revision. Two vacation approvals both pass a pre-check for the last weekly slot. The solver consumes rows whose status has no consistent meaning.
- **Why existing validation did not catch it:** It checks that one typed request model and a linked vacation concept are mentioned, not that the schema enforces legal subtype fields and transitions.
- **Recommended correction:** Define explicit subtype schemas or constrained tables under one request aggregate, a normative transition matrix per subtype, database checks for allowed fields/statuses, linkage to vacation grants/selections, idempotent commit/reversal semantics, and solver projections. Keep the choice explicitly provisional until PO-DEC-03 is approved.
- **Regression or architecture test:** SBX-010–013 should generate every type/state/operation combination, concurrent quota approvals, deadline boundaries, weekend/holiday toggles, withdrawal before/after application, and open/quota modes. Invalid combinations must be rejected by both domain and database layers.
- **Blocks architecture approval:** Yes
- **Blocks implementation:** Yes, for request/vacation persistence
- **Blocks beta:** Yes
- **Blocks production:** Yes
- **Confidence:** High

#### CAR-012 — Asynchronous reports lack a durable authorization and data snapshot

- **Stable review ID:** CAR-012
- **Severity:** High
- **Title:** Asynchronous reports lack a durable authorization and data snapshot
- **Exact affected file:** `docs/architecture/05-tenancy-entitlements-authorization.md`; `docs/architecture/13-reports-calendars-and-documents.md`; `docs/architecture/17-deployment-and-operations.md`
- **Affected section:** 05 §§4.4 and 4.6; 13 §§1–4; 17 worker topology
- **Affected ADR:** ADR-0009, ADR-0014, ADR-0015
- **Affected capability IDs:** CAP-020, CAP-045, CAP-046, CAP-047, CAP-048
- **Affected decision IDs:** PO-DEC-22
- **Affected gates:** G-BETA, G-PROD
- **Issue:** Report requests capture tenant context, but not a complete immutable input snapshot or as-of boundary. Only schedule reports naturally point to a version; request, vacation, fairness, picklist, and audit reports can read mutable tables when the worker eventually runs. The worker is not required to reauthorize the actor at execution, and artifact download/share authorization is not specified as a current-policy decision distinct from creation authorization. Recipient/share ACLs and revocation after creation are undefined.
- **Realistic failure scenario:** A scheduler requests a vacation report, loses access, and the job runs hours later against newer approvals. It generates a report the requester was no longer allowed to create and which does not match the state at request time. A previously shared URL remains usable after the recipient loses group membership.
- **Why existing validation did not catch it:** The validator sees asynchronous reports, tenant prefixes, expiry, and audit language, but does not test temporal consistency or authorization revocation.
- **Recommended correction:** Define per-report snapshot semantics: immutable version IDs, repeatable-read/exported snapshots, or materialized input manifests with hashes. Reauthorize actor and tenant/module entitlement at execution and download, model recipient ACLs and revocation, and record the policy/data versions used.
- **Regression or architecture test:** Queue each report, mutate source data and revoke requester/recipient access before execution/download, then verify either a precise immutable snapshot or an explicit cancellation. Cross-tenant object-key and signed-URL replay tests are mandatory.
- **Blocks architecture approval:** Yes
- **Blocks implementation:** Yes, for report job and artifact authorization contracts
- **Blocks beta:** Yes if reports are in beta scope
- **Blocks production:** Yes
- **Confidence:** High

#### CAR-013 — Deployment has no decided availability, recovery, residency, or coordinator model

- **Stable review ID:** CAR-013
- **Severity:** High
- **Title:** Deployment has no decided availability, recovery, residency, or coordinator model
- **Exact affected file:** `docs/architecture/03-system-context-and-containers.md`; `docs/architecture/17-deployment-and-operations.md`; `docs/architecture/19-risks-and-decisions.md`
- **Affected section:** 03 §§2–4; 17 §§1–9; 19 RISK-08 and validation blockers
- **Affected ADR:** ADR-0001, ADR-0015
- **Affected capability IDs:** CAP-003, CAP-031, CAP-032, CAP-040, CAP-051, CAP-055, CAP-067
- **Affected decision IDs:** PO-DEC-18, PO-DEC-23
- **Affected gates:** G-ARCH, G-CONN, G-PROD
- **Issue:** ADR-0015 leaves the platform/provider, region, data residency, database high availability, queue technology, RPO/RTO, and disaster-recovery topology open. PostgreSQL is database, queue backbone, outbox, coordination point, and real-time source, yet failover/fencing and point-in-time recovery consistency with object storage are unspecified. “Affinity by picklist” is not a leader/lease/fencing design. Solver capacity, regional loss, provider outage, secret rotation, migration rollback, and multi-tenant restore/support operations lack executable topology.
- **Realistic failure scenario:** Database failover promotes a lagging replica while an old real-time coordinator remains alive. Two coordinators advance one picklist, outbox events are replayed, and an artifact generated from the old primary remains in object storage. The organization cannot establish an RPO-consistent restore or authoritative turn history.
- **Why existing validation did not catch it:** The proposal explicitly marks these items pending, while the validator only confirms that deployment prose and a topology ADR exist.
- **Recommended correction:** Select a supported deployment class and specify regional/residency assumptions, managed database HA/fencing, backup and object-store consistency, queue recovery, coordinator leases, solver resource isolation, secrets, RPO/RTO, migration expand/contract policy, rollback limits, cost envelope, and tested provider-failure modes.
- **Regression or architecture test:** Run SBX-035 plus database failover during publication/picklist selection, queue backlog and replay, coordinator partition, object-store outage, solver saturation, secret rotation, migration rollback, point-in-time restore, and regional evacuation against the selected platform.
- **Blocks architecture approval:** Yes
- **Blocks implementation:** No for isolated domain prototyping; yes for platform and persistence foundations
- **Blocks beta:** Yes until beta topology and recovery are decided
- **Blocks production:** Yes
- **Confidence:** High

#### CAR-014 — Audit append-only controls do not protect against privileged alteration or policy conflict

- **Stable review ID:** CAR-014
- **Severity:** High
- **Title:** Audit append-only controls do not protect against privileged alteration or policy conflict
- **Exact affected file:** `docs/architecture/06-data-architecture.md`; `docs/architecture/14-security-and-privacy.md`; `docs/architecture/15-audit-and-observability.md`
- **Affected section:** 06 §§3.7 and 5; 14 threats T-19/T-20; 15 §§1–5
- **Affected ADR:** ADR-0013
- **Affected capability IDs:** CAP-003, CAP-010, CAP-014, CAP-019, CAP-021–CAP-027, CAP-031–CAP-034, CAP-040, CAP-046, CAP-051, CAP-055
- **Affected decision IDs:** PO-DEC-11, PO-DEC-22
- **Affected gates:** G-BETA, G-CONN, G-PROD
- **Issue:** Denying UPDATE/DELETE to the application role is useful but does not substantiate the claim that history “cannot be quietly rewritten.” Migration owners, database owners, administrators, restore tooling, and privileged support paths can alter audit rows. There is no tamper-evident chain, immutable external copy, separation of duties, privileged-read audit, or reconciliation with domain/outbox records. “Retained indefinitely” conflicts with policy-driven retention, privacy deletion, and legal obligations, which remain undecided.
- **Realistic failure scenario:** A privileged operator edits an impersonation or publication audit record using the owner role, or a point-in-time restore omits later audit events. The application-level control reports a complete history even though there is no independent integrity evidence. An organization later requests policy deletion that the indefinite design cannot lawfully or coherently perform.
- **Why existing validation did not catch it:** It matches “append-only” and application-role restrictions but does not model privileged actors, restore, or retention conflicts.
- **Recommended correction:** Define the audit threat model and assurance level; use cryptographic chaining/signing or immutable external retention where required, separate duties and credentials, audit privileged reads/writes, reconcile domain/outbox/audit sequences, and establish tenant-specific retention/legal-hold/deletion policy before claiming immutability.
- **Regression or architecture test:** Attempt alteration through application, migration, owner, restore, and support paths; verify detection rather than mere denial. Restore to a point and prove audit continuity/reconciliation. Exercise retention, legal hold, account anonymization, and tenant deletion.
- **Blocks architecture approval:** Yes
- **Blocks implementation:** Yes, for the audit storage contract; not for unrelated domain prototypes
- **Blocks beta:** No if beta carries an explicit non-compliance limitation and excludes privileged support; otherwise yes
- **Blocks production:** Yes
- **Confidence:** High

#### CAR-015 — The security architecture omits several production threat and response boundaries

- **Stable review ID:** CAR-015
- **Severity:** High
- **Title:** The security architecture omits several production threat and response boundaries
- **Exact affected file:** `docs/architecture/02-technology-stack.md`; `docs/architecture/14-security-and-privacy.md`; `docs/architecture/16-testing-and-environments.md`; `docs/architecture/17-deployment-and-operations.md`
- **Affected section:** 02 §§2.2, 2.7–2.11; 14 §§2–6; 16 §§2–7; 17 §§3–8
- **Affected ADR:** ADR-0002, ADR-0008, ADR-0010–ADR-0015
- **Affected capability IDs:** CAP-003, CAP-008, CAP-009, CAP-010, CAP-032, CAP-040, CAP-041, CAP-046, CAP-048, CAP-051, CAP-055, CAP-062, CAP-068
- **Affected decision IDs:** PO-DEC-07, PO-DEC-09, PO-DEC-11, PO-DEC-22
- **Affected gates:** G-ARCH, G-BETA, G-CONN, G-PROD
- **Issue:** The threat table omits or under-specifies WebSocket cross-site hijacking/origin checks, webhook/provider callback authentication and replay, OIDC issuer/tenant mix-up and account linking, account recovery and MFA reset, SSRF through connector/document/report inputs, upload decompression/malware bombs, solver resource abuse, privileged database/platform insiders, artifact/support-tool exfiltration, supply-chain provenance/SBOM/signing, and backup-key compromise. Incident response, breach evidence, dependency patch SLAs, key recovery, and regional security operations are deferred. “No compliance claim” is correct, but the architecture cannot yet produce the necessary security evidence.
- **Realistic failure scenario:** A malicious site opens an authenticated WebSocket and submits a picklist command because origin/CSRF binding is not specified; or a replayed provider callback marks a notification delivered. A compromised dependency/image is deployed without provenance, and the team lacks an incident evidence and credential-rotation procedure.
- **Why existing validation did not catch it:** It checks for a threat model and generic controls, not completeness against the actual protocols, privileged roles, build chain, and incident lifecycle.
- **Recommended correction:** Extend the threat model by trust boundary and abuse case; define WebSocket origin/session binding, callback signatures/nonces, OIDC linking/recovery, SSRF and upload isolation, resource quotas, privileged-access controls, SBOM/signing/provenance, key/backup security, dependency SLAs, and incident response with evidence preservation. Keep all compliance language evidence-based.
- **Regression or architecture test:** Add protocol-specific security tests, callback replay/forgery tests, cross-origin WebSocket attempts, OIDC mix-up/account-linking cases, upload/SSRF fuzzing, solver exhaustion, supply-chain policy checks, privileged-access drills, and an incident tabletop with key rotation and evidence capture.
- **Blocks architecture approval:** Yes
- **Blocks implementation:** No for bounded non-security domain prototypes; yes for identity, transport, integration, and platform foundations
- **Blocks beta:** Yes for external users
- **Blocks production:** Yes
- **Confidence:** High

### Medium

#### CAR-016 — PO-DEC-10 is an unapproved commercial/domain rule that the architecture silently assumes

- **Stable review ID:** CAR-016
- **Severity:** Medium
- **Title:** PO-DEC-10 is an unapproved commercial/domain rule that the architecture silently assumes
- **Exact affected file:** `schedulepoint-research/reports/17-public-source-gap-addendum.md`; `schedulepoint-research/reports/24-production-completeness-gates.md`; `docs/architecture/19-risks-and-decisions.md`; `docs/architecture/architecture-manifest.json`
- **Affected section:** report 17 PUB-064 (§8) and decision table (§11); report 24 §§6–7; architecture 19 §2.2 and §4; manifest `decisions`
- **Affected ADR:** ADR-0005 indirectly
- **Affected capability IDs:** CAP-005, CAP-013, CAP-025, CAP-057; CAP-011 only if commercial policy is incorrectly conflated with stipends
- **Affected decision IDs:** PO-DEC-10 and the conflicting historical decision-number lineage in reports 17/24
- **Affected gates:** G-ARCH; potentially G-PROD if billing is product scope
- **Issue:** The exact source is report 17 PUB-064: a public commercial claim that part-time locums are free and full-time locums are charged at the staff rate. Report 17 then created `PO-DEC-10` with a recommended rule: billing is derived from, not embedded in, scheduling data. Report 24 omits that row and reuses several decision numbers for different topics. No supersession record says PO-DEC-10 was intentionally retired. Architecture 19 says the register gap is unresolved but nevertheless adopts the recommendation. Report 19 defines no billing capability, so the proposal has silently chosen a boundary without defining whether any product component consumes it.
- **Realistic failure scenario:** Entitlements or invoicing later classify locums from a scheduler's mutable role/FTE fields using an undocumented threshold. A part-time locum is billed or gated incorrectly, while CAP-025's staff-priority and CAP-011's stipend data are incorrectly treated as billing authority. The team cannot tell whether this is a SchedulePoint feature, an external commercial system rule, or out of scope.
- **Why existing validation did not catch it:** The validator is explicitly satisfied when the discrepancy is merely mentioned; it does not check whether the architecture has already assumed the disputed recommendation or whether decision IDs remain stable.
- **Recommended correction:** The product owner should restore `PO-DEC-10` to the canonical register as pending, or record an explicit supersession while preserving the historical ID. Decide either: (a) PUB-064 is external commercial policy, with no product billing capability and a clearly defined read-only export boundary; or (b) billing is product scope, requiring a capability, owner, data/invariants, entitlements, audit, tests, and gate. Do not infer billing from stipend or opportunity logic.
- **Regression or architecture test:** A decision-register consistency test should prohibit ID reuse and require every referenced decision to be present or formally superseded. If billing enters scope, add examples across locum role, FTE threshold, multi-group membership, status changes, entitlements, and effective dates.
- **Blocks architecture approval:** Yes, because scope/boundary is unresolved and already assumed
- **Blocks implementation:** No for unrelated scheduling work; yes for entitlement/billing integration and locum-commercial rules
- **Blocks beta:** No unless billing is included
- **Blocks production:** Conditional on product-owner scope decision
- **Confidence:** High

#### CAR-017 — Module ownership rules conflict with required cross-module atomic transactions

- **Stable review ID:** CAR-017
- **Severity:** Medium
- **Title:** Module ownership rules conflict with required cross-module atomic transactions
- **Exact affected file:** `docs/architecture/03-system-context-and-containers.md`; `docs/architecture/04-domain-boundaries.md`; `docs/architecture/06-data-architecture.md`
- **Affected section:** 03 §§2–4; 04 §§1–3; 06 §§1–4
- **Affected ADR:** ADR-0001, ADR-0009
- **Affected capability IDs:** CAP-014, CAP-019, CAP-023, CAP-026, CAP-027, CAP-031, CAP-040, CAP-046, CAP-055
- **Affected decision IDs:** None
- **Affected gates:** G-ARCH, G-BETA, G-PROD
- **Issue:** The proposal says a module never reads or writes another module's tables directly, yet core transactions must atomically update schedule assignments, publication state, picklist state, audit rows, idempotency records, and the outbox, each nominally owned by another module. It does not define a shared unit-of-work/application-service boundary or distinguish transaction-owned writes from event-driven reactions. With 25 modules over one schema, strict ownership plus synchronous operations risks either leaky table coupling or faux asynchronous boundaries inside one database.
- **Realistic failure scenario:** A transfer approval in the marketplace module must replace assignments owned by schedule, emit notifications, and audit the change. The team either violates ownership with direct writes or emits an event before the assignment transaction commits, allowing partial state. Different teams implement both patterns and create a distributed-monolith style dependency graph inside one process.
- **Why existing validation did not catch it:** The validator checks that module names and layer directions exist, not whether required transactions can obey them.
- **Recommended correction:** Define aggregate-level transaction owners and a shared unit-of-work contract. For each cross-module workflow, state which module commands the transaction, which tables it may change through domain ports, and which consequences are outbox-driven after commit. Reduce or merge boundaries that have no independent invariant or scaling need.
- **Regression or architecture test:** Produce transaction sequence diagrams and dependency tests for publication, vacation commit, transfer approval, opportunity claim, picklist selection, report request, and import apply. Each must have one owner, one commit point, no cyclic module dependency, and only post-commit external effects.
- **Blocks architecture approval:** No, if resolved before persistence contracts are frozen
- **Blocks implementation:** Yes for the affected cross-module workflows
- **Blocks beta:** No if fixed during implementation design
- **Blocks production:** Yes if unresolved
- **Confidence:** High

#### CAR-018 — Opportunity and transfer approval do not bind eligibility to assignment versions atomically

- **Stable review ID:** CAR-018
- **Severity:** Medium
- **Title:** Opportunity and transfer approval do not bind eligibility to assignment versions atomically
- **Exact affected file:** `docs/architecture/06-data-architecture.md`; `docs/architecture/09-requests-vacation-opportunities-transfers.md`
- **Affected section:** 06 §3.4 and D-1; 09 §§5–6
- **Affected ADR:** ADR-0007, ADR-0009
- **Affected capability IDs:** CAP-024, CAP-025, CAP-026, CAP-027, CAP-058, CAP-059
- **Affected decision IDs:** PO-DEC-12, PO-DEC-15, PO-DEC-16, PO-DEC-17
- **Affected gates:** G-BETA, G-PROD
- **Issue:** Atomic claim is described as an opportunity-status update plus revalidation, but the expected assignment version/sequence is not part of the compare-and-set. Approval may therefore operate on an assignment that was revised, superseded, or already transferred. Two-leg swaps have no documented lock order or deadlock retry policy. Offer invalidation after publication is promised but not linked to a version token. Exactly one claimant can win the offer-status race, but that does not prove the assignment replacement is still valid.
- **Realistic failure scenario:** A claimant wins an opportunity while a scheduler republishes the source assignment. The later approval updates the stale assignment or creates a duplicate. Two simultaneous reciprocal swaps lock assignment rows in opposite order and deadlock; a blind retry duplicates notifications or leaves an accepted offer pointing to no active assignment.
- **Why existing validation did not catch it:** It sees “atomic update,” eligibility, and D-1, but does not inspect the stale-version predicate or lock order.
- **Recommended correction:** Bind claim/approval to explicit source assignment/version sequences, lock all affected assignment rows in deterministic order, recheck qualification/rest/conflict/priority inside the same transaction, conditionally replace assignments, and invalidate stale offers. Make deadlock retries command-idempotent.
- **Regression or architecture test:** Race two claimants, publication, cancellation, qualification expiry, and reciprocal swaps. Force deadlocks and retries. Assert one winner, no stale approval, no double assignment, no orphaned accepted offer, and one logical notification set.
- **Blocks architecture approval:** No
- **Blocks implementation:** Yes for marketplace mutation paths
- **Blocks beta:** No if those paths are excluded; otherwise yes
- **Blocks production:** Yes if unresolved
- **Confidence:** High

#### CAR-019 — The “PII never sent to third parties” rule contradicts required providers

- **Stable review ID:** CAR-019
- **Severity:** Medium
- **Title:** The “PII never sent to third parties” rule contradicts required providers
- **Exact affected file:** `docs/architecture/02-technology-stack.md`; `docs/architecture/11-notifications-and-communications.md`; `docs/architecture/14-security-and-privacy.md`
- **Affected section:** 02 external systems; 11 §§3–6; 14 §1 sensitivity classes and §3
- **Affected ADR:** ADR-0010, ADR-0014, ADR-0015
- **Affected capability IDs:** CAP-040, CAP-041, CAP-046, CAP-048, CAP-051, CAP-068
- **Affected decision IDs:** PO-DEC-07, PO-DEC-21, PO-DEC-22
- **Affected gates:** G-BETA, G-PROD
- **Issue:** The sensitivity table says PII is “never sent to third parties,” while email, SMS, voice, push, managed object storage, identity providers, and observability may necessarily process contact or user data. CAP-068 concerns unauthorized identifier leakage to third-party UI hosts; it is not a blanket ban on approved subprocessors. The contradiction prevents a coherent data-processing, residency, retention, and payload-minimization design.
- **Realistic failure scenario:** An implementer follows the blanket rule and cannot send SMS, or ignores it and sends names, schedules, and contact data to an unreviewed provider without an approved data-processing boundary. Security tests cannot distinguish an authorized subprocessor from forbidden exfiltration.
- **Why existing validation did not catch it:** It treats strict privacy wording as automatically safe and does not reconcile it with provider data flows.
- **Recommended correction:** Define approved processor classes and data-flow inventories, lawful/contractual requirements, allowed data elements, residency, retention, encryption, deletion, callback behavior, and prohibited destinations. Preserve CAP-068 as a strict host/identifier allowlist for the client and telemetry.
- **Regression or architecture test:** For every provider, assert the exact payload schema, tenant/residency routing, log redaction, retention/deletion, and failure behavior. A network allowlist test must distinguish approved server-side processors from forbidden browser/SDK hosts.
- **Blocks architecture approval:** No
- **Blocks implementation:** Yes for provider selection and payload contracts
- **Blocks beta:** No if only a controlled local provider is used
- **Blocks production:** Yes if unresolved
- **Confidence:** High

#### CAR-020 — Capability traceability references nonexistent structures and understates architecture blockers

- **Stable review ID:** CAR-020
- **Severity:** Medium
- **Title:** Capability traceability references nonexistent structures and understates architecture blockers
- **Exact affected file:** `docs/architecture/18-capability-traceability.md`; `docs/architecture/06-data-architecture.md`; `docs/architecture/architecture-manifest.json`; `schedulepoint-research/reports/19-schedulepoint-production-capability-baseline.md`
- **Affected section:** 18 mappings for CAP-001, 004, 005, 013, 017, 019, 021, 022, 025, 034, 040, 041, 043, 062 and §3; 06 §3; manifest `gates.architectureBlocking`; report 19 §5
- **Affected ADR:** All ADRs through their capability mappings
- **Affected capability IDs:** CAP-001, CAP-003, CAP-004, CAP-005, CAP-013, CAP-017, CAP-019, CAP-021, CAP-022, CAP-025, CAP-032, CAP-034, CAP-040, CAP-041, CAP-043, CAP-062
- **Affected decision IDs:** PO-DEC-01, PO-DEC-02, PO-DEC-03, PO-DEC-18
- **Affected gates:** G-ARCH, G-PROD
- **Issue:** The 58 rows are present, but several map to structures absent or differently named in the data catalogue: `organization_settings`, `group_sites`, `shift_type_sites`, `user_identities`, `membership_work_profiles`, `assignment_audit`, `request_decisions`, `vacation_entitlements`, `vacation_capacity`, `proxy_grants`, `notification_intents`, `push_tokens`, `broadcast_recipients`, and `import_quarantine`. CAP-017 maps `is_fixed` while the schema has `is_locked`. The manifest lists five architecture blockers, while authoritative report 19 lists seven; CAP-003 and CAP-032 are omitted even though the trace prose calls them structural.
- **Realistic failure scenario:** A team begins CAP-013 against a nonexistent profile table, invents incompatible columns, and later discovers the solver contract cannot read weekday FTE. Governance reports the five-item architecture gate complete while tenant isolation and picklist concurrency remain unresolved.
- **Why existing validation did not catch it:** `validate.py` checks field labels, counts, selected phrases, and known IDs; it does not resolve table names, compare blocker sets, or assess field semantics.
- **Recommended correction:** Generate or validate trace structure references against a canonical schema catalogue and compare all capability/gate sets directly with reports 19/22/24. Resolve each mismatch explicitly rather than renaming it away.
- **Regression or architecture test:** Add a semantic architecture test that parses every structure, ADR, capability, decision, and gate reference; fails on missing symbols; and asserts the seven report-19 architecture blockers are all reviewed even where report 24 assigns later evidence gates.
- **Blocks architecture approval:** No by itself; the substantive gaps referenced by the false mappings do
- **Blocks implementation:** No globally; yes for affected capabilities until structures are reconciled
- **Blocks beta:** No
- **Blocks production:** Yes if traceability remains unreliable
- **Confidence:** High

#### CAR-021 — The site model implements the unapproved alternative rather than the pending default

- **Stable review ID:** CAR-021
- **Severity:** Medium
- **Title:** The site model implements the unapproved alternative rather than the pending default
- **Exact affected file:** `docs/architecture/05-tenancy-entitlements-authorization.md`; `docs/architecture/06-data-architecture.md`; `docs/architecture/18-capability-traceability.md`; `schedulepoint-research/reports/24-production-completeness-gates.md`
- **Affected section:** 05 §2.1; 06 §§2.2 and 3.1–3.2; 18 CAP-004; report 24 PO-DEC-01 row
- **Affected ADR:** ADR-0003
- **Affected capability IDs:** CAP-004, CAP-011, CAP-030
- **Affected decision IDs:** PO-DEC-01
- **Affected gates:** G-ARCH, G-BETA
- **Issue:** PO-DEC-01 remains pending with a working default to defer a first-class Site and model location as an attribute initially. The architecture creates `sites`, links `locations.site_id`, and describes Site as an entity, while claiming the model supports either reading. A first-class table and foreign keys are not neutral toward that choice. The trace then cites nonexistent `group_sites`/`shift_type_sites`, adding a third model.
- **Realistic failure scenario:** Implementation builds site administration and relationship rules that product review later rejects, or treats sites as optional attributes while existing foreign keys and UI assume stable entity identity. Connector and picklist mappings diverge.
- **Why existing validation did not catch it:** It checks that PO-DEC-01 remains labeled pending, not whether the working schema has selected one branch.
- **Recommended correction:** Keep the architecture decision conditional: define the minimal location attribute contract and the migration boundary to a first-class Site, or obtain product-owner approval before selecting the entity model. Align trace names after the decision.
- **Regression or architecture test:** A decision-to-schema test should flag any pending choice whose non-default branch creates tables, APIs, or workflows. Model both migration directions with fixtures before approval.
- **Blocks architecture approval:** No, provided the entity is explicitly provisional
- **Blocks implementation:** Yes for site-specific schema/UI until PO-DEC-01 is resolved
- **Blocks beta:** No
- **Blocks production:** No if CAP-004 works with the approved simpler model
- **Confidence:** High

#### CAR-022 — Accessibility is a policy list, not a complete acceptance architecture

- **Stable review ID:** CAR-022
- **Severity:** Medium
- **Title:** Accessibility is a policy list, not a complete acceptance architecture
- **Exact affected file:** `docs/architecture/10-picklist-and-realtime.md`; `docs/architecture/16-testing-and-environments.md`; `docs/architecture/18-capability-traceability.md`
- **Affected section:** 10 §10; 16 §§3, 5, 7; 18 CAP-050 and CAP-066
- **Affected ADR:** ADR-0002, ADR-0008
- **Affected capability IDs:** CAP-020, CAP-021, CAP-031, CAP-032, CAP-045, CAP-046, CAP-050, CAP-066, CAP-067
- **Affected decision IDs:** PO-DEC-18
- **Affected gates:** G-BETA, G-PROD
- **Issue:** Keyboard action, focus, live regions, validation, zoom, and responsive checks are named, but there is no component/interaction acceptance matrix covering semantic schedule grids and alternatives, color independence, contrast and forced colors, touch targets, reduced motion, validation summary/focus placement, real-time interruption policy, or supported browser/assistive-technology combinations. `axe-core` cannot verify most behavioral requirements. The picklist does not specify how reordered, duplicated, or burst events are announced without overwhelming users.
- **Realistic failure scenario:** A keyboard user can technically activate “Pick” but focus is lost when `TurnResolved` replaces the panel, while a screen reader announces several reordered events after the turn has advanced. A color-only conflict indication passes automated scanning but is unusable.
- **Why existing validation did not catch it:** It checks for accessibility vocabulary and test-tool names, not outcome-specific acceptance criteria.
- **Recommended correction:** Define an accessibility architecture matrix by critical workflow and component, with semantics, focus, announcements, validation, contrast, reflow, touch, motion, and alternative-view requirements plus supported AT/browser combinations and manual evidence.
- **Regression or architecture test:** Expand SBX-032–034 and picklist tests to include manual keyboard/screen-reader scripts, focus after all real-time transitions, forced-colors/contrast, 400% zoom, reflow, touch targets, reduced motion, semantic-grid navigation, and color-independent conflicts.
- **Blocks architecture approval:** No
- **Blocks implementation:** No, if the acceptance contract is completed before UI foundations
- **Blocks beta:** Yes for affected user workflows
- **Blocks production:** Yes
- **Confidence:** High

#### CAR-023 — Draft agent instructions omit safeguards and contain contradictory invariants

- **Stable review ID:** CAR-023
- **Severity:** Medium
- **Title:** Draft agent instructions omit safeguards and contain contradictory invariants
- **Exact affected file:** `docs/architecture/drafts/AGENTS.md`; `docs/architecture/drafts/CLAUDE.md`; `docs/architecture/01-architecture-overview.md`; `docs/architecture/10-picklist-and-realtime.md`
- **Affected section:** AGENTS “Hard stops” and “Guardrails”; CLAUDE “Non-negotiable invariants”; 01 §3; 10 §2
- **Affected ADR:** ADR-0002, ADR-0003, ADR-0004, ADR-0007, ADR-0011, ADR-0013
- **Affected capability IDs:** CAP-003, CAP-006, CAP-014, CAP-015, CAP-019, CAP-050, CAP-051, CAP-057, CAP-062, CAP-066, CAP-068
- **Affected decision IDs:** PO-DEC-02, PO-DEC-04, PO-DEC-08
- **Affected gates:** G-ARCH, G-BETA, G-CONN, G-PROD
- **Issue:** The drafts do not explicitly prohibit bypassing RLS, entitlements, schedule-history immutability, audit, accessibility, tests, or capability scope. They do not clearly forbid treating manual scheduling as the production mechanism. `I-05` means mandatory automated scheduling in document 01 but means the Add/New/Create save contract in the drafts and document 10. AGENTS prohibits any outbound third-party host, contradicting required provider and hosting integrations rather than narrowly enforcing CAP-068. The instruction to keep IDs stable is undermined by the unaddressed decision-ID reuse.
- **Realistic failure scenario:** A future agent follows the drafts, adds a direct repository query that lacks tenant context, considers it compliant because no explicit hard stop covers RLS, or disables an accessibility test to ship. Another rejects all notification providers as prohibited third-party hosts. Reviewers cite different meanings for I-05.
- **Why existing validation did not catch it:** The validator checks that the drafts exist and selected phrases appear; it does not compare their safeguards and identifiers with the full architecture.
- **Recommended correction:** Before installation at repository root, add explicit non-bypass rules for every user-listed safeguard, scope controls, and architecture-change procedure. Assign unique invariant IDs and narrow the outbound-host rule to approved, declared processor and browser-host policies.
- **Regression or architecture test:** Lint draft instructions against a required safeguard checklist and unique invariant-ID registry; include adversarial examples for tenant, entitlement, schedule history, solver fallback, privacy, ingestion, audit, accessibility, test weakening, architecture drift, and unrelated scope.
- **Blocks architecture approval:** No
- **Blocks implementation:** Yes before these files govern implementation agents
- **Blocks beta:** No
- **Blocks production:** No directly
- **Confidence:** High

#### CAR-024 — Major stack rows are placeholders rather than reviewable technology decisions

- **Stable review ID:** CAR-024
- **Severity:** Medium
- **Title:** Major stack rows are placeholders rather than reviewable technology decisions
- **Exact affected file:** `docs/architecture/02-technology-stack.md`; `docs/architecture/references/official-technical-sources.md`
- **Affected section:** 02 §§1–3; official-source reference table
- **Affected ADR:** ADR-0002, ADR-0010, ADR-0014, ADR-0015
- **Affected capability IDs:** CAP-008, CAP-015, CAP-032, CAP-040, CAP-041, CAP-046–CAP-048, CAP-051, CAP-067
- **Affected decision IDs:** PO-DEC-07, PO-DEC-09, PO-DEC-21, PO-DEC-22, PO-DEC-23
- **Affected gates:** G-ARCH, G-BETA, G-PROD
- **Issue:** “Mature TypeScript framework,” “ORM/query builder,” queue library, authentication/SSO implementation, notification providers, report renderer, calendar generator, object store product, hosting platform, and several test/observability components are unselected or marked `VERIFY`. Fitness, maintenance, licensing, security response, healthcare-enterprise deployment, data residency, local development, and replacement cost therefore cannot be reviewed. A port is a useful seam, but it does not neutralize provider data formats, callback semantics, SQL behavior, or operational lock-in.
- **Realistic failure scenario:** A selected ORM cannot reliably inject transaction-local tenant context or express exclusion/partial constraints; a report renderer executes untrusted HTML; a queue library lacks leases; or a provider lacks Canadian residency and idempotency. The generic ADR has already been treated as a decision, so these become implementation surprises.
- **Why existing validation did not catch it:** The validator permits `VERIFY` entries and checks category coverage, not an actual product/version/license/security decision.
- **Recommended correction:** Convert each material placeholder into a proposed ADR or explicit pre-implementation gate with current supported versions, license, maintenance/security policy, deployment/data-residency constraints, failure behavior, local-development approach, and replacement boundary. Do not claim the overall stack selected until these pass.
- **Regression or architecture test:** Add a technology-decision completeness check and small boundary spikes for RLS/ORM, queue leases, WebSocket scaling, OIDC, each provider callback, report sandboxing, iCalendar compatibility, object-store signing/scanning, and OpenTelemetry redaction.
- **Blocks architecture approval:** No for the high-level architecture; yes for claiming the technology stack is approved
- **Blocks implementation:** Yes for framework and infrastructure foundations
- **Blocks beta:** Yes until beta stack choices are verified
- **Blocks production:** Yes
- **Confidence:** High

#### CAR-025 — The environment/test plan cannot yet produce several required evidence artifacts

- **Stable review ID:** CAR-025
- **Severity:** Medium
- **Title:** The environment/test plan cannot yet produce several required evidence artifacts
- **Exact affected file:** `docs/architecture/16-testing-and-environments.md`; `docs/architecture/17-deployment-and-operations.md`; `docs/architecture/19-risks-and-decisions.md`
- **Affected section:** 16 §§1–7; 17 §§2–8; 19 validation blockers
- **Affected ADR:** ADR-0002, ADR-0006, ADR-0008, ADR-0011, ADR-0015
- **Affected capability IDs:** CAP-003, CAP-015, CAP-016, CAP-031, CAP-032, CAP-040, CAP-041, CAP-046, CAP-051, CAP-055, CAP-062, CAP-066, CAP-067
- **Affected decision IDs:** PO-DEC-07, PO-DEC-08, PO-DEC-13, PO-DEC-18, PO-DEC-23
- **Affected gates:** G-BETA, G-CONN, G-PROD
- **Issue:** The environments are sensible categories, but several tests have no reproducible fixture or evidence owner: solver benchmarks lack authoritative datasets and acceptance measures; provider tests require unselected providers; connector tests require vendor specifications and certification fixtures; SBX-029's whole-platform zero-persistence proof lacks observability/backup access; multi-session picklist tests lack an orchestration/clock/fault model; DR tests lack RPO/RTO and target platform. Pass criteria such as “usable explanation” and “quality threshold” remain subjective. Some security, RLS, and transaction tests should precede feature work rather than wait for later gates.
- **Realistic failure scenario:** The project reaches production readiness with 39 test names but cannot instantiate the solver corpus, trigger real provider ambiguity, inspect managed backups, or deterministically race multiple sockets. Teams substitute mocks that cannot prove the stated gates.
- **Why existing validation did not catch it:** It validates mapping of test IDs to environments and gates, not fixture availability, external dependencies, deterministic orchestration, or evidence format.
- **Recommended correction:** For every SBX test define owner, fixture provenance, deterministic setup, external dependency or simulator, fault controls, objective oracle, retained artifact, environment, and earliest execution point. Establish benchmark datasets and acceptance thresholds before solver implementation; run RLS, publication, and picklist transaction harnesses at the schema/prototype stage.
- **Regression or architecture test:** A meta-test should provision every fixture from a clean environment and produce the declared evidence without hidden credentials or manual vendor assumptions. Missing provider/vendor inputs must keep the relevant gate explicitly blocked.
- **Blocks architecture approval:** No
- **Blocks implementation:** No generally; yes before claiming the affected design evidence
- **Blocks beta:** Yes for tests mapped to beta
- **Blocks production:** Yes
- **Confidence:** High

### Low

#### CAR-026 — Report 18 states 36 tests although it defines 39

- **Stable review ID:** CAR-026
- **Severity:** Low
- **Title:** Report 18 states 36 tests although it defines 39
- **Exact affected file:** `schedulepoint-research/reports/18-targeted-sandbox-test-plan.md`; `docs/architecture/architecture-manifest.json`
- **Affected section:** report 18 closing line; manifest test count
- **Affected ADR:** None
- **Affected capability IDs:** All capabilities mapped to SBX evidence
- **Affected decision IDs:** None
- **Affected gates:** G-BETA, G-CONN, G-PROD
- **Issue:** Independent enumeration finds 39 unique SBX headings, matching the architecture manifest, but report 18 ends with “36 sandbox tests defined.”
- **Realistic failure scenario:** A later review uses the prose count and believes three tests are extra, missing, or ungoverned.
- **Why existing validation did not catch it:** Neither validator compares the closing prose count with unique headings.
- **Recommended correction:** Correct the source count in a separate research-maintenance task and derive it automatically. Do not change it as part of this architecture review.
- **Regression or architecture test:** Parse unique SBX headings and compare them with every declared count and manifest reference.
- **Blocks architecture approval:** No
- **Blocks implementation:** No
- **Blocks beta:** No
- **Blocks production:** No
- **Confidence:** High

#### CAR-027 — Account email immutability is stronger than the required non-self-editability outcome

- **Stable review ID:** CAR-027
- **Severity:** Low
- **Title:** Account email immutability is stronger than the required non-self-editability outcome
- **Exact affected file:** `docs/architecture/06-data-architecture.md`; `docs/architecture/18-capability-traceability.md`
- **Affected section:** 06 §3.1 `users`; 18 CAP-005/CAP-007
- **Affected ADR:** ADR-0004 indirectly
- **Affected capability IDs:** CAP-005, CAP-007, CAP-008, CAP-009
- **Affected decision IDs:** PO-DEC-09
- **Affected gates:** G-BETA
- **Issue:** The schema says account email is immutable. The authoritative outcome is that the user cannot edit the account email through ordinary profile behavior; it does not prohibit a controlled administrator/identity-provider correction. Absolute immutability complicates legal name/domain changes, SSO linking, bounced-address correction, and account recovery without an alternate identity model.
- **Realistic failure scenario:** A hospital changes email domains or corrects a mistyped invitation. The system must create a second account, losing membership/audit continuity or requiring unsafe manual database edits.
- **Why existing validation did not catch it:** Stronger restrictions look safe to keyword validation, and no lifecycle for controlled email change is mapped.
- **Recommended correction:** Specify email as non-self-editable, with an audited privileged/identity-provider-controlled change or a separate immutable identity plus versioned login addresses.
- **Regression or architecture test:** Test admin/IdP email correction, uniqueness race, active sessions, invitation conflicts, notification routing, audit attribution, and rollback.
- **Blocks architecture approval:** No
- **Blocks implementation:** No, if corrected before identity schema freezes
- **Blocks beta:** No
- **Blocks production:** No
- **Confidence:** Medium

## 4. Optional improvements (not defects)

- Add a compact glossary that distinguishes organization, group, site, location, schedule period, schedule version, assignment identity, assignment snapshot, build, and publication.
- Add ownership and sequence overlays to the existing Mermaid diagrams; keep the diagrams derived from the same canonical names as the data catalogue.
- Add explicit architecture-decision expiry/review dates for all `VERIFY` rows and pending working defaults.
- Add cost envelopes for baseline, picklist peak, solver peak, notification burst, artifact retention, and disaster-recovery storage.
- Add a human-readable change log to future architecture packages so independent reviewers can focus re-review on changed invariants without trusting the manifest alone.

## 5. Independent conclusions by required review area

### Product-scope coverage

All 58 report-19 capability IDs are present, and no public-source requirement was found to have disappeared entirely. The proposal correctly preserves superseded source behaviors by retaining their user outcome rather than cloning the source mechanism. It correctly treats automated scheduling as mandatory for production and manual scheduling as fallback/override only. It correctly keeps product capability separate from optional tenant enablement in most places, and it leaves production and connector gates unpassed. Coverage is nevertheless **not sufficient**: mappings for solver work profiles, publication, picklist, requests, push, reporting, ingestion, and operations are nominal or unsafe. The seven former architecture-blocking capabilities—CAP-001, CAP-002, CAP-003, CAP-006, CAP-032, CAP-055, and CAP-057—were each examined; CAP-003 and CAP-032 remain blocking despite their omission from the manifest's five-item list.

### Application topology

The modular-monolith recommendation is appropriate initially, and separate worker/real-time process classes are reasonable extraction seams. It avoids premature microservices. The current 25-module ownership model is too rigid for the shared-database transactions it requires (CAR-017), the selected solver needs an unacknowledged second runtime boundary (CAR-005), and real-time scaling lacks coordinator fencing (CAR-003/CAR-013). Without those corrections it risks a distributed monolith in process rather than over the network. The solver is a necessary isolation boundary; the picklist needs a logical single-writer/transaction boundary, not necessarily a microservice.

### Technology-stack fitness

PostgreSQL, HTTP/JSON, WebSocket, S3-compatible storage, OpenTelemetry, Playwright, and axe-core are defensible choices within their stated limits. PostgreSQL exclusion/partial indexes and RLS are suitable only with corrected transaction discipline. OR-Tools CP-SAT is plausibly capable of the rule classes in report 21, but the Node.js runtime decision is incompatible with official bindings and the domain compiler is unspecified. Hash-only push storage is inoperable. Most framework/provider/hosting rows remain unreviewable placeholders (CAR-024). Replacement ports reduce coupling but do not eliminate data, callback, operational, or residency lock-in.

### Tenancy

Composite tenant keys, RLS, tenant-prefixed storage, tenant-aware jobs/events, and cross-tenant test intent are good foundations. Tenancy is **unsafe as designed** because session-global context can change beneath a tab (CAR-001) and pooled session variables can retain a previous organization (CAR-002). Job, WebSocket, report, cache, support, backup/restore, quarantine, solver, and observability isolation all depend on those unresolved primitives. A comprehensive denial harness is possible only after request-scoped context and transaction-local RLS are normative.

### Authorization and entitlements

The approved four-layer model is preserved and entitlements are conceptually separate from permissions. The architecture does not define deterministic precedence, explicit-deny behavior, dependency failure, disabled-module data behavior, freshness, or reauthorization across jobs and sockets (CAR-008). Impersonation controls are directionally good but inherit audit and policy-freshness defects. The current design therefore cannot prove deny-by-default on every route and object, or prevent stale privilege use.

### Data model and database invariants

Tenant keys, composite foreign keys, archive fields, optimistic versions, outbox/idempotency tables, classifications, and named constraints are strong design habits. The schema is not sufficient: schedule-version constraints contradict coexistence and immutability (CAR-007), solver work profiles/rules are absent (CAR-006), request subtypes/lifecycles are unsafe (CAR-011), and several trace structures do not exist (CAR-020). Histories for builds, publication, requests, transfers, picklists, notifications, integrations, and assignments are named, but published-graph immutability, cross-version conflict scope, notification acknowledgement, and privileged audit integrity lack enforceable invariants.

### Schedule versioning and publication

The intended draft→approve→publish→supersede model, atomic publication, outbox-after-commit, comparison, revision-by-new-version, and calendar/report version references are correct. The assignment exclusion constraint prevents safe cloning or forces history mutation, and published immutability exists only in prose (CAR-007). Without redesign, concurrent edits can be lost, duplicate/ambiguous publication events can occur during failover, and calendar/report outputs cannot be reliably reconstructed.

### Automated scheduling

Automated scheduling remains a production requirement and the solver-neutral domain boundary is the right abstraction. CP-SAT can express the documented finite-domain rule families in principle; the proposal has not shown that its actual representation does. Hard/soft classification, weights, target percentages, FTE, weekday FTE, qualification expiry, requests, vacation, linked/sequence/template/call-spacing rules, fairness, locum restrictions, fixed assignments, progressive builds, history, quality, and comparison are mentioned. The typed rule/compiler schema, hard-constraint invariant, benchmark corpus, interruptible runtime, deterministic provenance, realistic infeasibility explanation, and bounded rationale contract are missing (CAR-005/CAR-006). Locked assignments can make a model infeasible, but the proposed “minimal core” is not guaranteed within a budget. Same-seed retries can differ across versions/parallelism, and historical binaries/configuration are not retained. Production feasibility is therefore unproven and currently not implementable as specified.

### Requests and vacation

One canonical request aggregate with linked vacation can be viable, but the proposal's single nullable table and overloaded status do not safely express the distinct lifecycles, transitions, deadlines, withdrawals, approvals, quotas, open mode, and solver effects (CAR-011). Concurrent last-unit allocation and post-commit withdrawal require database predicates that are not yet defined.

### Opportunities, swaps, and transfers

Eligibility, staff priority, qualifications, conflict/rest checking, expiry, approval, invalidation, audit, and notification are represented. Exactly one offer-status claimant can win, but approval is not bound to a current assignment version and two-leg lock/deadlock handling is missing (CAR-018). Stale approvals, orphaned offers, and duplicate consequences remain plausible.

### Picklist and real-time execution

Server-authoritative state, server time, versioned snapshots, explicit refresh, page-scoped connections, proxies, pause/resume, paper/manual/integrated modes, persist-before-broadcast, and outbox integration are appropriate. The decisive invariant is wrong: work-item uniqueness is not one result per turn (CAR-003). Command idempotency, total event ordering/replay, multiple coordinator/timer ownership, correction/reopening, and all pause/proxy/admin races do not share one authoritative transaction. Current picklist-concurrency feasibility is rejected.

### Notifications

Domain event→intent→render→attempt separation and provider-independent domain commits are correct. Retry cannot duplicate domain state, but it can duplicate external delivery after ambiguous provider outcomes; acknowledgement/escalation, callbacks, and mandatory-notification policy are incomplete (CAR-010). Push is impossible with hash-only registrations (CAR-009). Tenant context and payload minimization are intended but provider/subprocessor boundaries conflict (CAR-019). Notification reliability is not production-ready.

### Integrations and privacy

The generic connector contract, named adapter boundaries, batch idempotency, normalization, reconciliation, quarantine metadata, provenance, and connector certification are appropriate. The platform-enforced allowlist sits after an untrusted semantic mapping and permits unrestricted allowed-field values, while pre-boundary raw-data failure surfaces are unspecified (CAR-004). The design cannot currently prove the de-identification gate across request bodies, temp files, queues, DLQs, logs, traces, metrics, errors, backups, quarantine, debugging, or support tools. This review makes no claim about whether the source product stores patient-identifying information.

### Reports, files, and calendar feeds

Asynchronous artifacts, tenant storage prefixes, short-lived downloads, scanning/quarantine, document versions, category permissions, hashed calendar tokens, rotation/revocation, and auditing are sound directions. Reports lack data/auth snapshots (CAR-012). Signed-download revocation, share ACLs, calendar cache headers/referrer/log redaction, token entropy, stale feed behavior during failover, and object-store/backup consistency require more exact contracts. Permanent public artifacts are not intended, but bearer-token leakage tests remain necessary.

### Security and privacy

The proposal covers MFA/SSO intent, session security, CSRF/XSS/CSP, encryption, rate limiting, secrets, impersonation banners, audit, dependency scanning, backup, retention, and DR at a high level, and makes no unsupported compliance certification. Cross-tab/RLS isolation, privileged audit integrity, provider data flows, protocol threats, supply-chain provenance, incident response, and recovery evidence are insufficient (CAR-001/002/014/015/019). Security posture is not approvable.

### Accessibility and responsive behavior

Accessibility is architectural rather than wholly aspirational: it has gates, named tests, keyboard/focus/live-region requirements, mobile/reflow goals, and a table alternative. The acceptance model does not cover all required semantics and manual evidence, especially real-time picklist announcement/focus behavior (CAR-022). CAP-066 remains incomplete.

### Testing strategy

All 39 unique SBX tests have an architecture location and the environment taxonomy is generally sensible. The plan supports unit, integration, property, browser, accessibility, security, load, provider, connector, and DR work. Several tests cannot yet produce the required evidence because technology/vendor choices, fixtures, deterministic concurrency controls, solver datasets/oracles, and platform access are absent (CAR-025). RLS, schedule cloning/publication, and picklist CAS tests should run at the database/prototype stage, earlier than proposed gate execution.

### Deployment and operations

Horizontal stateless web/worker processes, separate solver resources, managed stateful dependencies, outbox metrics, backups, migration rehearsal, and staged rollout are reasonable. The actual hosting, HA/failover/fencing, residency, RPO/RTO, regional recovery, capacity/cost, and queue/coordinator behavior are undecided (CAR-013/CAR-024). PostgreSQL is a central single point of failure in the proposal as drawn. Deployability and operational complexity are not yet acceptable for beta or production.

### ADR quality

All 15 ADRs remain `PROPOSED`. They consistently contain context, decision, alternatives, consequences, capability/gate mappings, and validation sections. Several decisions are premature or internally inconsistent: ADR-0002 versus ADR-0006 on runtime, ADR-0003 on pooled RLS, ADR-0007 on version constraints, ADR-0008 on picklist uniqueness, ADR-0010 on push/retry, ADR-0011 on boundary location, ADR-0013 on privileged integrity, and ADR-0015 on undecided deployment. Major decisions embedded in prose but lacking a dedicated ADR include the typed request schema, cross-module unit of work, report snapshot semantics, and privileged audit assurance.

### Repository instructions

The drafts correctly warn against source cloning, implementation before approval, privacy leakage, and unreviewed architecture change. They would not reliably prevent all user-listed failures and contain an invariant-ID and outbound-host contradiction (CAR-023). They should remain drafts and must not govern implementation yet.

### Operational complexity

The initial modular monolith is a reasonable complexity baseline. Four process classes, PostgreSQL-backed jobs/outbox, object storage, notification providers, a second solver runtime, WebSocket coordination, connector certification, and twelve environment categories still create substantial operational load for an initial team. Complexity is acceptable only if module count is rationalized, the solver is explicitly isolated, managed platform choices are made, and the reliability evidence is automated.

### Clean-room compliance

**Approved for this review scope.** The proposal is derived from the provided research corpus, retains unresolved facts as unresolved, does not claim hidden source internals, and the review did not visit the prohibited source site or conduct new source-product research. Official technical sources were consulted only to verify selected technology behavior. No source-behavior assertion was expanded.

## 6. Independent 58-capability audit

“Adequate direction” means the capability has a genuine owner/data/operation/test path at proposal depth, but it still inherits unresolved cross-cutting findings. “Incomplete” means a direct design element is absent. “Unsafe” means the documented design permits a prohibited outcome.

| Capability | Independent result | Principal evidence/finding |
|---|---|---|
| CAP-001 Organization tenancy root | Incomplete | Session context and trace mismatch: CAR-001, CAR-020 |
| CAP-002 Group scheduling scope and switching | Unsafe | Cross-tab/group substitution: CAR-001 |
| CAP-003 Server/database tenant isolation | Unsafe | Request context and pooled RLS: CAR-001, CAR-002 |
| CAP-004 Site modelling | Incomplete | Pending default contradicted: CAR-021 |
| CAP-005 User accounts/account types | Adequate direction | Email lifecycle refinement: CAR-027; inherits CAR-008 |
| CAP-006 Membership roles/capabilities | Unsafe | No deterministic precedence/freshness: CAR-008 |
| CAP-007 Profile, credentials, preferences | Adequate direction | Controlled email operation missing: CAR-027 |
| CAP-008 Authentication/session management | Incomplete | Provider/session security decisions pending: CAR-015, CAR-024 |
| CAP-009 Invitation/activation/reset separation | Adequate direction | Identity/email correction edge: CAR-027 |
| CAP-010 Administrative impersonation | Incomplete | Policy freshness and privileged audit: CAR-008, CAR-014 |
| CAP-057 Entitlement/feature gating | Incomplete | Precedence, pending commercial boundary: CAR-008, CAR-016 |
| CAP-011 Shift type catalogue | Adequate direction | Site choice conditional: CAR-021 |
| CAP-012 Shift/staff groups | Adequate direction | Inherits tenant/auth corrections |
| CAP-013 Weekday FTE/max assignments/work percentage | Incomplete | Canonical data absent: CAR-006, CAR-020 |
| CAP-058 Qualifications/expiry/eligibility | Incomplete | Solver/claim atomicity: CAR-006, CAR-018 |
| CAP-014 Versioned schedule publication | Unsafe | Version constraints/history: CAR-007 |
| CAP-015 Automated generation | Incomplete | Runtime and solver contract: CAR-005, CAR-006 |
| CAP-016 Rule engine | Incomplete | No typed/versioned rule compiler: CAR-006 |
| CAP-017 Progressive builds/fixed assignments | Incomplete | Build concurrency and version invariants: CAR-006, CAR-007 |
| CAP-018 Partial circulation | Adequate direction | Inherits publication/version correction: CAR-007 |
| CAP-059 Conflict/build-quality verification | Incomplete | Severity/quality/explanation contract: CAR-006 |
| CAP-019 Manual override/fixed assignments | Unsafe | Published/versioned assignment model: CAR-007 |
| CAP-020 Schedule views/daily sheet | Incomplete | Historical snapshot depends on CAR-007/CAR-012 |
| CAP-021 Typed requests | Incomplete | Subtype schema/lifecycle: CAR-011 |
| CAP-022 Vacation modes | Incomplete | Quota/lifecycle/schema: CAR-011 |
| CAP-023 Vacation commit | Incomplete | Commit/reversal/version UoW: CAR-011, CAR-017 |
| CAP-024 Opportunity board | Incomplete | Notification and stale claim boundaries: CAR-010, CAR-018 |
| CAP-025 Staff-over-locum preference | Incomplete | Claim/version plus billing ambiguity: CAR-016, CAR-018 |
| CAP-026 Offers/swaps/transfers | Incomplete | Stale approval/deadlock: CAR-018 |
| CAP-027 Change audit/notifications | Incomplete | Versioning and delivery ambiguity: CAR-007, CAR-010, CAR-018 |
| CAP-030 Picklist preparation | Unsafe | Work-item privacy and aggregate state: CAR-003, CAR-004 |
| CAP-060 Picklist modes | Unsafe | Manual free text and correction transaction: CAR-003, CAR-004 |
| CAP-031 Picklist execution | Unsafe | No one-result-per-turn CAS: CAR-003 |
| CAP-032 Picklist concurrency/realtime | Unsafe | Command/event/coordinator boundary: CAR-001, CAR-003 |
| CAP-033 Admin picklist intervention | Unsafe | Admin/participant race: CAR-003 |
| CAP-034 Proxy delegation | Unsafe | Proxy/physician race and stale auth: CAR-003, CAR-008 |
| CAP-040 Notification reliability | Incomplete | Ambiguous delivery/escalation: CAR-010 |
| CAP-041 Email/SMS/voice/push | Incomplete | Hash-only push and providers: CAR-009, CAR-010 |
| CAP-042 Minimized-PII directory | Adequate direction | Inherits authorization/provider rules: CAR-008, CAR-019 |
| CAP-043 Bulk messaging | Incomplete | Delivery/preference/provider contract: CAR-010, CAR-019 |
| CAP-056 Group identity | Incomplete | Provider/ownership decisions pending: CAR-010, CAR-019, CAR-024 |
| CAP-044 On-call telecom access | Adequate direction | Requires deterministic authorization: CAR-008 |
| CAP-045 Fairness statistics | Incomplete | Mathematical definitions/snapshot: CAR-006, CAR-012 |
| CAP-046 Reports/export/sharing | Incomplete | Snapshot/auth/share ACL: CAR-012 |
| CAP-047 Calendar subscriptions | Incomplete | Version and bearer/download controls: CAR-007, CAR-012 |
| CAP-048 Private documents | Incomplete | Provider/security/authorization decisions: CAR-012, CAR-015, CAR-019 |
| CAP-049 Schedule calendar events | Incomplete | Published history dependency: CAR-007 |
| CAP-055 Integration framework | Unsafe | Pre-boundary data path/security: CAR-004, CAR-015 |
| CAP-061 ORSOS connector | Unsafe until certified | CAR-004; G-CONN remains blocked |
| CAP-062 De-identification boundary | Unsafe | Semantic relabeling/free text: CAR-004 |
| CAP-063 Cerner/Surginet connector | Unsafe until certified | CAR-004; G-CONN remains blocked |
| CAP-064 Meditech connector | Unsafe until certified | CAR-004; G-CONN remains blocked |
| CAP-065 Customer connectors | Unsafe until certified | CAR-004; G-CONN remains blocked |
| CAP-066 Accessibility | Incomplete | Acceptance architecture: CAR-022 |
| CAP-067 Efficiency/performance | Incomplete | Solver/runtime/fixture gaps: CAR-005, CAR-006, CAR-025 |
| CAP-068 No identifier leakage | Incomplete | Ingestion/provider policy contradictions: CAR-004, CAR-019 |
| CAP-050 Design-system safety | Incomplete | UI acceptance/instruction-ID drift: CAR-022, CAR-023 |
| CAP-051 Observability/backup/recovery | Incomplete | HA, audit, security, evidence: CAR-013–CAR-015, CAR-025 |

### Seven former architecture blockers

| Capability | Result |
|---|---|
| CAP-001 | Owner and tenancy root exist; request-context semantics remain incomplete (CAR-001). |
| CAP-002 | Group switching exists; cross-tab stale context is unsafe (CAR-001). |
| CAP-003 | RLS intent exists; session-variable pooling is unsafe (CAR-002). |
| CAP-006 | Four layers exist; precedence/freshness is incomplete (CAR-008). |
| CAP-032 | Server-authoritative transport exists; authoritative transaction does not (CAR-003). |
| CAP-055 | Connector port exists; raw-ingress/privacy boundary is unsafe (CAR-004). |
| CAP-057 | Entitlement model exists; evaluation/module dependency/commercial boundary remains incomplete (CAR-008/CAR-016). |

## 7. Independent SBX evidence audit

All 39 unique test IDs in report 18 were checked. “Architecturally supported” means the proposed seams can host the test; it does not mean the test has run or passed.

| Test | Architecture support | Review conclusion |
|---|---|---|
| SBX-001 Lower privilege | Partial | Policy harness exists; no complete truth table (CAR-008). |
| SBX-002 Picklist permissions | Partial | Roles/capabilities exist; freshness/precedence incomplete (CAR-008). |
| SBX-003 Directory population | Supported in concept | Requires product policy and object-level authorization. |
| SBX-004 Cross-tenant sweep | Blocked by design | Must add cross-tab and pool-failure cases (CAR-001/002). |
| SBX-005 Identity/admin flows | Partial | Invitation/impersonation modeled; privileged audit incomplete (CAR-014/015). |
| SBX-006 Session timeout | Partial | Session controls named; cross-tab/context/version and IdP choice unresolved. |
| SBX-010 Request lifecycle | Blocked by design | Type-state matrix/schema absent (CAR-011). |
| SBX-011 One/two records | Partial | One typed aggregate claimed, but no safe linked schema (CAR-011). |
| SBX-012 Vacation modes | Partial | Modes named; lifecycle/quota semantics incomplete (CAR-011). |
| SBX-013 Last entitlement unit | Blocked by design | No exact conditional quota allocation invariant (CAR-011). |
| SBX-015 Build failure/regeneration | Partial | State model exists; runtime/cancellation/concurrency incomplete (CAR-005/006). |
| SBX-016 Conflict/quality | Partial | Conflict rows exist; objective oracle/thresholds incomplete (CAR-006/025). |
| SBX-017 Progressive fixed build | Blocked by design | Version/build uniqueness and fixed-input schema incomplete (CAR-006/007). |
| SBX-018 Publication/revert | Blocked by design | Assignment exclusion and immutability contradict test (CAR-007). |
| SBX-019 Qualifications | Partial | Qualification data exists; all mutation/solver paths need one oracle. |
| SBX-020 Picklist preparation | Partial | Modes/preparation exist; privacy and correction gaps (CAR-003/004). |
| SBX-021 Live execution | Blocked by design | No atomic turn CAS (CAR-003). |
| SBX-022 Simultaneous selection | Blocked by design | Index proves item uniqueness, not turn uniqueness (CAR-003). |
| SBX-023 Reconnect/stale | Partial | Snapshots/version named; total event order/replay incomplete (CAR-003). |
| SBX-024 Expiry/proxy fallback | Blocked by design | Timer/proxy/admin races lack one boundary (CAR-003). |
| SBX-025 Admin intervention | Blocked by design | No CAS against in-flight participant action (CAR-003). |
| SBX-026 Proxy authority | Partial | Grants exist; authorization freshness and concurrency unsafe (CAR-003/008). |
| SBX-027 Correction/reopen | Blocked by design | Completed-state correction/reopen transaction is not specified (CAR-003). |
| SBX-013b Opportunity fan-out/claim | Partial | Flow exists; stale assignment and delivery issues (CAR-010/018). |
| SBX-014b Concurrent claims | Partial | One offer winner possible; atomic replacement/version binding absent (CAR-018). |
| SBX-014c Swaps/transfers | Partial | Two-leg operation named; lock/deadlock/version design absent (CAR-018). |
| SBX-030a Delivery/retry | Blocked by design | Ambiguous provider result/ack race (CAR-010). |
| SBX-030b Push viability | Blocked by design | Hash-only registration cannot deliver (CAR-009). |
| SBX-031a Reports/export/share | Blocked by design | Snapshot and revocation semantics absent (CAR-012). |
| SBX-031b Document lifecycle | Partial | Storage/scanning/versioning direction exists; provider/security choices pending. |
| SBX-031c Calendar token | Partial | Hash/rotation/revocation exist; caching/leakage/version tests need precision. |
| SBX-028 Import lifecycle | Partial | Batch/idempotency/reconciliation present; privacy ingress boundary unsafe (CAR-004). |
| SBX-029 De-identification | Blocked by design | Allowed-key semantic relabeling defeats oracle (CAR-004). |
| SBX-032 Validation/errors | Partial | Contract named; component acceptance matrix incomplete (CAR-022). |
| SBX-033 Keyboard/screen reader | Partial | Manual evidence needed for real-time/focus semantics (CAR-022). |
| SBX-034 Zoom/reflow | Supported in concept | Needs objective viewport/touch/contrast matrix (CAR-022). |
| SBX-030 Load benchmarks | Partial | Targets/env named; stack and deterministic fixture missing (CAR-024/025). |
| SBX-031 Solver benchmark | Blocked by evidence | No authoritative corpus/oracle and runtime design incomplete (CAR-005/006/025). |
| SBX-035 DR/migration | Blocked by evidence | No platform, RPO/RTO, or failover topology (CAR-013/025). |

No sandbox test was executed by this review. `G-BETA`, `G-CONN`, and `G-PROD` remain blocked until their required evidence exists.

## 8. Architecture artifact review record

### Numbered documents 01–19

| Document | Independent disposition |
|---|---|
| `01-architecture-overview.md` | Direction acceptable; I-01 unsafe and I-05 identifier later reused (CAR-001/023). |
| `02-technology-stack.md` | Material runtime contradiction and placeholders (CAR-002/005/009/024). |
| `03-system-context-and-containers.md` | Initial topology acceptable; runtime/coordinator/HA boundaries incomplete (CAR-005/013/017). |
| `04-domain-boundaries.md` | Useful ownership map; cross-module unit of work unresolved (CAR-017). |
| `05-tenancy-entitlements-authorization.md` | Four-layer direction sound; context, RLS, precedence/freshness unsafe (CAR-001/002/008). |
| `06-data-architecture.md` | Good catalogue discipline; critical invariants and referenced structures inconsistent (CAR-003/006/007/009/011/020). |
| `07-schedule-and-publication.md` | Correct intended lifecycle; schema cannot safely implement it (CAR-007). |
| `08-automated-scheduling-engine.md` | Appropriate solver-neutral intent; runtime/rule/control/evidence contract incomplete (CAR-005/006). |
| `09-requests-vacation-opportunities-transfers.md` | Outcomes represented; typed lifecycle and stale-approval locking incomplete (CAR-011/018). |
| `10-picklist-and-realtime.md` | Appropriate server-authoritative transport; authoritative selection transaction unsafe (CAR-003/004). |
| `11-notifications-and-communications.md` | Good outbox separation; provider ambiguity, acknowledgement, push, and policy incomplete (CAR-009/010/019). |
| `12-integrations-and-ingestion-privacy.md` | Correct ownership goal; boundary placement/value semantics cannot prove it (CAR-004). |
| `13-reports-calendars-and-documents.md` | Sound storage direction; report snapshot/current authorization incomplete (CAR-012). |
| `14-security-and-privacy.md` | Useful baseline; isolation, provider, privileged, protocol, supply-chain, incident gaps (CAR-001/002/014/015/019). |
| `15-audit-and-observability.md` | Good correlation/redaction intent; privileged integrity and retention incomplete (CAR-014). |
| `16-testing-and-environments.md` | Broad coverage; accessibility/evidence fixtures/oracles incomplete (CAR-022/025). |
| `17-deployment-and-operations.md` | Sensible process classes; no deployable availability/recovery decision (CAR-005/013/024). |
| `18-capability-traceability.md` | 58 entries present; several structures and blocker sets are wrong (CAR-020). |
| `19-risks-and-decisions.md` | Risks candid; PO-DEC-10 is flagged yet its recommendation is assumed (CAR-016). |

### ADRs 0001–0015

All statuses were checked and remain `PROPOSED`.

| ADR | Quality/conclusion |
|---|---|
| ADR-0001 Application topology | Initial decision reasonable; unit-of-work and runtime boundaries require revision (CAR-005/017). |
| ADR-0002 Primary technology stack | Internally conflicts with ADR-0006 and leaves key choices unverified (CAR-005/024). |
| ADR-0003 Database/tenancy | Shared schema is viable only after transaction-local RLS redesign (CAR-002). |
| ADR-0004 Authorization | Approved model preserved; normative precedence/freshness absent (CAR-008). |
| ADR-0005 Entitlements | Separation is sound; dependency/disable semantics and PO-DEC-10 boundary incomplete (CAR-008/016). |
| ADR-0006 Solver | Solver-neutral port sound; runtime, compiler, reproducibility, cancellation, explanation incomplete (CAR-005/006). |
| ADR-0007 Schedule versioning | Intended immutability sound; database constraints contradict it (CAR-007). |
| ADR-0008 Picklist transport | Server-authoritative WebSocket appropriate; winner constraint is insufficient (CAR-003). |
| ADR-0009 Jobs/events | Transactional outbox appropriate; cross-module ownership and external ambiguity need refinement (CAR-010/017). |
| ADR-0010 Notifications | Separation/providers appropriate; push/retry/acknowledgement contract incomplete (CAR-009/010). |
| ADR-0011 Ingestion privacy | Approved ownership retained; technical boundary does not meet the decision (CAR-004). |
| ADR-0012 Connectors | Port/provenance suitable; inherits unsafe ingress and unresolved vendor evidence (CAR-004/025). |
| ADR-0013 Audit | Application append-only is useful but not tamper evidence against privileged actors (CAR-014). |
| ADR-0014 Artifact storage | S3-compatible boundary is reasonable; report snapshot/current authorization and provider policy incomplete (CAR-012/019/024). |
| ADR-0015 Deployment | Consequences candid; too many central decisions remain open for approval (CAR-005/013/024). |

### Other package artifacts

- `README.md`, `architecture-manifest.json`, and `validate.py` were reviewed independently rather than treated as evidence of correctness.
- All five diagram sources were reviewed. They match the high-level containers/layers but do not resolve the transaction, runtime, or coordinator defects.
- Both draft instruction files were reviewed; see CAR-023.
- `references/official-technical-sources.md` was reviewed. Its official-source boundary is appropriate, but several `VERIFY` decisions remain outstanding.

## 9. PO-DEC-10 conclusion

The discrepancy is real and is not an intentional supersession in the available record.

- **Exact source:** [report 17 PUB-064](../../../schedulepoint-research/reports/17-public-source-gap-addendum.md) states the public commercial claim “part-time locums free, full-time locums charged at the staff rate”; the next paragraph identifies its dependence on Locum role and an FTE threshold. Report 17's decision table creates `PO-DEC-10 — Locum billing rule` and recommends deriving billing from, rather than embedding it in, scheduling data.
- **Product-decision status:** It is a proposed product-boundary/commercial decision, not an approved decision. The public claim alone does not establish that billing belongs inside SchedulePoint.
- **Capability mapping:** If external commercial policy, it consumes CAP-005/CAP-013 membership role/FTE and may influence CAP-057 packaging; CAP-025 locum preference is a separate scheduling rule. CAP-011 stipend amounts are not billing. If SchedulePoint calculates invoices or billing eligibility, the 58-capability baseline lacks a billing capability.
- **Supersession:** No register entry records deprecation, replacement, or intentional supersession. Report 24 omits it and reuses historical decision IDs for other topics, so absence cannot safely be read as a decision.
- **Architecture assumption:** Architecture document 19 explicitly adopts the report-17 recommendation while calling the decision unresolved. No billing module, record, effective-date rule, or downstream contract implements that assumption.
- **Traceability impact:** The missing canonical row prevents determining scope, owner, gate, and whether FTE/role changes require commercial audit. It can affect entitlements/packaging and locum handling; it does not automatically affect clinical stipends or opportunity priority.
- **Recommended correction:** Restore PO-DEC-10 to the canonical decision register as pending, or formally supersede it without reusing the ID. The product owner must choose between an external commercial-policy boundary with a documented read-only domain projection, and a first-class product billing capability with full architecture/traceability. No register was edited in this review.

## 10. Areas accepted and areas requiring remediation

### Architecture areas accepted at proposal-direction level

- Product name and authoritative 58-capability scope
- Automated scheduling as mandatory for production; manual scheduling only as override/fallback/recovery
- Modular monolith as the initial topology
- PostgreSQL as the transactional source of truth, subject to CAR-002/CAR-007
- Organization/group tenant keys and composite foreign-key intent
- Four-layer authorization and separate entitlement concepts, subject to CAR-008
- Transactional outbox and domain-event separation from provider success
- Immutable-version publication intent and revision-by-new-version outcome
- Solver-neutral domain port and CP-SAT as a candidate technology, subject to runtime/model proof
- Server-authoritative picklist transport and persist-before-broadcast ordering
- Generic connector ports, batch provenance, reconciliation, and connector certification intent
- Tenant-prefixed private artifact storage, document scanning/versioning, and revocable calendar tokens
- OpenTelemetry correlation/redaction intent and broad test-environment taxonomy
- Clean-room/source-boundary compliance

These acceptances are not gate passes and do not override any finding.

### Architecture areas requiring remediation

- Request/tab context and transaction-local RLS isolation
- Picklist aggregate, turn CAS, total event order, timers, correction/reopening, and coordinator fencing
- Trusted raw-ingress/privacy boundary and elimination of semantic/free-text identifier paths
- Supported solver runtime, typed/versioned rule model, cancellation, reproducibility, explainability, quality and benchmark evidence
- Schedule/assignment version identity, coexistence constraints, database-enforced published immutability, and publication recovery
- Authorization precedence, dependency semantics, cache invalidation, job/real-time reauthorization, and revocation
- Push secret storage and provider delivery/callback/acknowledgement contracts
- Typed request/vacation subtype constraints, quota concurrency, withdrawal/application semantics
- Report snapshot, execution/download authorization, sharing and revocation
- Marketplace stale-version/lock/deadlock transactions
- Deployment platform, HA/fencing, residency, RPO/RTO, DR, migration rollback, capacity and cost
- Privileged audit integrity, retention/deletion/legal hold, incident response and supply-chain security
- Accessibility interaction acceptance matrix and deterministic evidence fixtures
- Trace/manifest semantic validation, all seven architecture blockers, and draft repository safeguards
- Product-owner disposition of PO-DEC-10 and pending choices that the schema currently assumes

## 11. Review-completion validation record

| Required validation | Result |
|---|---|
| Every required review area addressed | Confirmed in §§5 and 10 |
| Every architecture document 01–19 reviewed | Confirmed in §8 |
| All 15 ADRs reviewed | Confirmed in §8; all remain `PROPOSED` |
| All 58 capabilities independently checked | Confirmed in §6 |
| All seven former architecture blockers examined | Confirmed in §6 |
| All 39 unique SBX tests checked | Confirmed in §7 |
| PO-DEC-10 investigated | Confirmed in §§3/CAR-016 and 9 |
| Finding IDs unique | CAR-001 through CAR-027, no duplicates |
| Every finding includes every required field | Confirmed by review-report lint |
| Severity definitions applied without inflation | Confirmed; four severe isolation/privacy/integrity paths are Critical |
| Optional improvements separated from defects | Confirmed in §4 |
| Architecture/research source files modified | No |
| Application code, migrations, services, UI, infrastructure, or deployment resources created | No |
| ADR status changed | No |
| Production or connector gate marked passed | No |
| Relative/internal links | Confirmed by link check |
| Sanitization | Confirmed clean by pattern scan |
| Existing research validator rerun after review | Passed |
| `python3 docs/architecture/validate.py` rerun after review | Passed, 39/39 assertions |

## Overall recommendation

**REDESIGN REQUIRED**
