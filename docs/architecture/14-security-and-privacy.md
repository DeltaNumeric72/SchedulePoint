# 14 — Security and Privacy

**Status: `PROPOSED`.**

> **No compliance claim is made.** This document does **not** assert HIPAA, PHIPA, SOC 2, ISO 27001, or any other certification or readiness. §11 identifies the legal and operational work such a claim would require — work that has not been done.

---

## 1. Threat model

**Method:** each threat states what an attacker achieves, the primary control, the defence-in-depth control, and how it is verified. Threats are drawn from the research corpus's observed and inferred risks, not invented.

| ID | Threat | Attacker achieves | Primary control | Defence in depth | Verified by |
|---|---|---|---|---|---|
| **T-01** | **Tenant isolation failure** | Reads another organization's schedule, roster, or documents | Server-resolved tenant context; capability policy on every route | **PostgreSQL RLS** with `FORCE`; composite FK consistency | SBX-004 |
| **T-02** | **Authorization bypass** | Performs an action they lack capability for | Deny-by-default; route-level policy declaration; **build fails on an undeclared route** | RLS; object-level checks | SBX-001, SBX-002 |
| **T-03** | **Direct-object access (IDOR)** | Reads/mutates a record by guessing an identifier | Opaque UUID keys; **every fetch tenant-scoped** | RLS | SBX-004 |
| **T-04** | **Cross-tenant cache leakage** | Sees cached data from another tenant | **Mandatory key prefixing via a builder; no raw cache-key API exposed** | Defer distributed caching until measured need | Integration test |
| **T-05** | **Privilege escalation** | Grants themselves capabilities | Grant changes require an explicit capability and are audited both directions | Separation of entitlement from permission | SBX-002 |
| **T-06** | **Impersonation abuse** | Acts as another user without trace | Distinct capability; **time-limited; banner-visible; credential screens barred** | Every action records `onBehalfOf` | SBX-005 |
| **T-07** | **Session theft** | Uses a stolen session | `HttpOnly`+`Secure`+`SameSite`; bounded idle **and** absolute lifetimes; rotation on privilege change | MFA; suspension invalidates sessions immediately | SBX-006 |
| **T-08** | **Real-time subscription leakage** | Subscribes to another tenant's picklist | **Tenant context resolved at connect from the session**, not from subscribe | Per-topic authorization; denials logged as security events | SBX-023 |
| **T-09** | **Calendar-token leakage** | Reads a schedule via a leaked feed URL | **Hash-stored, revocable, rotatable, single-membership, read-only; no PII in URL** | Owner notified on issue/rotate/revoke | SBX-031c |
| **T-10** | **Report leakage** | Downloads another tenant's report | Generated under requester context; **access re-checked at download**; per-tenant storage prefix | Short-lived signed URLs; expiry | SBX-031a |
| **T-11** | **Document leakage** | Retrieves a file via a stale or guessed URL | Signed short-lived URLs; **no public objects**; purge invalidates | Per-tenant prefixes; scan before availability | SBX-031b |
| **T-12** | **Notification abuse / phishing** | Sends messages from a trusted domain | **Recipients resolve only from the roster — never free text**; rate-limited | Sender identity unambiguous; every broadcast audited | SBX-030a |
| **T-13** | **Stored content injection (XSS)** | Executes script in another user's session | **Server-side sanitisation with an allowlist**; output encoding at every render site including exports and emails | Strict CSP blocking inline execution | Security test |
| **T-14** | **Malicious import** | Injects content or identifiers via a connector | **Positive-allowlist ingestion boundary** ([12](12-integrations-and-ingestion-privacy.md)) | Quarantine; sanitised logs; no payload in queues | SBX-029 |
| **T-15** | **Queue poisoning** | Causes a worker to execute attacker-controlled data | Jobs carry **references, not payloads**; payloads validated before enqueue | Worker refuses a job with no tenant context | Integration test |
| **T-16** | **Connector compromise** | Uses a compromised connector to exfiltrate or inject | Connector **cannot bypass** the boundary; routing from the connection record, **never payload content** | Credentials in a secret store via `auth_ref`; certification | SBX-028, SBX-029 |
| **T-17** | **Concurrent claim exploitation** | Double-books an opportunity or work item | **Atomic conditional claim; database uniqueness constraint decides** | Re-validation at claim time | SBX-014b, SBX-022 |
| **T-18** | **Picklist race** | Two people receive the same room | **Partial unique index on `selections`** | Server-authoritative turn state | SBX-022 (≥50 trials) |
| **T-19** | **Audit tampering** | Alters or deletes history to hide an action | **Append-only; no update/delete operation exists; grants withhold them** | Correlation ids; restore rehearsal verifies integrity | SBX-035 |
| **T-20** | **Sensitive logging** | Reads PII or clinical content from logs | **Ingestion payloads never logged**; error scrubbing on by default | Structured logging with an allowlist of fields | Log-review test |
| **T-21** | **Backup exposure** | Reads a backup containing sensitive data | Encrypted at rest; access-controlled; **restricted restore path** | **The ingestion boundary means patient data was never there to back up** | SBX-035 |
| **T-22** | **Account takeover** | Gains control of an account | Strong hashing; MFA; lockout and rate limiting; **single-use expiring invitation tokens** | Notification to the owner on credential change | SBX-005 |
| **T-23** | **Third-party identifier leakage** | Correlates a user to the product via an external service | **SP-HR-1: no email, email-derived hash, or equivalent identifier reaches any third party.** Local initials or org-managed avatars | **CI guard failing the build on any new third-party host** | QA-SEC-001..003 |

