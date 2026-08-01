# 19 — Decisions Needed

**Everything that requires your input, in one place, ordered by when it blocks.** Each item carries my recommendation. Nothing here is treated as approved until you say so; approvals are recorded in [control/PRODUCT-DECISIONS.md](control/PRODUCT-DECISIONS.md).

---

## 1. Blocking the start of implementation (needed now)

| ID | Decision | My recommendation |
|---|---|---|
| **D-A** | **Ratify this plan:** the deliverable set docs/fable/00–20, specifically the roadmap ([16](16-implementation-roadmap.md)), parity framework ([06](06-feature-parity-matrix.md)), and runbook ([17](17-opus-agent-runbook.md)) | Approve; they are additive to the corpus and change no approved decision |
| **D-B** | **Commission the independent re-review** of the remediated architecture (fresh reviewer or Codex re-engagement, per playbook Phase 17 pattern), running in parallel with M0; its verdict gates M1 schema freeze | Commission immediately — it is the critical path |
| **D-C** | **Authorize the CAR-026 correction:** edit report 18's closing prose from "36" to a heading-derived count (39) as a research-maintenance task | Authorize; the validator already reports the mismatch on every run |
| **D-D** | **Approve OPUS-M0-001** ([20](20-recommendation.md) §4) and the M0 spike set | Approve; M0 implements no product feature and is safe under any re-review outcome |

## 2. The 19 pending product decisions (report 24 §3 / doc 19 §2.2)

None blocks M0. My recommendation: **explicitly re-adopt all 19 working defaults as planning assumptions now** (they are individually sensible and each records its blast radius), and **ratify the following four early** because late reversal is costliest:

| ID | Why early | Default I recommend ratifying | Latest safe point |
|---|---|---|---|
| **PO-DEC-09** MFA/SSO posture | Shapes M1 authentication slices | Close the gap: MFA required for elevated roles; per-org OIDC designed now, shipped per customer | Before M1 |
| **PO-DEC-12** Qualification ownership | Patient-safety adjacent; shapes M2 eligibility and M4 solver inputs | Administrator-granted with evidence reference + expiry | Before M2 |
| **PO-DEC-13** Conflict-severity taxonomy | Without it, M4's solver output is unreviewable | Hard breach / unmet demand / eligibility failure / fairness outlier | Before M4 |
| **PO-DEC-23** Solver performance targets | Anchors the M6 benchmark bands (guards against self-set bands — NR-8) | Report 21 §8.3 conservative targets | Before M6 |

The remaining 15 (PO-DEC-01 site, 03 request model, 05 rule authoring service model, 06 multi-org users, 07 push, 10 locum billing, 11 impersonation, 14 vacation default, 15 recipient filtering, 16 locum window, 17 swap review, 19 proxy scope, 20 directory visibility, 21 group email, 22 document retention) proceed on documented defaults with the pending-decision CI guard; each is put to you formally at the entry review of the milestone that implements it (roadmap mapping in [06](06-feature-parity-matrix.md)).

## 3. Owner inputs and procurement (block later gates, not M0)

| Item | What | Needed by |
|---|---|---|
| **OI-1/2** | RPO/RTO targets; availability expectations | M12 DR design; sooner is better |
| **OI-3/4** | Cloud provider, region, **data residency** (Canadian-customer question, RISK-25) | Before first hosted environment (M1 staging); residency before any real-customer data |
| **OI-5..7** | Support model, cost envelope, commercial packaging (PO-DEC-04 commercial half) | Before beta |
| **EV-1** | Vendor connector specifications (Cerner/Surginet, Meditech, per-customer) | Blocks G-CONN only; request now, long lead time |
| **EV-2/3** | Restorable backup access; error-reporting vendor API access | M12 / M11 |
| **EV-4** | Notification provider sandboxes with fault injection | M7 exit |
| **EV-5/6** | Provisioned platform; RPO/RTO confirmation | M11–M12 |
| **EV-7** | Benchmark acceptance-band ratification (with PO-DEC-23) | M6 |
| **EV-8** | Assistive-technology lab (8 AT/browser combos) | First needed M6; hard-required for G-BETA a11y evidence |
| **LEGAL-1** | Breach-notification determination; DPAs with processors; audit-chain-vs-erasure jurisdictional determination | Before G-BETA (DPAs with first providers at M7) |

## 4. Standing authorities I request

1. **Research-source contact remains closed**; any future comparison need comes back to you scoped ([04](04-research-decision.md) §4).
2. **Architecture edits within remediated intent** (e.g., F-05 stale sentence) proceed without per-edit approval, logged in the control register; anything touching an approved decision or the baseline always comes back to you.
3. **Sub-agent delegation within the runbook** proceeds without per-task approval once D-A/D-D are given, with PROJECT-STATUS updated at every acceptance.
