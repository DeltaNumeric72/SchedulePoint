# 14 — Security and Privacy Plan

**Posture:** healthcare-adjacent multi-tenant SaaS holding staff PII and operational schedules, deliberately holding **no patient-identifying data**. Normative: doc 14 (threats T-01..T-38), SPEC-01/03/11, ADR-0019/0021/0022. This is the plan view: what is enforced, when each control lands (roadmap milestone), and what remains honestly unclaimed.

---

## 1. The non-negotiables (hard requirements, all CI- or DB-enforced)

| ID | Requirement | Enforcement | Lands |
|---|---|---|---|
| SP-HR-1 / CAP-068 | No email/derived identifier to any third-party host from browser or client telemetry | **Build-breaking CI network-assertion guard** + strict CSP; server-side subprocessors allowed only via the processor register (two distinct tests — CAR-019) | M0 |
| SP-HR-2 / CAP-067 | One action → one operation; idempotency everywhere | Idempotency keys on all mutations; requests-per-interaction CI budget | M0–M1 |
| SP-HR-3..6 / CAP-066 | Focus visible; accessible names; keyboard-operable; programmatic status | axe-core build gate + SPEC-14 manual-evidence matrix | M0 → continuous |
| I-07/I-17 | No patient-identifying information enters the platform | Raw-ingress enclave; positive allowlist + controlled vocabulary; rejection-never-sanitization; quarantine stores no values/hashes; 16-surface canary sweep (SBX-029) | M9/M11 |
| I-15 | No tenant statement outside the unit-of-work | Transaction-local RLS; fail-closed; five DB roles; statement pooling prohibited | M0–M1 |
| I-18 | Published versions immutable | Database triggers (D-15) | M3 |
| I-06 + D-25 | Everything audited; audit append-only | Hash chain + signed checkpoints (A1, M3) → external write-once replication (A2, M12); A3 deliberately not claimed | M1→M12 |

## 2. Threat model coverage (by control family, with landing milestones)

- **Tenancy/authz (T-01..T-08):** SPEC-01 context tuple (M1); SPEC-06 evaluator + truth-table cross-product (M1); tenant-prefixed cache keys (as caching appears); WebSocket origin verification + per-connection non-auto-sent token, re-auth per frame (M10); read replicas excluded from turn-critical/authz reads (M10+).
- **Identity (T-26, T-27, X-12):** per-org OIDC `iss` pinning; account-linking requires proof of control; MFA-reset abuse controls; login-email change invalidates sessions (M1, SSO when first needed).
- **Injection/ingestion (T-14, T-28..T-30):** enclave egress allowlist; SSRF controls on connector/document/report inputs; decompression-bomb limits; report renderer must not execute untrusted HTML or fetch remote resources (TDG-07 gate) (M9–M11).
- **Delivery (T-25, callbacks):** signature-verified, timestamp-bounded, replay-safe by unique `provider_event_id`; uncorrelatable callbacks quarantined (M7).
- **Resource abuse (T-31, T-32):** per-org solver concurrency caps; report/job quotas (M4/M11).
- **Insiders & supply chain (T-33..T-38):** privileged DB/platform roles separated and audited-with-chain; support-tool boundaries; SBOM, image signing, provenance attestation, admission policy; backup keys in a separate trust domain; secret store, no env-file secrets (M0 CI baseline → M12 full).
- **Client baseline:** `HttpOnly`/`Secure`/`SameSite` server-side sessions, bounded idle+absolute lifetimes, CSRF protection, strict CSP, no browser-storage tokens (M1).

## 3. Privacy plan

- **Data classes:** staff contact PII (minimised by role, PO-DEC-20); scheduling data; operational case metadata (vocabulary-constrained, non-identifying by construction); delivery material (envelope-encrypted, delivery-role-only); calendar tokens (hashed, revocable); **patient data: none by construction — C-09 never needs resolving in our favour because no path admits the data**.
- **Processor register (CAR-019):** every server-side subprocessor recorded with legal entity, purpose, data elements, lawful basis, contract, region, retention, deletion, sub-processors, exit plan + declared payload schema and no-extra-field assertion. **Register does not exist yet** — created with the first provider selection (M7); residency inputs OI-3 pending.
- **Retention/erasure:** audit 7y default + tenant override + legal hold; personal-data requests satisfied by anonymisation-not-deletion so the chain survives; the immutable-chain-vs-erasure tension is documented and its jurisdictional determination is **an unmade legal decision, named as such** ([19](19-decisions-needed.md) §3).
- **No PII in URLs, ever** (closes the observed calendar-feed defect). No analytics/session-replay tooling by default.

## 4. What is deliberately not claimed

No HIPAA/PHIPA/SOC 2/ISO 27001/GDPR compliance claim (doc 14 §11's eight prerequisites all *not done*). No exactly-once external delivery. No A3 audit notarisation (RISK-28 stated). No penetration test has occurred. No incident-response plan exists yet. Nothing is implemented; no control above is *effective* until its milestone's evidence exists.

## 5. Security work the roadmap owns explicitly

| Item | Milestone |
|---|---|
| CI guards: network assertion, route-policy presence, migration+RLS pairing, request budget, invariant-ID uniqueness | M0 |
| Isolation harness (SPEC-01 T-07..15) under pool abuse, two orgs | M0–M1 |
| SPEC-11 X-01..X-18 execution (chain, privileged sessions, WebSocket hijack, callback forgery, SSRF, bombs) | with owning milestones M1–M11 |
| Incident-response plan + severity model + evidence preservation → tabletop exercise | plan M11, tabletop M12 (G-PROD) |
| Ten operational runbooks (doc 17 §8) | M11–M12 |
| Penetration test (external) | M12, pre-G-PROD |
| Restore rehearsal incl. audit-integrity verification (SBX-035) | M12 |
| Breach-notification legal determination; DPAs; processor register complete | owner + counsel, by G-BETA/G-PROD ([19](19-decisions-needed.md)) |
