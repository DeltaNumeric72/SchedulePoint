# SPEC-11 — Audit Assurance and Extended Security Boundaries

**Status: `PROPOSED`.** Remediates **CAR-014** (High) and **CAR-015** (High).
**Supersedes:** [14](../14-security-and-privacy.md) §§2–6 and §7; [15](../15-audit-and-observability.md) §1.4.
**ADRs:** [ADR-0013](../decisions/ADR-0013-audit-architecture.md) (revised), [ADR-0019](../decisions/ADR-0019-audit-assurance-level.md) (new).

> **What was wrong.**
> **(CAR-014)** Denying `UPDATE`/`DELETE` to the application role is useful and was **presented as proof that history "cannot be quietly rewritten."** It is not. Migration owners, database owners, platform administrators, and restore tooling can all alter audit rows. There was no tamper-evidence, no external copy, no separation of duties, no privileged-read auditing, and no reconciliation. "Retained indefinitely" also collided with policy-driven deletion and legal obligation, both undecided.
> **(CAR-015)** The threat model omitted WebSocket origin hijacking, callback authentication and replay, OIDC issuer/account-linking, MFA reset and recovery, SSRF, upload bombs, solver resource abuse, privileged insiders, supply-chain provenance, and backup-key compromise. Incident response was named as a gap and left there.

---

## 1. Audit assurance level

**Stated explicitly, because "append-only" without an adversary model means nothing.**

| Level | Protects against | SchedulePoint |
|---|---|---|
| **A0** Application-enforced | Application bugs and ordinary users | Previous design stopped here |
| **A1** + tamper-evident chaining | **Undetected** alteration by a privileged database actor | **Target for `G-BETA`** |
| **A2** + external immutable replication | Alteration by a platform administrator | **Target for `G-PROD`** |
| A3 + third-party notarisation | Collusion including the platform operator | **Not targeted.** Would require a customer requirement and a cost decision that do not exist |

**A2 is the production target. A3 is deliberately not claimed.**

---

## 2. Tamper evidence (A1)

| Element | Design |
|---|---|
| **Hash chain** | Each `audit_events` row carries `sequence` (gapless per organization), `prev_hash`, and `entry_hash = H(prev_hash ‖ canonical(row))` |
| **Chain allocation** | `sequence` and `prev_hash` assigned **inside the writing transaction**, under a per-organization advisory lock, so the chain has no gaps and no forks |
| **Periodic checkpoint** | Every *N* entries and at least daily, a `audit_checkpoints` row records `(organization_id, sequence, entry_hash, signed_at)` **signed with a key the application role cannot read** |
| **Verification job** | Recomputes the chain between checkpoints and alerts on any mismatch |
| **What this gives** | **Detection, not prevention.** A privileged actor who edits a row breaks the chain; one who rewrites the chain cannot forge the signed checkpoints without the signing key |
| **What it does not give** | Protection against an actor holding **both** database access **and** the signing key. That is what A2 addresses |

---

## 3. Privileged actors and separation of duties (A2)

| Actor | Can alter audit rows? | Control |
|---|---|---|
| `app_runtime` / `app_worker` | **No** | No `UPDATE`/`DELETE` grant (D-8) |
| `app_migrator` | Technically yes | **Two-person approval; every migration reviewed and audited; chain verification runs after every migration** |
| Database owner / platform admin | Technically yes | **A2 external replication makes it detectable**; privileged access is itself audited (§3.2) |
| Restore tooling | Yes, by omission | **Chain verification after every restore**; a restore that truncates the chain is detected, and the gap is recorded rather than hidden |
| Cloud provider staff | Outside our control | **Stated honestly as a residual risk (RISK-28).** A3 would be the only answer, and it is not claimed |

### 3.1 External immutable replication (A2)

Audit entries and signed checkpoints are streamed to **write-once storage in a separate trust domain** — separate credentials, separate key, object-lock retention, no delete permission for any runtime or platform role. **Divergence between the primary chain and the external copy is an alert, not a silent repair.**

### 3.2 Privileged access is itself audited

**Every** `app_readonly_support`, `app_breakglass`, and `app_migrator` session records operator identity, ticket reference, statements executed, and rows touched — written to the **same chained audit stream**, so hiding a privileged read requires breaking the chain.

### 3.3 Reconciliation across three sequences

Domain aggregate versions, `outbox_events`, and `audit_events` are reconciled continuously: a committed domain change with no audit entry, an outbox event with no audit entry, or an audit entry with no corresponding domain state each raise an alert. **A missing audit entry becomes an observable defect rather than a silent gap.**

---

## 4. Retention, deletion, and legal hold

**"Indefinite" is replaced by a policy that can actually be operated.**