**T-23 is deliberately included as a first-class threat.** It is the one privacy failure the research *observed directly* — a hashed email sent to a third-party avatar service on every page load, for every user, with no consent. SchedulePoint's control is a build-breaking CI guard rather than a code-review convention.

---

## 2. Authentication

| Control | Requirement |
|---|---|
| Identity | Email as username; **immutable** on the account |
| Credentials | Modern memory-hard hashing; never logged; never returned by any API |
| **MFA** | TOTP minimum; **required for elevated roles**. The source offers none — this is a deliberate gap-closing choice |
| **SSO** | OIDC, per-organization. Designed for now; shipped when a customer requires it |
| Invitation | **Single-use, expiring, revocable**, and **separate from password reset** (CAP-009) |
| Password reset | Emailed link; single-use; expiring; **does not double as activation** |
| Lockout | Progressive delay plus rate limiting; **does not distinguish "no such account" from "wrong password"** |

**PO-DEC-09 (MFA/SSO scope) remains pending.**

---

## 3. Session management

Server-side sessions; `HttpOnly`+`Secure`+`SameSite`; **bounded idle and absolute lifetimes**; rotation on privilege change and on impersonation start/end; persistent option scoped to personal devices; suspension or deactivation **invalidates live sessions immediately**.

---

## 4. Web hardening

| Control | Requirement |
|---|---|
| **CSRF** | Anti-forgery token on every state-changing request; `SameSite` as a second layer |
| **CSP** | Strict; **blocks inline script**; no third-party script hosts (supports T-23) |
| **Secure headers** | HSTS, `X-Content-Type-Options`, `Referrer-Policy`, frame-ancestors denial |
| **Referrer policy** | Restrictive — URLs must not leak in `Referer` |
| **Rate limiting** | Per session and per IP on authentication, messaging, report generation, and imports |
| **Input validation** | Schema-validated at the boundary; **unknown keys stripped by default** |

---

## 5. Encryption and key management

| Layer | Requirement |
|---|---|
| Transit | TLS everywhere, including internal hops |
| At rest | Database and object storage encrypted |
| **Secrets** | Managed secret store. **Never in the repository, never in env files committed to source.** Connector credentials referenced by `auth_ref` |
| Tokens | **Hash-stored** — calendar feed tokens, session tokens, invitation tokens, push tokens |
| Key rotation | Documented rotation for provider credentials and signing keys |

