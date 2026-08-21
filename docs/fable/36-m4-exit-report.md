# 36 — Milestone M4 exit report

**M4 authorized 2026-08-07 against frozen M3 checkpoint `7b579f2` (tag `milestone/M3`); complete 2026-08-21. Ten tasks (three M4-000 prerequisite packets, the four solver packets, two corrective packets, the integration packet), all ACCEPTED and merged. This document's commit closes the milestone; the frozen M4 checkpoint is tagged `milestone/M4`. M5 is NOT begun; the prototype-enablement lane is NOT begun; M3R remains PAUSED.** Authoritative packet record: [35-m4-task-packets.md](35-m4-task-packets.md). Entry record: [34-m4-entry-and-prerequisite-register.md](34-m4-entry-and-prerequisite-register.md). Evidence: `docs/evidence/EV-M4-*` (ten bundles).

## 1. Task outcomes

| Task | Scope | Merge | Review verdict path |
|---|---|---|---|
| OPUS-M4-000A | Staffing-input integrity + the shared eligibility verdict | `94af3c5` | ACCEPT WITH CONDITIONS (F-1..F-5) → closed (FAD-28/29/30; migrations 0012+0013) |
| OPUS-M4-000B | Schedule graph, locations, time | `a614f7e` | ACCEPT WITH CONDITIONS (2 blocking: R-B4a degenerate DST intervals; 404→409 stale basis) → delta ACCEPT (FAD-31; migration 0014) |
| OPUS-M4-000C | Rule revisioning/registry, publication handoff, provider gate | `323d576` | ACCEPT WITH CONDITIONS (C-1 digest falsifiability) → delta ACCEPT (FAD-32/33; migration 0015); second-merger composed battery caught 8 cross-packet failures |
| OPUS-M4-001 | Solver runtime boundary + canonical input | `b1aa64e` | **REJECT** (B-1: MAC over a re-derivation, not the wire bytes) → repair → delta ACCEPT (FAD-34; migration 0016) |
| OPUS-M4-001R | FAD-28 contract correction + race-inertness proof | `efa1ffd` | ACCEPT, zero blocking (FAD-35/36; R-1 → NR-17/M4-001S) |
| OPUS-M4-001S | `requires_expiry` flip-vs-grant write-time serialization | `d910af6` | ACCEPT, zero blocking (FAD-37; migration 0017; NR-17 retired) |
| OPUS-M4-002 | Rule semantics + E1 feasibility engine | `5e0ac4e` | REVISE (R-1: adjacent-date-only rest pairing) → delta ACCEPT, zero new findings (FAD-38..43; no migration) |
| OPUS-M4-003 | Build lifecycle + scheduler experience | `8deb4c5` | ACCEPT WITH CONDITIONS → condition round → delta ACCEPT → micro-repair (FAD-44/45; migration 0018; the raw-NUL gate mandated) |
| OPUS-M4-004 | E2 optimization, quality, explanations | `79e78b6` | REVISE (F-01..F-03: comparability refusal rendered affirmative; unmatched demand rate) → delta ACCEPT WITH CONDITIONS (F-14) → micro-repair (FAD-46/47; no migration) |
| OPUS-M4-005 | Integration, concurrency/recovery, hardening, close inputs | `480105b` (squash of `faa3764`, base `64a6ad2`) | **REVISE** (B-1: a CANCELLED deterministic run rendered `reproducible`; +7 conditions) → FAD-50 repair → delta ACCEPT WITH CONDITIONS (D-1..D-4) → FAD-51 final round → **delta-verify ACCEPT** (FAD-48..51; migration 0019) |

Sequencing as authorized: 000A alone → 000B ∥ 000C (serialized merges, composed battery) → 001 → 001R → 001S (both corrective, each alone) → 002 → 003 → 004 → 005, each issued alone after the prior close. Every packet: finalized before issuance, isolated worktree with derived ports, independent second Opus review with reviewer-authored falsification probes, orchestrator re-run of acceptance commands, squash-merge by Fable, complete validation after each merge.

**M4-005's execution spanned three sessions across two interruptions** (sustained Opus API unavailability at 2026-08-18, checkpointed at `f746a45`; one reviewer session-limit termination at delta-review start, resumed with zero loss). The NR-1 continuity design — durable commits at every boundary, detached batteries with inner EXIT markers, state reconstruction from control docs — held every time.

