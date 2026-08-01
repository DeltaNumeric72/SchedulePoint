# ASSUMPTIONS (live)

Canonical baseline: report 23's A-01..A-10 (undischarged until their named tests run). Planning-layer assumptions, updated 2026-08-01:

| ID | Assumption | Risk if wrong | Validated by |
|---|---|---|---|
| FA-1 | Resolved decision defaults hold ([../21-decision-resolution.md](../21-decision-resolution.md)) | Bounded rework per recorded blast radius; all R1/R2 except PO-DEC-03 (R3, documented) | Milestone reviews; beta feedback |
| FA-2 | Internal verification is sufficient to gate M1; executable harnesses carry the real proof burden | Design defect slips to harness stage — caught by T/P/V tests before features | Harnesses at M0–M3 + required external review before beta |
| FA-3 | TDG selections survive their M0 confirmation spikes | Affected row reopens; bounded churn | **Largely discharged 2026-08-01** — TDG-01/02/03(in-process)/11(runtime)/14 confirmed (EV-M0-SPA/SCAFFOLD/SPC); residual: TDG-04 (OPUS-M1-003 micro-spike), external pooler, image build + Py3.12 re-run (CI) |
| FA-4 | LIVE-SIM deterministic harness buildable as specified | M10 evidence quality drops | M9 meta-test |
| FA-5 | Provisional platform (AWS ca-central-1) acceptable when procurement happens | Deployment-config rework only (portable set: OCI+PG+S3) | Owner procurement |
| FA-6 | Fault-injected provider fakes faithfully model SPEC-07 contracts until real sandboxes exist | Contract drift found late — bounded to M7 adapters | First real-sandbox contract runs |
