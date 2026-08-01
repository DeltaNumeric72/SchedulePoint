# SPEC-09 — Report Snapshots, Artifact Authorization, and Feed Contracts

**Status: `PROPOSED`.** Remediates **CAR-012** (High).
**Supersedes:** [13](../13-reports-calendars-and-documents.md) §§1–4; [05](../05-tenancy-entitlements-authorization.md) §4.6 report/export rows.
**New invariant:** **I-21**. **ADRs:** [ADR-0014](../decisions/ADR-0014-file-and-report-storage.md) (revised), [ADR-0018](../decisions/ADR-0018-report-snapshot-semantics.md) (new).

> **What was wrong.** A report request captured tenant context but **no input snapshot**. Only schedule reports naturally referenced a version; request, vacation, fairness, picklist, and audit reports read mutable tables whenever the worker happened to run. The worker never re-authorized the requester. Download authorization was not distinguished from creation authorization. Share ACLs and post-creation revocation did not exist.

---

## 1. The invariant

**I-21 — Every report binds an immutable input snapshot resolved at request time, is re-authorized against current state at execution, and is re-authorized again at every download.**

Three separate authorization moments, because they answer three different questions: *may you ask for this?*, *may you still have it when it runs?*, *may you still have it now?*

---

## 2. Snapshot semantics per report class

**Every report class declares its snapshot mechanism. There is no default and no "reads whatever is current."**

| Class | Mechanism | Recorded |
|---|---|---|
| **Schedule** (CAP-020, CAP-046) | **Explicit `version_id`** resolved at request | `version_id`, `input_hash` |
| **Daily assignment sheet** | Explicit `version_id` (`is_current` resolved at request, then frozen) | `version_id` |
| **Fairness statistics** (CAP-045) | **Input manifest**: version ids in scope + `credits` as-of transaction id | Manifest + `input_hash` |
| **Requests / vacation** | **Materialised input manifest**: the exact row ids and their `version` columns at request time | Manifest + `input_hash` |
| **Picklist** | `picklist_id` + `event_sequence` high-water mark | Sequence + `input_hash` |
| **Audit** | `occurred_at` upper bound + `audit_sequence` high-water mark | Bound + `input_hash` |
| **Directory / contacts** | **As-of transaction id**; per-recipient minimisation applied at **execution** under the requester's *then-current* policy | As-of + policy version |
| **Integration / import** | `batch_id` list | Manifest |

| Property | Rule |
|---|---|
| **Manifest is durable** | Stored on `report_runs`. **The report is reproducible from it, or it is not a snapshot** |
| **`input_hash`** | Over the manifest, so an artifact can be proven to correspond to its declared inputs |
| **Snapshot ≠ long transaction** | Manifests reference immutable versions or record row identities and versions. **No report holds a database transaction open while it renders** |
| **Row changed since the manifest** | Report renders **as of the manifest**; a `data_changed_since_request` flag is set on the artifact so the reader knows a newer state exists |
| **Row deleted** | Impossible on the report paths — deletion is prohibited where history exists. An archived row still renders as of the manifest |

**`policy_version` is recorded alongside the data manifest**, so "which authorization rules produced this content" is answerable — the review's requirement to record the policy version used.

---

## 3. Authorization at execution

At execution the worker evaluates the **full truth table** ([SPEC-06](SPEC-06-authorization-truth-table.md) §5) against current state.

| Outcome | Behaviour |
|---|---|
| Allowed | Render; `state = completed` |
| **Denied** | **`state = cancelled_unauthorized`**, reason recorded, requester notified, **no artifact written** |
| Entitlement lost | `cancelled_unentitled` |
| Membership ended | `cancelled_unauthorized` |

**The review's scenario — a scheduler requests a vacation report, loses access, and the job runs hours later against newer approvals — now fails on both counts: the manifest freezes the data, and the re-authorization cancels the run.**

---

## 4. Download, sharing, and revocation

### 4.1 Download

**Every download re-evaluates authorization against current state.** Not the creation decision, not a cached one.

| Control | Rule |
|---|---|
| Requester download | Truth table + artifact ownership or an active share |
| **Signed URL** | Issued **only after** evaluation; **short expiry**; single-use where the storage layer supports it; bound to the artifact key |
| **Signed-URL leakage** | Bounded by expiry. **A signed URL is a bearer token and is treated as one**: never logged, never in a `Referer`, never in an audit payload |
| **Revocation before expiry** | Artifact keys are rotated on revocation, invalidating outstanding URLs. **Stated honestly: an already-issued URL cannot be recalled mid-flight; the window is the expiry** |
| Download audited | Actor, artifact, timestamp, correlation id |

### 4.2 Sharing

`report_shares` *(NEW)*: `artifact_id`, `shared_with_membership_id`, `shared_by`, `granted_at`, `expires_at?`, `revoked_at?`; `UNIQUE (artifact_id, shared_with_membership_id)`.