## 2. What M4 proved

- **The 14-step workflow runs end to end through a real browser against the real stack** (EV-M4-005 §17): real Chromium on the production bundle, one origin, the real API, a migrated PostgreSQL cluster with RLS enforced, the real graphile-worker queue runner, and real CP-SAT — no `page.route`, no mocked M4 feature API. Both viewports, axe green, every interaction's request count recorded. After FAD-51 D-3, all fourteen steps carry genuine outcome assertions (step 14 pins the doc 07 §1 staff-view outcome exactly), and the suite fails if selection is refused (D-2/C-2) or if zero tests execute (C-3's must-run reporter).
- **SPEC-01 §2.2's declare/verify contract has both halves** (FAD-48): `GET /me/context` (policy-declared, deny-tested, self-scoped, counter map narrowed to the caller's own membership groups) + the client sender with one re-read-and-retry on `409 CONTEXT_STALE`, I-10 budgets recorded.
- **The concurrency-and-recovery matrix: 40 named proofs, every authorization row, DB-asserted** (EV-M4-005 §3) — simultaneous submission, idempotent retry, duplicate/stale worker results (epoch fencing), worker crash + reaper, API restart, cancellation/timeout during solve, results after cancellation, every input-revision-changed-after-assembly class marked STALE and never silently current, participant inactivation, double selection (D-4d), two builds per period (D-4a), invalid worker output, explanation timeout, progressive pin conflict. The independent reviewer additionally rebuilt six races with its own fixtures and connections; all held.
- **SBX-015/016/017 executed and falsifiable**: 9/9 scenarios, 0 vacuous, 0 probe errors; SBX-016 at 22/22 injected HARD-rule violations detected AND explained in domain terms — plus **eight reviewer-authored injections beyond the shipped set, 8/8 detected and explained, 0 spurious findings** on satisfied twins.
- **D-4b with the queue binding** (migration 0019 — one policy + one SECURITY DEFINER counter, no table): build dispatch is a `build.solve` graphile-worker task; the per-organization cap is enforced at claim time; S-16t proven (a tenant at cap queues; another tenant admits in 5 ms while the first is capacity-locked — reviewer-rebuilt), and a deferred claim spends nothing (no state, no epoch, no events).
- **Deterministic reproducibility is now honest end to end.** The milestone's last two undiagnosed failures (red-cases 61/63, fixture-regression 149/151 at the checkpoint) shared ONE measured root cause: the test-support pinned set carried `maxTimeInSeconds: 10` beside `maxDeterministicTime: 100`, CP-SAT stops at whichever limit arrives first, and the wall clock always won on `B-fairness-shaped` — so the "pinned" runs were reproducible only by luck (`deterministicTimeUnits` moved 21.76→12.53 under load with the clock binding, and pinned at exactly 76.702882 across a 1.7×-slower machine without it). Repaired by making the wall clock a safety net (never a budget), with S-08t now ASSERTING its precondition and pinning statistics equality — strictly stronger than byte equality (EV-M4-005 §20).
- **The product records what a result can honestly claim** (FAD-49/50): `resultReproducibility` is derived on read from persisted parameters + the termination fact + statistics — `reproducible` only for a `completed` termination inside its wall-clock net; `wall-clock-truncated`, `interrupted` (five named reasons), `best-effort`, and `unrecorded` are distinct, never conflated, each with its own rendered sentence. Both surfaces carry the dispatch statement AND the result verdict; a mutation red-case arm proves the derivation load-bearing.
- **The hardening register is discharged with proofs**: NR-15 (the five-packet intermittent) diagnosed to a `drainQueue` handler-less-job deadlock plus a mismatched drain/assertion predicate, repaired at the shared resource, and verified clean across the complete seed set; NR-16's bare-line I-15 scanner landed with its red case; NR-18's evidence-file NUL repaired byte-exactly with the gate's magic-byte hardening (rename bypass closed); NR-19's release-path unlock now has a proof that fails when the repair is deleted (FAD-50 C-1); the red-case runner detects "No test files found" AND spawn failures as ERRORED (FAD-51 D-1), sweeps compiled artifacts, and annotates inverted-polarity arms so transcripts cannot contradict their summaries.
- **The gates hold everywhere**: 17 CI gates, 64 red-case arms both halves proven, 153 fixture-regression runs (13 fixed seeds including the two that exposed S-08t, plus rotating), 371-reading tenant sweep at 0 wrong-tenant rows over all 53 tables, migration cycle 0001–0019 clean by name in both directions twice.