| Class | Default | Overridable | Notes |
|---|---|---|---|
| Audit events | **7 years**, then tenant policy | By contract | **Not "indefinite"** — indefinite is not a lawful universal answer |
| Signed checkpoints | Same as audit | No | Verification needs them |
| Schedule history | Indefinite while the tenant is active | No | The product's core record |
| Requests, vacation | 7 years | By contract | PII minimised on archive |
| Notification bodies | 90 days; **outcomes 7 years** | Yes | Content and fact retained differently |
| Documents | Tenant policy, default indefinite | Yes | **PO-DEC-22 pending** |
| Report artifacts | 30 days | Yes | Regenerable from manifests |
| Ingestion payloads | **Never persisted** | No | [SPEC-03](SPEC-03-raw-ingress-trust-boundary.md) |

| Operation | Design |
|---|---|
| **Personal-data request** | **Anonymisation, not deletion**: the user record is pseudonymised, contact values purged, and audit rows retain the **pseudonymous actor id**. The chain stays intact because rows are never removed |
| **Anonymisation is audited** | And is itself chained |
| **Legal hold** | A per-organization or per-subject flag that **suspends every retention job**. Release is audited and two-person approved |
| **Tenant deletion** | Anonymise, export on request, then purge after a contractual window — **subject to legal hold** |
| **The honest limit** | **A chained, externally replicated audit trail and unrestricted erasure are in tension.** SchedulePoint resolves it toward anonymisation-with-retention. **Whether that satisfies a given jurisdiction is a legal determination that has not been made** ([14](../14-security-and-privacy.md) §11) |

---

## 5. Extended threat model (CAR-015)

**T-24 through T-38 extend the existing T-01..T-23.**

| ID | Threat | Primary control | Verified by |
|---|---|---|---|
| **T-24** | **Cross-site WebSocket hijacking** | **`Origin` verified at handshake against an allowlist**; session cookie `SameSite`; **a per-connection token bound to the session that the browser will not auto-send cross-origin** | Cross-origin connect test |
| **T-25** | **Provider callback forgery / replay** | Signature verification, timestamp window, unique `provider_event_id` ([SPEC-07](SPEC-07-notification-delivery-contracts.md) §4.5) | N-06, N-08 |
| **T-26** | **OIDC issuer / tenant mix-up** | Issuer, audience, and `nonce` validated; **`iss` pinned per organization**; a token from an unexpected issuer is rejected even if otherwise valid | OIDC conformance test |
| **T-27** | **OIDC account-linking takeover** | **Linking requires proof of control of the existing account**; unverified email from an IdP **never** auto-links | Linking test |
| **T-28** | **Account recovery / MFA reset abuse** | Recovery requires a second factor or an administrator with the recovery capability; **MFA reset is audited, notified, and rate-limited**; a reset invalidates all sessions | Recovery drill |
| **T-29** | **SSRF via connector, document, or report input** | **Egress allowlist per process class**; no user-supplied URL is fetched by a server process; the enclave reaches only its source and the ingress API | Egress test |
| **T-30** | **Upload decompression / archive bomb** | Bounded decompression ratio and depth; **content type from bytes, not the client claim**; scan before availability | F-12 |
| **T-31** | **Solver resource exhaustion** | Per-solve limits, per-org concurrency cap, dedicated pool ([SPEC-10](SPEC-10-deployment-topology.md) §7) | S-16t |
| **T-32** | **Report / export resource abuse** | Rate limits, row caps, queue priority, artifact quota | Load test |
| **T-33** | **Privileged insider (database / platform)** | A1 chaining + A2 external replication + privileged-access auditing + two-person migration | Chain verification drill |
| **T-34** | **Support-tool exfiltration** | Support reads one tenant at a time under RLS; every read audited; **bulk export requires a separate capability and two-person approval** | Support drill |
| **T-35** | **Supply-chain compromise** | **SBOM per image**, dependency scanning, **image signing and provenance attestation**, admission policy rejecting unsigned images, pinned digests | CI policy check |
| **T-36** | **Backup-key compromise** | Backup keys in a **separate trust domain** from runtime keys; separate rotation; **access two-person and audited** | Key drill |
| **T-37** | **Secret sprawl** | Managed store only; **no secret in a repository, image, or environment file in source**; automated scanning in CI | Secret scan |
| **T-38** | **Enclave compromise** | No database credential, no disk, egress allowlist, separate image and patch stream ([SPEC-03](SPEC-03-raw-ingress-trust-boundary.md) §3) | I-12 |

---

## 6. Key management

