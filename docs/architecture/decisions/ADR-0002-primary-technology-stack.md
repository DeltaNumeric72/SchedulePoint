# ADR-0002 — Primary Technology Stack

**Status:** `PROPOSED` — 2026-07-31. Not accepted.

## Context

The stack must serve four process classes, a data-dense accessible UI, a constraint solver, and a real-time surface — with a small team and no existing code. Three product-level constraints narrow the field more than any framework preference:

1. **Accessibility is a hard requirement** (CAP-066). The research observed four distinct accessibility defects in the source product. A component system that fights accessible defaults is disqualified.
2. **Request efficiency is a hard requirement** (CAP-067). The source fired ~25–40 identical requests from a single click.
3. **No third-party identifier may leak** (CAP-068). This constrains what the client is permitted to load at all.

## Decision

**Node.js LTS + TypeScript across all four process classes; PostgreSQL as the single database; OR-Tools CP-SAT behind a solver-neutral port; WebSocket for server-authoritative real-time; S3-compatible object storage; OpenTelemetry for observability; Playwright + axe-core in CI.** Full per-choice detail, including alternatives and replacement boundaries, is in [02](../02-technology-stack.md).

**Only four claims in the stack document are verified primary-source facts** ([references](../references/official-technical-sources.md)): CP-SAT's solver class and status values, its optimization support, OR-Tools' Apache-2.0 licence, and PostgreSQL's RLS semantics. **Every other maturity or licensing claim is marked `VERIFY` and must be confirmed before adoption.**

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| **.NET** | Strong fit, and the source product appears to be built on it. **Deliberately not chosen partly for that reason** — clean-room separation is easier to demonstrate when the platforms differ. Also adds a second language alongside the browser |
| **Python** | Best solver integration by far, but weaker for the real-time and web tiers. **Kept viable**: the solver runs behind a port, so a Python solver service remains an option without changing the domain |
| **Go** | Excellent for workers and real-time; weaker UI ecosystem; would add a second language |
| **JVM** | Capable across all four profiles; heavier operational footprint for a small team |

## Consequences

**Positive:** one language across server, workers, and browser · a structural type system that expresses domain invariants directly · shared typed contracts between client and server.

**Negative:** Node.js is a poor host for CPU-bound solving — **which is why scheduling workers are a separate process class and the solver sits behind a port** · a large dependency surface requires disciplined scanning · most stack rows still carry `VERIFY`.

## Security implications

Dependency scanning in CI, failing on known-exploitable vulnerabilities. **A CI guard fails the build on any new outbound third-party host** — the direct control for CAP-068. Strict CSP blocking inline script.

## Operational implications

One runtime to patch and monitor. Container images per process class from one build. Licence review before first release and on every new dependency.

## Capability mappings

CAP-066 (accessibility), CAP-067 (request efficiency), CAP-068 (third-party privacy) most directly; all 58 indirectly.

## Gate mappings

`G-BETA` — CAP-067. `G-PROD` — CAP-066, CAP-068.

## Unresolved validation

- Most stack rows are marked `VERIFY`; **no licence or maturity review has been performed**.
- No performance measurement supports any choice here.
- The accessibility properties of any specific component library are unassessed.