## 3. What M4 did NOT prove

- **Benchmark bands** — nothing measures solver performance against a band; PO-DEC-23 remains resolved-not-banded until the M6 corpus benchmark. Deterministic-mode cost is a one-machine measurement, not a band.
- **Two of the fourteen critical-path steps in a browser** — work profiles/qualifications and the canonical input have no page in M4 (CAP-020's remaining views are M6); they are proven over real HTTP and labelled as the smaller claim (EV-M4-005 §17e).
- **Historical-build reproduction end to end** — no arm re-runs a persisted historical build and compares. S-08t proves bit-identity for two solves in one test; the result-reproducibility verdict is a claim the record can now support, not one exercised against a stored build (EV-M4-005 §19b).
- **The solver image** — `Dockerfile.solver` is authored, never built here; no image digest is pinned; every solve ran under the one local interpreter (CPython 3.9.6 venv); the Python 3.12 rerun is an open CI condition.
- **M3R** — PAUSED by owner direction; not completed, not cancelled, not absorbed; its findings retain their production gates untouched.
- **Assistive-technology sessions** — SPEC-14's 10 M-cells remain honestly unclaimed (EV-8, M6).
- **Anything beyond M4's scope** — requests, vacation, notification delivery, marketplace, picklist, reports, documents, external connectors: not begun.

## 4. Defects discovered and repaired (the milestone's own count)

Every one reviewer- or battery-found, none smoothed: the RPC MAC signing a re-derivation (ASCII-identical, non-ASCII-divergent — M4-001 REJECT); the adjacent-date-only rest pairing (M4-002 R-1); the degenerate DST-gap interval class (399 enumerated → 0, M4-000B); the `requires_expiry` flip race with no read-side backstop (M4-001R R-1 → 0017); a comparability refusal rendered as an affirmative "identical" claim (M4-004 F-01); the NR-15 drain deadlock (a handler-less job making the drain loop unsatisfiable) and its half-repaired seam; the S-08t wall-clock/deterministic-budget race; **a CANCELLED deterministic run rendered `reproducible` with the exact promise sentence the repair round had just deleted** (M4-005 B-1 — the reviewer's cancellation probe against real CP-SAT); an unprovable NR-19 closure (deleting the repair broke nothing shipped — C-1); a marquee e2e suite that could pass with zero tests executed (C-3); critical-path selection steps that printed rather than asserted (C-2); a staleness wire disclosing qualification-holding constituent ids to callers without the grant-only read key (C-4, narrowed to class-level); per-class staleness counts silently inheriting a truncation bound while three places claimed completeness (D-2); four raw-NUL recurrences caught by the gate mandated on the third (the fourth in the mandating round's own new file). Two defects found in ACCEPTED code by M4-005 itself (the queued-claim actor; the `.strict()` envelope erasing 409 codes) were repaired under its own scope.

## 5. Independent review — the M4-005 record

Every M4 packet had a mandatory independent Opus review; M4-005's ran four rounds under one reviewer (probes retained on `review/m4-005` @ `bdd78dc`, never merged): round 1 REVISE (1 blocking, 7 conditions, 12 notes — with a could-not-falsify list covering staleness genericity, S-16t, six self-built races, eight SBX-016 injections, the NR-15 seam both directions, a 220/220-classified deletion ledger, and the evidence-bundle diff); FAD-50 repair; round 2 delta ACCEPT WITH CONDITIONS (B-1 and C-1..C-7 verified closed — the round-1 defect reproductions no longer compile; 3 new conditions); FAD-51 final round; round 3 delta-verify **ACCEPT** (all four D-items verified with the reviewer's own mutations; regression sweep clean). The transcript-23 `raw-nul-magic-bytes` scoring anomaly was independently resolved as a correct inverted-polarity verdict with a self-contradicting inline artifact — the artifact repaired (N-1(i)), the verdict unchanged.

## 6. The acceptance battery (Fable, serial, exit codes checked — EV-M4-005 INDEX §24, transcripts 38–43)

On the final candidate `4f41935`, machine verified calm, each result read before the next launch:

