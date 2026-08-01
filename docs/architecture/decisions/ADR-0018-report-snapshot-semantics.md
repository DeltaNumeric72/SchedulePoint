# ADR-0018 — Report Snapshot and Artifact Authorization

**Status:** `PROPOSED` — 2026-08-01. Not accepted. Raised by CAR-012.

## Context

Report requests captured tenant context but no input snapshot. Only schedule reports naturally referenced a version; request, vacation, fairness, picklist, audit, and directory reports read mutable tables whenever the worker happened to run, so the output matched neither the moment of request nor any reproducible state. The worker never re-authorized the requester, download authorization was not distinguished from creation authorization, and share ACLs and post-creation revocation did not exist.

## Decision

**Every report class declares a snapshot mechanism — an explicit version id, an as-of transaction id, or a materialised input manifest with a hash — resolved at request time and stored durably. Authorization is evaluated three times: at request, at execution, and at every download.** Shares target memberships rather than addresses and are re-evaluated at download, so revocation is immediate. Full design: [SPEC-09](../specs/SPEC-09-report-snapshot-and-artifact-authorization.md).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Read current data at execution** | The status quo. Output corresponds to no defined moment |
| **Hold a long transaction** | A repeatable-read transaction open for the length of a render is an availability problem |
| **Copy all input rows into a staging table** | Correct but expensive; a manifest of row identities and versions achieves the same guarantee |
| **Authorize once, at creation** | The defect: a revoked user keeps everything generated before revocation |
| **Share by emailed link** | Turns an artifact into a bearer capability outside the tenant

## Consequences

**Positive:** a report corresponds to a defined, reproducible state · a lost artifact is regenerable from its manifest, which makes object-store divergence recoverable · revocation takes effect immediately · the policy version used is recorded.

**Negative:** manifests add storage and a per-class design obligation · three authorization points cost latency at download · **an already-issued signed URL cannot be recalled mid-flight; the exposure window is its expiry, and that is stated rather than papered over**.

## Security implications

Artifacts are tenant-prefixed, never public, and reachable only through short-lived signed URLs issued after evaluation. A signed URL is treated as a bearer token: never logged, never in a `Referer`, never in an audit payload. Revocation rotates artifact keys.

## Operational implications

A reconciler resolves orphan objects and dangling rows after any restore. Regeneration from manifests is the recovery path when an artifact is lost.

## Capability mappings

CAP-020, CAP-044, CAP-045, CAP-046, CAP-047, CAP-048.

## Gate mappings

`G-BETA`, `G-PROD` — SBX-031a, SBX-031b, SBX-031c. **None executed.**

## Unresolved validation

- PO-DEC-22 (document retention) is pending.
- The renderer is gated (TDG-07) and must be proven unable to fetch remote resources or execute injected script.
- F-01..F-14 are unexecuted.
