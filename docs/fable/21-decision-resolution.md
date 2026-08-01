# 21 — Decision Resolution Record

**Authority:** the product owner's "Expanded decision authority and final planning mandate" (2026-08-01) delegated all remaining product, architecture, planning, sequencing, and quality-gate decisions to the Fable orchestrator, reserving only purchases/contracts, production accounts/domains/credentials, real-hospital connections, real personal/clinical data, real notifications, legal representations, and production deployment. **This document is the auditable resolution record** for every formerly blocking or owner-dependent decision. Decision priority order applied throughout: observed behaviour → corpus-supported behaviour → functional parity → internal consistency → safe modern implementation → good enterprise behaviour → simplest extensible design.

**Reversibility scale:** R1 = trivially reversible (config/doc) · R2 = reversible with bounded rework (one milestone or less) · R3 = expensive to reverse (schema/architecture migration) · R4 = effectively permanent.

---

## 1. Formerly blocking gates (D-A..D-D)

### FD-1 — Plan ratification (was D-A)
**Decision:** the docs/fable/00–20 plan (roadmap, parity framework, runbook) is **ratified**, as amended by this record. **Evidence:** the plan is additive to the corpus, changes no previously-approved decision, and passed the corpus validators. **Alternatives:** re-plan from scratch (no defect found that justifies it). **Parity effect:** none (process). **Risk:** self-ratification bias → mitigated by FD-2's independent verification of the highest-risk substrate. **Reversibility:** R1. **Follow-up:** plan validator (§7) enforces internal consistency continuously.

### FD-2 — Independent review strategy (was D-B)

> **AMENDED same day (V-04).** The first version of this decision called the external re-review "advisory." The internal verification correctly objected: the Codex upgrade condition — only an independent review can upgrade `REDESIGN REQUIRED` — is not within the delegation to waive. The wording below is the corrected decision.

**Decision:** two-tier. **(a)** An **internal adversarial verification review** of the highest-risk remediations (CAR-001/002/003/004/007/008/011 against SPEC-01/02/03/05/06/08) was **commissioned 2026-08-01** from an independent Opus sub-agent with no authorship stake; report at [docs/reviews/architecture/internal-verification-2026-08-01.md](../reviews/architecture/internal-verification-2026-08-01.md). Verdict: **`VERIFIED WITH CORRECTIONS NEEDED`** (29 findings); all findings are dispositioned in [docs/architecture/remediation/internal-verification-corrections.md](../architecture/remediation/internal-verification-corrections.md) and the corrections are applied. Its dispositioned findings gate M1 schema freeze. **(b)** The **external independent re-review remains REQUIRED — it is a blocking entry condition for controlled beta** (M10 exit), and until it upgrades the verdict **the architecture remains `PROPOSED` and is not approved**. What the delegation changes is sequencing only: implementation up to beta entry proceeds on internal verification plus executable harness evidence (T/P/V tests), at the owner's explicit direction. **Evidence:** the mandate directs not to pause on open review gates; the decisive evidence for the highest-risk mechanisms is executable harnesses, which arrive earlier than any review can. **Alternatives:** external review blocking M1 (idles the project, contrary to mandate); internal-only (rejected — cannot confer independence, as the internal report itself states). **Parity effect:** none. **Risks:** shared model family may under-find (NR-10) — mitigated by the harnesses being the decisive evidence and the external review remaining blocking for beta. **Reversibility:** R1. **Follow-up:** external review commissioned during Stage B against a frozen checkpoint (V-01 rule: the tree stays frozen while a commissioned review is open).

### FD-3 — CAR-026 correction (was D-C)
**Decision:** applied under the mandate's explicit documentation-correction authority: report 18's count corrected to the heading-derived **39** with a dated note; remediation record CAR-026 updated to REMEDIATED with history preserved; validator check 53 continues to re-derive the count. **Reversibility:** R1. **Parity effect:** none.

### FD-4 — First task approval (was D-D)
**Decision:** OPUS-M0-001 and the two subsequent packets ([23-opus-task-packets.md](23-opus-task-packets.md)) are **approved for issuance**, but per this mandate's implementation boundary they are **not executed** — issuance awaits the owner's short implementation-authorization prompt ([24-execution-standards.md](24-execution-standards.md) §G). **Reversibility:** R1.

---

## 2. Product decisions — all 20 resolved