| Command | Result | Exit |
|---|---|---|
| `python3 docs/architecture/validate.py` · `python3 docs/fable/validate.py` | 95/95 · 36/36 | 0 |
| `bash schedulepoint-research/validate.sh` from a genuinely fresh clone | PASS (the `b370e03` placeholder fix proven) | 0 |
| `corepack pnpm check` | 17/17 gates; unit 2153 passed \| 14 skipped; axe green | 0 |
| `corepack pnpm red-cases` | **64/64 proven, 0 not proven** — the milestone's first fully-green complete battery | 0 |
| `corepack pnpm fixture-regression` | **153/153** — all 13 fixed seeds (123456 and 531651 included) + rotating 35396, standalone sweep, baseline control | 0 |
| `corepack pnpm sbx` | 9/9; 371 readings / 53 of 53 tables / 0 wrong-tenant; 0 vacuous | 0 |
| migration populated cycle | 0001–0019 CLEAN by name, up→down→up→down→up | 0 |
| real-stack critical path | 2 passed, both viewports, zero skipped | 0 |
| hygiene | 0 processes, 0 listeners, no dist artifacts, tree clean | — |

Post-merge on main `480105b`: byte identity proven (the diff between merged main and the branch, restricted to every branch-touched path, is empty), validators re-green, research validator PASS from the repository root and from a fresh clone, and the full 17-gate check re-run green (see the close-out commit's record in PROJECT-STATUS).

## 7. Capability movement

M4's authorized scope was CAP-015/016/017/018/059 plus the prerequisite register; doc 06's row identities govern the names. At close (rows dated in [06](06-feature-parity-matrix.md)): **verified — CAP-015 (automated schedule generation), CAP-016 (the rule engine: 22 M4-evaluable kinds in both the model and the independent checker, the 8 later-milestone kinds failing closed with named owners), CAP-017 (progressive builds around pins), and CAP-059 (conflict detection & build quality — its claim scoped band-less until M6, PO-DEC-23)**, all end-to-end proven by EV-M4-005's critical path, matrix, and SBX runs. **CAP-018 (partial-schedule circulation) moved to in-progress**: SBX-017's circulation half proves a partial candidate circulates for review through the existing M3 review path without publishing; the M6 circulation surfaces remain. Parity at exit: **18 verified · 3 in-progress · 37 not-started.** CAP-013's FTE boundaries are additionally enforced solver-side. **No capability was dropped, deferred out of the baseline, or narrowed** — the 58-capability baseline is unchanged; every new authorization surface used action keys under existing capabilities. (An earlier pointer-file label calling CAP-018 "quality/optimization" is corrected in the pointer — doc 06's identities stand; nothing renumbered.)

## 8. Architecture decisions (FADs 28–51) and deviations

