# ADR-0020 — Solver Runtime and Packaging

**Status:** `PROPOSED` — 2026-08-01. Not accepted. Raised by CAR-005. **Resolves a direct contradiction between ADR-0002 and ADR-0006.**

## Context

ADR-0002 selected "Node.js/TypeScript across all four process classes" and one build artifact. ADR-0006 simultaneously stated that CP-SAT runs outside Node.js and needs a process boundary. Both could not be true.

**Verified fact S-04:** OR-Tools is officially installable for **C++, Python, Java, and C# (.NET)**. The official documentation states: "Google created OR-Tools in C++, but you can also use it with Python, Java, or C# (on the .NET platform)." **Node.js and JavaScript are not supported.**

A logical `SolverPort` does not supply a language runtime, a serialisation format, a native library, a cancellation channel, an image, a patch stream, or a security boundary. Implementation would have reached the solver worker and improvised one.

## Decision

**A separately packaged Python solver worker running OR-Tools CP-SAT, in its own image and its own process class, reached over a versioned authenticated RPC protocol.**

- **The "one language, one image" claim in ADR-0002 is withdrawn.** The platform is TypeScript in four process classes **plus Python in the solver worker plus a minimal ingress enclave image** ([ADR-0021](ADR-0021-raw-ingress-enclave.md)).
- **One solve per subprocess**, so cancellation can be enforced by termination when the solver's own deadline and callback do not return.
- The worker holds **no database credential**. It receives a problem and returns a result.
- The domain remains solver-neutral: **no domain module imports the solver or knows it is Python**, enforced in CI.

Full design: [SPEC-04](../specs/SPEC-04-solver-runtime-and-rule-model.md) §§1–2.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Java or C# worker** | Also officially supported and equally viable. Heavier images; no advantage for this problem |
| **C++ worker** | Best control and lowest overhead; slowest to build, hardest to staff |
| **Node.js native binding** | **No official binding exists (S-04).** A community FFI layer under the product's central algorithm is an unacceptable dependency |
| **Different solver with a Node binding** | None reviewed matches CP-SAT's expressiveness for this problem class under a permissive licence. **Revisit only if benchmarking rejects CP-SAT** |
| **Keep the contradiction unresolved** | The defect |

## Consequences

**Positive:** the runtime is officially supported · cancellation is enforceable by process termination · the solver is genuinely replaceable behind the port · solver saturation cannot starve the web tier.

**Negative:** **a second language, with its own dependency chain, SBOM, patch stream, and security review** · serialisation cost on every solve · protocol versioning becomes a real compatibility obligation · **local development now requires two runtimes**, which raises the cost of onboarding and must be reflected in tooling.

## Security implications

The worker holds no database credential and cannot reach tenant tables even if compromised. Mutual authentication on the internal channel. Per-solve CPU, memory, and wall-clock limits plus a per-organization concurrency cap mitigate T-31 (solver resource exhaustion). **The model is never logged in full.** The Python image carries its own SBOM, scan, signature, and provenance attestation (T-35).

## Operational implications

A dedicated CPU-optimised node pool ([SPEC-10](../specs/SPEC-10-deployment-topology.md) §7). Solver images are **retained by digest** for the reproducibility window, which is a named registry-retention cost. A retained image is never used to serve production builds — only to reproduce a historical result in isolation. A runbook for stuck or timing-out solves is required and does not exist.

## Capability mappings

CAP-015, CAP-016, CAP-017, CAP-059, CAP-067.

## Gate mappings

`G-ARCH`, `G-PROD` — SBX-015, SBX-031. **Neither executed.**

## Unresolved validation

- **No benchmark has been run.** Every performance statement remains an expectation.
- SP-5 (serialise, solve, cancel, time out, kill, restart, reproduce) is unexecuted.
- **Whether CP-SAT exposes the assumption mechanism the T1 explanation tier needs is unverified** — S-01 did not document it.
- PO-DEC-13 and PO-DEC-23 remain pending.