All resolve to the corpus's recommended working default **except where noted with ⚑**; the historical register (report 24 §6 / architecture 19 §2.2) is preserved unmodified with banner amendments pointing here. Blast-radius and alternatives columns of that register are incorporated by reference; rationale below is per-decision where material, grouped where routine.

| ID | Decision | Resolution | Rev | Parity effect |
|---|---|---|---|---|
| **PO-DEC-01** | Site entity | **Attribute (`site_label`) now; entity when a customer's site-scoped workflow demands it** — both migration directions stay pre-modelled (06 §3.2a) | R2 | Source's site concept was never observed as load-bearing (Inferred); no parity loss |
| **PO-DEC-03** | Request model | **One Request aggregate + constrained subtypes + linked vacation lifecycle** — ADR-0016/SPEC-08 stop being "provisional" | R3 (documented in SPEC-08 §8) | Preserves both observed surfaces as views of one lifecycle |
| **PO-DEC-05** | Rule authoring | **Self-service authoring UI + vendor-assisted onboarding path** | R1 | Matches observed self-service admin surfaces |
| **PO-DEC-06** | Multi-org users | **No for first release**; `users` global + per-org memberships keep the door open | R2 | Source evidence showed multi-*group*, never multi-org |
| **PO-DEC-07** | Push channel | **First-class** (SPEC-07 §3 design already complete) | R1 | Closes C-10 in favour of the public claim |
| **PO-DEC-09** | MFA / SSO | **TOTP MFA mandatory for Scheduler/Group Admin/Org Admin and any elevated-grant holder; optional for members. Per-org OIDC SSO designed now (issuer pinning, proof-of-control linking), shipped when first needed** | R1 | ⚑ Intentional redesign — exceeds observed source baseline; classified in [06](06-feature-parity-matrix.md) |
| **PO-DEC-10** | Locum billing | **External commercial policy consuming the versioned read-only membership/FTE projection; no billing capability** | R1 | Public claim PUB-064 satisfied outside the product |
| **PO-DEC-11** | Impersonation | **Ship: audited, banner-visible, time-limited, barred from credential screens** | R1 | Preserves observed capability, closes observed audit absence |
| **PO-DEC-12** | Qualifications | **Administrator-granted with evidence reference and expiry; expiry hard-blocks eligibility at build time and warns at assignment time** | R2 | Patient-safety-adjacent: fail-closed default chosen deliberately |
| **PO-DEC-13** | Conflict taxonomy | **Four classes: hard breach / unmet demand / eligibility failure / fairness outlier** — plus severity ordering and per-class display rules in SPEC-04 terms | R1 | Ours by necessity (source build output never observed) |
| **PO-DEC-14** | Vacation default | **Quota/grant mode default; open mode per-group configurable** | R1 | Matches observed quota surfaces |
| **PO-DEC-15** | Opportunity recipients | **All eligible group members, opt-out honoured** | R1 | Matches observed fan-out claim |
| **PO-DEC-16** | Staff-over-locum window | **Configurable, default 24h** | R1 | Preserves observed staff-priority rule |
| **PO-DEC-17** | Swap review | **Counterpart acceptance always; scheduler review per-group toggle, default ON** ⚑ (default ON, stricter than the register's neutral default: safest for a first reconstruction round, one-click loosening) | R1 | Source lifecycle Unknown; conservative default |
| **PO-DEC-19** | Proxy scope | **Act-on-behalf, fully attributed** | R1 | Matches observed proxy concept |
| **PO-DEC-20** | Directory visibility | **Person accounts with an active membership; functional accounts opt-in; contact fields role-gated** | R1 | Resolves C-06 explicitly |
| **PO-DEC-21** | Group email identity | **Outbound-first on a vendor-managed domain** | R1 | Resolves C-11 minimally |
| **PO-DEC-22** | Document retention | **Policy-driven per organization, default indefinite** | R1 | No source retention behaviour observed |
| **PO-DEC-23** | Solver targets | **Report 21 §8.3 conservative targets adopted as the published commitments; benchmark bands at M6 must be ≤ these targets (NR-8 guard)** | R1 | Public speed claim never repeated as ours |
| **PO-DEC-04** (commercial half) | Packaging | **Provisional: single edition, all modules entitled ON for test/beta tenants; commercial packaging deferred** — pricing/contracting is reserved-adjacent and does not block any milestone | R1 | Entitlement mechanics (approved half) unaffected |

**Grouped rationale for the R1 rows resolving to defaults:** each default was already the corpus's recommendation with documented alternatives and blast radius; no new evidence contradicts any of them; adopting defaults maximizes internal consistency (priority 4) at minimal reversal cost; and the pending-decision CI guard now flips meaning — it verifies the *resolved* branch is the one implemented.

---

## 3. Technology selections (TDG-01..15)

**Standing rule preserved:** SPEC-15's "a gate closed without its spike is reopened" stands. The selections below are **decided pending spike confirmation** — they unblock all planning and packet-writing now; the M0 spikes are confirmation runs whose failure reopens only the affected row. Every selection records product, alternatives, reason, replacement boundary.

| Gate | Selection | Alternatives considered | Reason | Replacement boundary | Rev |
|---|---|---|---|---|---|
| **TDG-01** Web framework | **Fastify** (TypeScript, plugin/hook middleware, streaming, `@fastify/websocket`, enumerable route table) | Express (weaker typing/lifecycle, no route enumeration), NestJS (heavy DI, hides control flow), Hono (young ecosystem) | Middleware composition for context/authz/correlation; route enumeration feeds the undeclared-route CI check (SPEC-06) | Handlers are thin adapters; domain has no framework imports | R2 |
| **TDG-02** Data layer | **Kysely** (typed query builder) over **`pg`**, with raw-SQL escape hatch; migrations = **plain versioned SQL files** run by `node-pg-migrate` under the migration role | Prisma (hides transactions/connection lifecycle — disqualifying for SET LOCAL discipline), Drizzle (viable runner-up), TypeORM (heavy, leaky) | Caller-controlled transactions are first-class → `set_config(...,true)` trivially inside the unit-of-work; no hidden checkout; exclusion constraints/triggers live in SQL migrations natively | Repository interfaces in domain; Kysely confined to infra layer | R2 |
| **TDG-03** Pooling | **In-process `pg.Pool`** per process class; unit-of-work pins one client per transaction. If an external pooler is ever needed: **PgBouncer in transaction mode**; statement mode prohibited (S-03b) | External pooler now (unneeded at this scale) | Transaction affinity by construction; T-14 harness proves reuse safety | Config-level | R1 |
| **TDG-04** Queue | **graphile-worker** — transactional enqueue via SQL `add_job()` inside the domain transaction (the outbox property, I-11), lease-based claims, retries, permanent-failure table | pg-boss (good; enqueue-in-caller-txn less direct), BullMQ/Redis (non-transactional enqueue — disqualifying), SQS (vendor boundary too early) | The one hard requirement is enqueue-with-domain-commit; graphile-worker does it natively | `JobQueue` port; handlers plain functions | R2 |
| **TDG-05** AuthN/OIDC | **argon2id** hashing · **otplib** TOTP · PG-backed server-side sessions with rotation · **openid-client** (certified) for per-org OIDC with `iss` pinning + proof-of-control linking | Auth0/Clerk-class IDaaS (vendor DPA + residency questions for healthcare-adjacent PII; reserved procurement) | First-party keeps identity data in-region and matches SPEC-11 controls | AuthN behind an identity module port | R2 |
| **TDG-06** Notification providers | **Provisional (procurement reserved):** email = **Postmark-class transactional** (dev: Mailpit) · SMS+voice = **Twilio Programmable Messaging/Voice** · push = **Web Push/VAPID (`web-push`)**. All behind ports; contract tests run against **fault-injected fakes** until accounts exist | SES (email alternative, kept warm), Vonage (SMS alt) | Capability declarations (SPEC-07 §4.3) drafted against these; DPAs + accounts are reserved owner actions and block **real sends only** — never planning or fake-backed milestones | Provider ports; fakes implement the same contract | R1 |
| **TDG-07** Report renderer | **Headless Chromium via Playwright**, first-party templates only, **network-disabled context**, embedded fonts, per-job CPU/memory/time bounds | WeasyPrint (adds Python to app path), Typst (young), LaTeX (operational burden) | Already a project dependency; SP-7 proves the no-fetch/no-script sandbox | Renderer behind a port; templates are renderer-neutral HTML | R2 |
| **TDG-08** iCalendar | **ical-generator** + RFC 5545 conformance fixtures + consumer matrix (Google/Apple/Outlook) at M11 | hand-rolled (error-prone) | Mature, typed | Feed builder isolated | R1 |
| **TDG-09** Object store | **S3 with Object Lock + versioning** (provisional prod) · **MinIO** (local/dev, object-lock capable) | GCS/Azure (fine; follows OI-3), | Object-lock is required by audit A2 (SPEC-11 §3.1) | S3-compatible API only | R1 |
| **TDG-10** Malware scan | **ClamAV** (containerized), fail-closed, bounded decompression | Vendor scanning APIs (sends customer files to a third party — needs DPA first) | Self-hosted keeps documents in-boundary | Scanner port | R1 |
| **TDG-11** Hosting | **Provisional: AWS — ECS Fargate (three images; ALB with long idle timeout for WebSockets; CPU-optimized capacity for solver), RDS PostgreSQL Multi-AZ (sync standby), S3, Secrets Manager.** Account creation/funding is **reserved**; all pre-deployment work is local/CI containers | GCP/Cloud Run + Cloud SQL (viable), Fly/Render (weaker managed-PG story for sync-standby requirement) | Satisfies SPEC-10 §2 (managed platform + managed PG + managed object store + secret store); aligns with OI-3 residency default | Everything is OCI images + PG + S3 API — the portable set | R2 |
| **TDG-12** Observability backend | **Self-hosted OTel Collector → Grafana stack (Tempo/Loki/Mimir)**, redaction processors at the collector, in-region | Datadog/Honeycomb (better ergonomics; requires vendor DPA + egress of telemetry — deferred until LEGAL-1) | "Redaction before egress" is trivially true when there is no egress | OTel protocol is the boundary; vendor swap is config | R1 |
| **TDG-13** Secret store | **AWS Secrets Manager** (provisional, with TDG-11) · local/dev: **SOPS + age** | Vault (operational weight) | Envelope encryption + rotation + IAM trust-domain separation | Secret access behind a tiny provider interface | R1 |
| **TDG-14** UI stack | **React 18 + TypeScript + Vite · TanStack Router/Query · Radix UI primitives (headless, accessibility-first) + Tailwind design tokens · TanStack Virtual for the grid · zod-derived typed API contracts** | Full SSR framework (Next.js — unneeded for an authenticated app, heavier operational surface); Angular/Vue (team-consistency with TS/Node favors React); component kits with baked-in styling that fight SPEC-14 (disqualified by the gate itself) | Radix satisfies "accessible by default"; headless primitives + tokens let SPEC-14's matrix bind to our own components; grid must be built on primitives anyway (02 §2.4) | Design tokens + component contracts independent of library | R2 |
| **TDG-15** Audit signing | **KMS-backed checkpoint signing** (provisional, with TDG-11); local/dev: ed25519 key held by a distinct role | App-held keys (defeats the purpose) | Key isolation from the application role is the entire requirement | Signing behind a port | R1 |

**Architecture note (FAD-4):** TDG-14 resolves doc 02 §2.3's "server-rendered + islands" posture to a **typed-contract SPA + JSON API**. Rationale: every core surface (grid, picklist, requests) is interactive; the app is fully authenticated (no SEO/first-paint-anonymous concern); one rendering model is simpler than two (priority 7); accessibility is governed by SPEC-14 regardless of rendering strategy. This is within TDG-01/14's discretion (the UI row was gated, not decided); recorded in [control/ARCHITECTURE-DECISIONS.md](control/ARCHITECTURE-DECISIONS.md). **Validation library: zod** (positive-allowlist by default — strips unknown keys; I-07 alignment).

---

## 4. Owner inputs (OI-1..7) — provisional defaults

All are planning assumptions; the binding versions (accounts, contracts, spend) remain reserved owner actions that block **deployment**, never planning or local/CI milestones.

| OI | Provisional default | Rationale | Rev |
|---|---|---|---|
| OI-1 RPO | **Zone failure: 0 committed-transaction loss** (sync standby) · **Region failure: ≤ 1h** (continuous cross-region encrypted backup replication) | Matches SPEC-10's synchronous-commit decision; 1h is achievable with WAL archiving without a second live region | R1 |
| OI-2 RTO | **Zone: ≤ 15 min automated failover · Region: ≤ 8 h documented manual rebuild** | States the honest number SPEC-10 required ("hours, stated plainly") | R1 |
| OI-3 Provider/region | **AWS ca-central-1 (Canada)** | The corpus repeatedly signals Canadian healthcare customers (PHIPA named; RISK-25); hosting in Canada satisfies the strictest anticipated residency posture and is acceptable to US customers; reverse is not true | R2 |
| OI-4 Residency | **Single-region; tenant data never leaves ca-central-1 except encrypted backups within Canada** | Simplest posture that de-risks RISK-25 | R2 |
| OI-5 Support model | Business-hours, best-effort through beta; paging rotation defined at G-PROD | Honest for team size | R1 |
| OI-6 Cost envelope | Modest single-region HA footprint; reviewed when the platform account is funded (reserved) | Planning assumption only | R1 |
| OI-7 Commercial | See PO-DEC-04 commercial half (§2) | — | R1 |

## 5. Evidence dependencies (EV-1..8) and LEGAL-1 — provisional resolutions

| EV | Resolution | Blocks what now |
|---|---|---|
| EV-1 vendor connector specs | **Remains external, unchanged** — request letters are an owner action; synthetic canonical-schema fixtures carry all framework work | G-CONN per connector only |
| EV-2 restorable backup access | Satisfied locally (containerized PG + MinIO restore rehearsals in the DR env) before the provisional platform exists; platform-grade rehearsal at M12 | Nothing before M12 |
| EV-3 error-reporting vendor API | **Mooted by TDG-12 self-hosted choice**; reopens only if a vendor is adopted post-DPA | Nothing |
| EV-4 provider sandboxes | **Fault-injected fakes implementing the SPEC-07 capability contracts** carry M7; real sandbox accounts are reserved procurement and gate only the first real send | Real sends only |
| EV-5/EV-6 platform + RPO/RTO | Provisional per §4; local/CI carries everything through M11 | Deployment only |
| EV-7 benchmark bands | Process fixed: bands derived from M6 corpus runs, must be ≤ report-21 §8.3 targets (NR-8 guard), frozen at M6 review | M6 exit |
| EV-8 AT lab | **Provisional matrix:** NVDA+Chrome and NVDA+Firefox (Windows VM) · VoiceOver+Safari (macOS) · VoiceOver (iOS) · TalkBack+Chrome (Android) — all license-free. **JAWS combos = reserved purchase**, marked `pending-procurement` in SPEC-14's matrix; claims are only made per-combo with retained evidence, so the reduced matrix narrows claims, never falsifies them | JAWS rows of SPEC-14 only |
| LEGAL-1 | **Reserved (legal representation).** Provisional posture: PIPEDA/PHIPA-aware design defaults; breach-notification playbook drafted at M11 as policy-pending-counsel; DPAs executed before any real personal data or real sends | Real data/sends; G-PROD legal items |

## 6. Classification of permanently-unobservable behaviour

Ratified per [06-feature-parity-matrix.md](06-feature-parity-matrix.md), with the mandate's four labels mapped: HIGH rows over unobserved lifecycles (swap lifecycle, build execution, picklist execution, delivery behaviour, form validation) = **high-confidence inferred parity** or **equivalent modern behaviour** as marked; REDESIGN rows = **intentional redesign** with per-row justification; PO-DEC-14/16/17/20/22 style rows = **configurable assumptions** (runtime-adjustable). No accidental differences: the matrix's rule — *a difference without a documented row is a defect* — is now enforced in review (runbook) and by the plan validator's parity-total check.

## 7. Cross-cutting resolutions

- **F-05** stale checkout-context sentence in doc 02 §3.2: **corrected** (dated note in place).
- **UX planning:** SP-E remains an M0 deliverable, now with the component stack pre-decided (TDG-14), so it produces the UX brief + tokens + SPEC-14 bindings rather than a library evaluation.
- **Incident response:** severity model + evidence preservation already specified (SPEC-11 §8); full plan + playbooks drafted at M11; tabletop at M12. Unchanged, now owned.
- **Processor register:** instantiated at M7 with the TDG-06 provisional providers as its first draft rows (marked no-DPA-yet, fakes-only).
- **Plan validator:** new `docs/fable/validate.py` (see [22](22-readiness-assessment.md) §4) checks capability coverage, parity totals, milestone mapping, packet references, and absence of unresolved blocking language.
- **Roadmap deltas from these resolutions:** M1 entry = internal-verification findings dispositioned (not external review); external review = REQUIRED, blocking beta entry (M10 exit review; V-04); M0 spikes reworded as confirmations of §3 selections. Applied in [16-implementation-roadmap.md](16-implementation-roadmap.md).

## 8. Documents updated by this resolution

Corpus (with dated banners/notes, history preserved): report 18 (count), report 24 §6 (banner), architecture 19 §2.2 + §3, architecture 02 §3.2 (F-05), remediation record (CAR-026 + status tables). Fable layer: 00, 06, 11, 16, 17, 19, 20 amended; 21–24 created; control documents refreshed. Validators: architecture validate.py check 53 unchanged (self-adjusting); new plan validator added.