FAD-28..30 (staffing rulings, enforcement read plane, scope-crossing ruling + renumbering) · FAD-31 (graph/membership/time rulings incl. R-B4a) · FAD-32/33 (revisioning/registry/handoff; composition rulings incl. the decorative-arm standing rule and by-name migration cycles) · FAD-34 (framed-wire MAC; kill-attribution vocabulary; sweep=registry−1) · FAD-35/36/37 (the FAD-28 reconciliation and the 0017 serialization) · FAD-38..43 (snapshot v2, isOnCall, the C-2 drain investigation with the orchestrator's own mis-attribution corrected on capture, M4-002 adjudication + ratifications) · FAD-44/45 (M4-003 disclosures; the raw-NUL gate mandate) · FAD-46/47 (M4-004 adjudication + E2 ratifications) · FAD-48 (clause (A) built, not waived) · FAD-49 (result-side reproducibility derived, solver/** closed) · FAD-50/51 (the M4-005 review adjudications). No ADR was edited silently; no invariant weakened; every spec change was a dated amendment.

## 9. NR dispositions at close

| Register item | Disposition |
|---|---|
| NR-15 (the five-packet intermittent) | **DIAGNOSED, REPAIRED, VERIFIED** — drain-seam deadlock + predicate mismatch; clean across the complete seed set (153/153); the widened capture that found it is permanent |
| NR-16 (bare-line I-15 scanner gap) | **CLOSED** — scanner landed with red case |
| NR-17 (`requires_expiry` flip race) | **RETIRED** at M4-001S (migration 0017) |
| NR-18 (raw NULs) | Gate live with magic-byte hardening; evidence-file byte repaired; **the two control-document instances repaired in this close-out and the baseline now EMPTY** |
| NR-19 (release-vs-lock orphan) | **CLOSED with a load-bearing proof** (FAD-50 C-1 — the proof fails when the repair is deleted) |
| NR-4 (sub-agent quality variance) | **Stays elevated into M5-era work.** M4's data is the strongest yet: one REJECT, three REVISE, and every blocking finding reviewer-authored — including B-1 in a repair the orchestrator had just adjudicated. Mandatory independent review remains load-bearing |
| NR-1 (context/continuity) | Exercised across two interruptions in M4-005 alone; held with zero loss |

## 10. Limitations and open conditions (CI/environment)

1. **Solver image build + digest pinning + Python 3.12 rerun** — standing CI conditions since M4-001; unchanged.
2. **The 10-second default wall clock** in build configurations races an opted-in deterministic budget by default; the record is now honest about the outcome (`wall-clock-truncated`), but the default itself is an owner question (FAD-49(4)/FAD-50) — deliberately not tuned.
3. **The per-detail-GET staleness computation** runs a full canonical-input assembly; recorded as a known cost, owner M6 build-surface performance.
4. **The un-falsified selection window** — `applyCandidateToNewDraft` reads staleness and writes the draft in one READ COMMITTED transaction without ordering locks; the reviewer could not construct the interleaving and did not assert it reachable; recorded as an admitted, undemonstrated limitation with derived-on-read staleness as compensating visibility (owner M5+).
5. **SBX-017's protected-identity fixture** exercises one identity on one of seven dates — thin, recorded (its exactness claim rests on that fixture plus the matrix's progressive-pin rows).
6. **The matrix numbering skips M-22** — a recorded gap, never renumbered (rule 13).
7. **Battery cost** — the S-08t repair added ~44 min to red-cases and ~44 min to fixture-regression (six B-fairness solves run to proven optimum); the recovery knob (`maxDeterministicTime` 100→~20) is named with its measurement and left to the corpus-budget owner.
8. **Key isolation** (audit signer, MFA box) remains a deployment property this repository does not provide (TDG-15); disclosed at startup.
9. **G-ARCH, G-BETA, G-PROD remain open.** The external architecture re-review still blocks beta entry (V-04).

## 11. What M4 completion is NOT

The `milestone/M4` tag means exactly this: the M4 functional milestone passed its documented evidence. **It is not beta readiness, not production readiness, not connector readiness, and not compliance or compliance-readiness of any kind — no HIPAA, PHIPA, SOC 2, ISO 27001, or GDPR claim is made or implied.** M3R remains PAUSED with its own register and gates. Manual scheduling remains override/recovery/fixed-assignment-input only (I-05); automated scheduling is the production mechanism and is now real, but the roadmap's remaining milestones, the external re-review, and the compliance work all stand between this tag and any deployment claim.

## 12. Control-document audit

| Document | Updated at close |
|---|---|
| PROJECT-STATUS | yes — M4 COMPLETE header block with the close battery |
| OPUS-AGENT-RUNBOOK | yes — the M4-005 row closed (ACCEPTED); NUL repaired |
| ARCHITECTURE-DECISIONS | yes — FAD-49/50/51 recorded during the close |
| RISK-REGISTER | yes — the §9 dispositions |
| FEATURE-PARITY-MATRIX (+ doc 06 rows) | yes — the §7 movement, dated |
| IMPLEMENTATION-ROADMAP | yes — M4 COMPLETE |
| TEST-TRACEABILITY | yes — the M4-005 execution row |
| EVIDENCE-INDEX | yes — EV-M4-005 |
| CHANGELOG | yes — the M4 close entries; NUL repaired |
| ASSUMPTIONS / PRODUCT-DECISIONS / OPEN-QUESTIONS / ORCHESTRATION | no change required (no product decision altered; two owner questions recorded in FADs 49/50) |

## 13. M4 exit verdict

The authorization required the complete M4 outcome — the real workflow against the live stack, the full concurrency/recovery matrix, SBX-015/016/017, the M1–M4 regression, and honest close documentation. **All delivered on evidence: PASSED.** The independent post-M4 Codex review prompt is filed at [37-post-m4-codex-review-prompt.md](37-post-m4-codex-review-prompt.md); creating that prompt is not the review — the review itself is outstanding and owner-initiated.

---

**Stopping here per the authorization. M5 and the prototype-enablement lane begin only on explicit instruction.**