| Rule | Detail |
|---|---|
| **Recipients are memberships, never addresses** | A share targets a person in the tenant, not an email |
| **A share is not a bypass** | The recipient must **also** pass the truth table for the report's module and capability |
| **Revocation is immediate** | Next download denied; keys rotated |
| **Membership ends → shares lapse** | Evaluated at download, so no sweep is required for correctness |
| **Re-sharing** | Requires its own capability; disabled by default |

**The review's scenario — a previously shared URL remains usable after the recipient loses group membership — fails at L3.2 on the next download.**

---

## 5. Calendar feeds

| Control | Rule |
|---|---|
| **Token entropy** | ≥256 bits from a CSPRNG; **hash-stored**; plaintext shown once |
| **Scope** | One membership, read-only, one feed. Never org-wide |
| **Rotation / revocation** | Self-service and administrative; owner notified on issue, rotation, and revocation |
| **Every fetch is authorized** | Token → membership → **full truth table**. A suspended membership or revoked entitlement stops the feed immediately |
| **No PII in the URL** | Opaque token only |
| **Caching** | `Cache-Control: private, no-store`; `Referrer-Policy: no-referrer`. **The token must not reach an intermediary cache or a downstream `Referer`** |
| **Access logging** | Fetches logged with the **token id**, never the token; IP and user-agent retained per policy |
| **Content** | Resolves `is_current`; the response records the rendered `version_id` and carries `X-SchedulePoint-Version` |
| **Stale feed during failover** | A read replica may serve a slightly older version. **The rendered `version_id` is always stated**, so a consumer can detect staleness rather than silently trusting it |
| **Rate limiting** | Per token; abuse alerts |

---

## 6. Documents

| Control | Rule |
|---|---|
| **Scan before availability** | `uploading → scanning → available`. **A scan failure blocks availability — it never fails open** |
| **Quarantine** | Infected uploads quarantined, uploader notified, administrator alerted |
| **Versioning** | Prior versions retained; supersession never deletes |
| **Category permissions** | Evaluated at **list, read, and download**, each time |
| **Retention** | **PO-DEC-22 pending**; default indefinite; purge invalidates URLs and rotates keys |
| **Upload isolation** | Decompression bounded; archive bombs rejected; content type verified from bytes, not from the client claim ([SPEC-11](SPEC-11-audit-assurance-and-security-boundaries.md) §5) |

---

## 7. Storage and backup consistency

| Concern | Design |
|---|---|
| **Database ↔ object store divergence** | The database is authoritative. A reconciler finds artifacts with no row (orphans → deleted after a grace period) and rows with no artifact (marked `artifact_missing`, regenerable from the manifest) |
| **Regeneration** | Because the manifest is durable, **a lost artifact is regenerable**, which is why divergence is recoverable rather than fatal |
| **Point-in-time restore** | Object storage is versioned; a database restore to time *T* pairs with object versions as of *T*; the reconciler runs after restore. **Verified by SBX-035** |
| **Tenant prefixes** | `org/{id}/group/{id}/…`; no public objects; encryption at rest |

---

## 8. Test contract

**Extends SBX-031a, SBX-031b, SBX-031c.**

| # | Test | Required outcome |
|---|---|---|
| F-01 | Queue each report class; mutate source data before execution | Output matches the **manifest**, not current data; `data_changed_since_request` set |
| F-02 | Revoke requester access before execution | `cancelled_unauthorized`; **no artifact** |
| F-03 | Revoke access between completion and download | **Download denied** |
| F-04 | Share, then recipient loses membership | **Download denied** |
| F-05 | Revoke a share | Immediate denial; keys rotated |
| F-06 | Replay an expired signed URL | Denied |
| F-07 | Cross-tenant artifact key guess | Denied; security event |
| F-08 | Calendar token: rotate, revoke, reuse old | Old denied; owner notified |
| F-09 | Calendar fetch with a suspended membership | Denied |
| F-10 | Calendar response headers | `no-store`, `no-referrer` present |
| F-11 | Infected document upload | Quarantined; **never available** |
| F-12 | Archive bomb | Rejected within bounds |
| F-13 | Delete an artifact from the object store | Row marked `artifact_missing`; **regenerated from the manifest** |
| F-14 | PITR restore, then reconcile | Consistent; no orphan, no dangling row |

---

## 9. Traceability

**Capabilities:** CAP-020, CAP-044, CAP-045, CAP-046, CAP-047, CAP-048.
**Decisions:** PO-DEC-22 (pending).
**ADRs:** [ADR-0014](../decisions/ADR-0014-file-and-report-storage.md) (revised), **[ADR-0018](../decisions/ADR-0018-report-snapshot-semantics.md) (new)**.
**Gates:** `G-BETA`, `G-PROD`. **None passed.**