| Key class | Trust domain | Rotation | Access |
|---|---|---|---|
| Database encryption | Provider-managed | Provider policy | Platform |
| **Delivery-material envelope** ([SPEC-07](SPEC-07-notification-delivery-contracts.md) §3) | Application secret store | Scheduled; versioned per row | **Delivery worker only** |
| **Audit checkpoint signing** | **Separate domain** | Scheduled; old public keys retained for verification | **Signing service only — never the application** |
| Session and token hashing | Application secret store | Scheduled | Runtime |
| **Backup encryption** | **Separate domain (T-36)** | Independent | Two-person |
| Connector credentials | Secret store via `auth_ref` | Per-connector policy | Worker |

**Key compromise procedure per class**, including which data must be considered exposed and what re-encryption is required. **Not yet written** — §8.

---

## 7. Supply chain

SBOM generated per image (`app`, `solver`, `ingress`) and retained per release · dependency scanning failing the build on known-exploitable vulnerabilities · **images signed; provenance attestation produced at build; the platform admission policy rejects unsigned or unattested images** · base images pinned by digest · **patch SLA: critical 72 hours, high 7 days, medium 30 days, low next scheduled release** · licence review before first release and on every new dependency · **the Python solver image carries its own SBOM, scan, and patch stream** (CAR-005 consequence).

---

## 8. Incident response

**Previously named as a gap and left there. Now specified in structure, with the parts requiring legal input named as such.**

| Element | Status |
|---|---|
| Severity classification (S1–S4) with response times | **Specifiable now** — drafted as part of the runbook set |
| On-call rotation and escalation | **Owner input** ([SPEC-10](SPEC-10-deployment-topology.md) OI-6) |
| **Evidence preservation** | **Specifiable now**: on declaration, snapshot the audit chain and checkpoints, preserve logs beyond normal retention, apply legal hold, capture container and image digests. **The chained audit trail is what makes forensic reconstruction possible** |
| Containment playbooks | Per T-24..T-38; **not written** |
| **Credential and key rotation procedure** | Per §6; **not written** |
| **Breach-notification obligations** | **Legal determination. Jurisdiction-specific. Not made** |
| Customer communication | **Owner input** |
| Post-incident review | Specifiable now; not written |
| **Tabletop exercise** | **Required before `G-PROD`; not run** |

**The structure is now designed; the plan is still not written, and the legal determination is still not made. Both are stated as blocking rather than absorbed into a claim of readiness.**

---

## 9. Compliance position — unchanged

**No certification or readiness is claimed.** [14](../14-security-and-privacy.md) §11's eight-item "not done" table stands. This specification **improves the evidence base** — chained audit, external replication, provenance, key separation, retention policy — **and changes nothing about what may be claimed.**

---

## 10. Test contract

| # | Test | Required outcome |
|---|---|---|
| X-01 | Edit an audit row as `app_migrator` | **Chain verification detects it** |
| X-02 | Rewrite a chain segment consistently | **Checkpoint signature mismatch detected** |
| X-03 | Restore to a point, verify chain | Continuity proven, or **the gap is explicitly recorded** |
| X-04 | Delete from the external copy as a runtime role | **Denied by object-lock retention** |
| X-05 | Domain change with a suppressed audit write | **Reconciler alerts** |
| X-06 | Legal hold during a retention run | **Nothing deleted** |
| X-07 | Personal-data request | Anonymised; **chain intact**; pseudonymous actor retained |
| X-08 | Cross-origin WebSocket connect | **Rejected** |
| X-09 | Replayed and forged provider callbacks | Rejected; security event |
| X-10 | OIDC token from an unexpected issuer | Rejected |
| X-11 | Account link with an unverified IdP email | **Refused** |
| X-12 | MFA reset | Audited, notified, sessions invalidated |
| X-13 | SSRF attempt via connector, document, and report inputs | Blocked by egress allowlist |
| X-14 | Archive bomb | Bounded and rejected |
| X-15 | Unsigned image deployment | **Rejected by admission policy** |
| X-16 | Secret committed to the repository | **CI fails** |
| X-17 | Support bulk export without two-person approval | Denied |
| X-18 | Incident tabletop with key rotation and evidence capture | Completed with retained evidence |

---

## 11. Traceability

**Capabilities:** CAP-003, CAP-008, CAP-009, CAP-010, CAP-027, CAP-032, CAP-040, CAP-041, CAP-046, CAP-048, CAP-051, CAP-055, CAP-062, CAP-068.
**Decisions:** PO-DEC-09, PO-DEC-11, PO-DEC-22 — **all pending.**
**ADRs:** [ADR-0013](../decisions/ADR-0013-audit-architecture.md) (revised), **[ADR-0019](../decisions/ADR-0019-audit-assurance-level.md) (new)**.
**Gates:** `G-ARCH`, `G-BETA`, `G-CONN`, `G-PROD`. **None passed.**