---

## 6. Audit integrity

Append-only by construction: **no update or delete operation exists** in the audit module, and the application role holds no such grant (D-8). Every entry carries actor, `onBehalfOf`, action, target, before/after, mechanism, correlation id, source channel, and timestamp.

**`before`/`after` payloads must never embed PII or clinical content** — an audit trail must not become the store of exactly the data other controls exclude. Restore rehearsal (SBX-035) verifies audit history survives recovery intact.

---

## 7. Data retention and deletion

| Class | Policy |
|---|---|
| Audit events | **Indefinite** |
| Schedule history | Indefinite |
| Requests, vacation | Retained; PII minimised on account archive |
| Notification bodies | Rolling window; **outcomes retained longer than content** |
| Documents | Per-organization policy; purge invalidates URLs |
| Report artifacts | Expiring by default |
| Sessions, invitations, feed tokens | Purged after expiry; **revoked tokens retained for audit** |
| Ingestion payloads | **Never persisted** |

**Account deletion is deactivation and archival, never hard deletion**, where history or audit references the account. Hard-deleting a user who holds assignments would corrupt exactly the record an audit trail exists to preserve.

---

## 8. Abuse prevention

Rate limits on messaging, report generation, imports, and authentication. Volume anomalies alert. Bulk sends audited with recipient count and actor. Broadcast recipients constrained to the roster.

---

## 9. Vulnerability and dependency management

| Control | Requirement |
|---|---|
| Dependency scanning | In CI, failing on known-exploitable vulnerabilities |
| **Licence review** | Before first release, and on every new dependency |
| Third-party host guard | **CI fails the build on any new outbound host** (T-23) |
| Patch cadence | Documented SLA by severity |
| Penetration testing | Before production; scope includes tenant isolation and authorization |

---

## 10. Incident response considerations

Identified, **not yet designed**: severity classification · on-call rotation · **breach-notification obligations, which are jurisdiction-specific and require legal input** · forensic preservation (audit immutability supports this) · customer communication · post-incident review.

**This is a gap, and naming it as one is the honest position.** A production release requires an incident-response plan; producing one requires legal and operational input this architecture task did not have.

---

## 11. Compliance — what is *not* claimed

**No certification or compliance readiness is claimed.** Specifically, this proposal does **not** assert HIPAA, PHIPA, SOC 2, ISO 27001, GDPR, or any equivalent.

**Work that a credible claim would require, none of which has been done:**

| Requirement | Status |
|---|---|
| Legal determination of applicable regimes per jurisdiction and customer | **Not done** |
| Data-processing agreements and business-associate agreements | **Not done** |
| Formal risk assessment and treatment plan | **Not done** |
| Documented policies (access, retention, incident, change, vendor) | **Not done** |
| Independent audit or assessment | **Not done** |
| Evidence collection and control-operation records | **Not done** |
| Data-residency determination | **Not done** — see [17](17-deployment-and-operations.md) §9 |
| Sub-processor inventory and review | **Not done** |

**What the architecture does provide** is a foundation that makes such work tractable: tenant isolation, append-only audit, encryption, retention controls, minimisation, and — most importantly — **a platform-enforced boundary that keeps patient-identifying data out entirely**, which materially narrows the regulatory surface. That is a genuine advantage, and it is still not a compliance claim.

---

## 12. Capability and gate mapping

CAP-003, CAP-005..CAP-010, CAP-042, CAP-047, CAP-048, CAP-062, CAP-068.

**ADRs:** ADR-0003, ADR-0004, ADR-0011, ADR-0013, ADR-0014.

**Gates:** `G-PROD` (§3.22–3.23 of report 24), `G-CONN` (de-identification). **No gate passed.**
