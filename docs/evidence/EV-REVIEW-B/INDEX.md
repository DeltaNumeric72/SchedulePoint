# EV-REVIEW-B — REV-B: implementation and evidence review (post-M4 internal review, doc 38 §3)

**Reviewer:** REV-B — a fresh high-effort Opus agent, launched from packet text alone.
**Packet:** [docs/fable/38-post-m4-internal-review-plan.md](../../fable/38-post-m4-internal-review-plan.md) §§1–5.
**Independence:** BLIND to REV-A. At no point before filing did this reviewer fetch,
check out, read, grep, or otherwise consult branch `review/rev-a`, the directory
`docs/evidence/EV-REVIEW-A`, or any description of REV-A's findings. One consequence is
recorded honestly in §D: an untracked `.evidence-scratch/` directory and untracked
`scripts/gates/request-budget/recordings/` produced by an earlier process in this
container were **deliberately not read**, because they could carry another reviewer's
output.

**Review branch:** `review/rev-b` (never merged). **Evidence:** this directory only.
**Rule:** this reviewer implements nothing. Code-modifying probes are applied, measured
and restored byte-identically, with the applied diff recorded here.

**Machine:** 4 vCPU, 15 GiB, Linux 6.18.44. Measured slower than the M4 reference
machine (see §C figures). `SP_SOLVER_WORKER_COMMAND=/home/user/SchedulePoint/solver/.venv/bin/python`
(CPython 3.9.6 venv, OR-Tools 9.15.6755).

**Baseline (doc 38 §1):** M1–M4 claims judged at `milestone/M4` =
`cc9f3f92583565e540a4a3b682303675ba8b6a70`; the delta to `origin/main` =
`93a71f52a16c60d99fecd6c862ba952b170cfb3a` judged for non-alteration of frozen claims
plus its own correctness. Execution in this bundle is on `review/rev-b` @ `f855340`,
whose tree differs from `origin/main` only by doc 38 and the AUTO-RUN-STATE sync
(verified: `git diff --stat origin/main..review/rev-b` = 3 files, all under `docs/`).

---

## A. Stage log (what was executed, in order, with its transcript)

| # | Transcript | What ran | Result |
| --- | --- | --- | --- |
| t01 | `transcripts/t01-pnpm-check.txt` | `corepack pnpm check` on `review/rev-b` @ f855340 | see §C |
| t02 | `transcripts/t02-validators-green.txt` | the three doc validators | architecture **95/95** · fable **36/36** · research **PASS** — all exit 0 |
| t03 | `transcripts/t03-vitest-zero-match.txt` | the GH-008 vitest zero-match hazard | **reproduced: exit 0 with 31 skipped / 0 executed** |
| t04 | `transcripts/t04-vitest-nofiles-and-errored-signatures.txt` | vitest against a non-existent path | exit 1, `No test files found` — the ERRORED signature has a real string to match |
| t05 | `transcripts/t05-privacy-static-sweep.txt` | I-07/I-17 static sweep: every `request.log.*` call site, `console.*` in every `src/`, audit payload handling | 0 `console.*` in production source; the pg-error path logs only `correlationId` + `sqlstate` |
| t06 | `transcripts/t06-ci-on-main.txt` | GitHub Actions run ledger + the `main` gate-battery job log | **CI on `main` @ 93a71f5 is RED** |
| t07 | `transcripts/t07-bundle-third-party-scan.txt` | REV-B's own third-party-host scan of the built bundle | **0 request-capable third-party hosts**; 4 vendor string hosts, all inert |
| t08 | `transcripts/t08-e2e-inventory.txt` | e2e spec and 320-pixel inventory | 11 specs, 188 `test(` declarations, 10 explicit 320px assertions |
| t09 | `transcripts/t09-route-policy.txt` | route/policy inventory and SBX-001 matrix coverage | 113 routes, all policy-declared; 112 covered by the role×route matrix |
| t10 | `transcripts/t10-error-body-echo.txt` | do 4xx validation messages echo caller-supplied text? | one shape does: `Unrecognized key(s) in object: '<caller string>'` |
| t11 | `transcripts/t11-interface-states.txt` | interface-state (loading/empty/error/denied) inventory | centralized in `SurfaceState`; 4 states, 6–16 e2e references each |
| t12 | `transcripts/t12-real-stack-critical-path.txt` | **the real-stack 14-step critical path, both viewports** | **2 passed (56.6s), exit 0** — every recorded request count identical to the M4 record |
| t13 | `transcripts/t13-outbox-drain-repeat.txt` | the drain failure, re-run standalone and per-directory | passes alone (12/12, 1.0s) and with the whole `test/audit` directory (83/83) |
| t14 | `transcripts/t14-api-suite-raised-timeout.txt` | the full `api` project with `--testTimeout=600000` | **138 files passed \| 1 skipped; 1444 tests passed \| 14 skipped; exit 0; 24.8 min** |
| t15 | `transcripts/t15-mutation-sample.txt` | assertion-mutation sampling, 10 assertions, 7 files, 5 vitest projects | **10/10 load-bearing, 0 vacuous**, every file restored byte-identically |
| t16 | `transcripts/t16-red-case-arms.txt` | 13 red-case arms through the runner's own shard filter | **13/13 PROVEN in both directions**, tree clean after each |
| t17 | `transcripts/t17-validator-falsifiability.txt` | can the doc validators fail? | **3/3 arms fail on demand and restore**; plus the §B REV-B-005 side finding |
| t18 | `transcripts/t18-i13-repeat.txt` | REV-B-001 reproduction, 34 runs in four passes | **1 failure in 34** |
| t19 | `transcripts/t19-e2-objective-cost.txt` | the true cost of the two arms that hit the 120 s ceiling | **130177 ms and 129429 ms** |
| t20 | `transcripts/t20-privacy-log-probe.txt` | I-17 marker driven through six wire positions, hunted in the server's own log | **0 log lines carry it**; needle control found; 2 response bodies echo it |
| t21 | `transcripts/t21-sbx.txt` | `corepack pnpm sbx` | **9/9, 371 readings, 53 of 53 tables, 0 wrong-tenant, 0 vacuous, 9/9 FALSIFIABLE, exit 0** |


## B. Findings register (doc 38 §5 format)

Severities are REV-B's and are stated once, plainly. Every one has an executed
reproduction; none is inferred from reading.

---

### REV-B-001 — BLOCKING

**Claim attacked.** doc 36 §6 / EV-M4-005 §24 row 1: "`corepack pnpm check` — 17/17
gates — exit 0", carried forward by the delta's merge commit ("All checks green on
`332603e` … first fully-green CI in the repository's history") and by doc 38 §9
criterion 8 ("GitHub CI passes on `main`").

**What is true instead.** On the review baseline `origin/main` = `93a71f5`, GitHub
Actions run **32612471848** — the push run on `main` — concluded **`failure`**. Its
`gate battery` job failed at `pnpm check` with **17 gates: 15 passed, 2 failed**:

- `axe` FAIL — `[mobile] › e2e/schedule.spec.ts:428:3 › periods — states › I-13: "New
  period" persists nothing and issues ZERO requests`, which recorded one request where
  the invariant demands zero:
  `GET …/groups/2222…/schedule/periods`
- `request-budget` FAIL — `schedule-open-new-period.mobile` "issued 1 request(s),
  budget 0".

**It is an intermittent, and REV-B measured its rate inside that one run.** The axe
gate ran at least four times on that exact tree in run 32612471848 — once in the gate
battery (failed), once as the green half of red-case arm `axe` (shard 7, passed), and
twice inside arm `i13-schedule-authoring` (shard 8: green half and restore, both
passed). One failure in ≥4 clean-tree runs of the same commit.

REV-B's own local `corepack pnpm check` on `review/rev-b` @ `f855340` (same tree plus
docs) had **axe PASS (430 passed, 16 skipped, 11.6 min) and request-budget PASS** — so
the failure did not reproduce in one local run either. It is a real, load-sensitive
flake in a gate the exit report reports as a hard 17/17.

**Mechanism REV-B could establish.** `recordRequests`
(`apps/web/e2e/support/request-budget.ts`) opens its listener and closes it around the
action. In `schedule.spec.ts:428` the window opens after
`await expect(page.getByTestId('periods-new')).toBeVisible()`. `periods-new` is
rendered by `NewPeriodForm`, which sits ABOVE the `SurfaceState` in
`apps/web/src/schedule/PeriodsPage.tsx` and does not depend on the
`['schedule-periods', …]` query. The button is therefore visible before that query's
own fetch is necessarily on the wire, so the page's OWN initial load request can land
inside the recording window. That is the open side of the class GH-009 registered on
the close side ("the shared recorder's DOM-signal close is the class-level hole this
instance's fix does not remove"). The mechanism is stated as the one the evidence
supports; REV-B did not prove it by construction (that would mean instrumenting the
recorder, which is a repair, not a review).

**REPRODUCED LOCALLY.** REV-B re-ran the failing test in isolation at the mobile
project 30 times and the whole `schedule.spec.ts` at the mobile project 4 times:

| pass | form | runs | failures |
| --- | --- | --- | --- |
| 1 | isolated, `--grep "New period"`, machine otherwise busy | 8 | **1** |
| 2 | same, full output retained on failure | 12 | 0 |
| 3 | same, under a deliberate 4-core load (1-min load average 5.24) | 10 | 0 |
| 4 | the whole `schedule.spec.ts` at `--project=mobile` (the CI shape) | 4 | 0 |

**1 failure in 34 local runs.** It is genuinely intermittent and it is not simply
"slower machine loses": the deliberate-load pass did not raise the rate at all. The
verbatim failure text was not captured on the one local failure (the capture filter
missed it) — the verbatim reproduction in this finding is CI's, quoted above from the
job log.

**What it is NOT.** It is not a product amplification. Against the REAL stack, the same
interaction records **0 requests at both viewports**, in REV-B's own run
(`transcripts/t12`) and in the retained M4 record (transcript 43). A false FAILURE, not
a blind gate.

**Why BLOCKING.** doc 38 §9 makes "GitHub CI passes on `main`" an exit criterion, and
§7 makes `pnpm check` 17/17 part of the required final battery. Neither holds at the
baseline. The gate that is failing is the I-10/I-13 request-budget gate — the one
CLAUDE.md rule 10 forbids weakening — so the correct disposition is to repair the
recorder window, never to raise the budget or relax the assertion.

**Affected.** I-10, I-13, SP-HR-2, CAP-066/CAP-068 harness · doc 36 §6 rows 1 · doc 38
§7 and §9.8 · registered follow-up GH-009.

**Evidence.** `transcripts/t06-ci-on-main.txt` (run ledger, the full gate table from the
job log, the shard corroboration) · `transcripts/t01-pnpm-check.txt` (the local
non-reproduction) · `transcripts/t12-real-stack-critical-path.txt` (0 requests, real
stack, both viewports).

---

### REV-B-002 — MAJOR

**Claim attacked.** doc 36 §9 / TEST-TRACEABILITY: "NR-15 (the five-packet
intermittent) — **DIAGNOSED, REPAIRED, VERIFIED** — drain-seam deadlock + predicate
mismatch; clean across the complete seed set (153/153)".

**What is true instead.** In REV-B's `corepack pnpm check` on the baseline tree, the
unit gate reported **2 failed test files** — and one of them is the drain seam, with the
NR-15 message verbatim:

```
 FAIL   api  test/audit/outbox-dispatch.test.ts [ apps/api/test/audit/outbox-dispatch.test.ts ]
Error: outbox-dispatch-finalize: the queue still holds 336 drainable job(s) after 45000 ms
       — the precondition could not be established
 ❯ drainQueue test/support/queue.ts:145:15
 ❯ test/audit/outbox-dispatch.test.ts:123:21
```

The twelve tests in that file all passed; the `afterAll` drain is what failed, which is
exactly the "fails in a message about a queue rather than about builds" shape the
support module's own docblock describes.

**Reproduction attempts, reported honestly.**

| Run | Result |
| --- | --- |
| `vitest run` (the whole workspace, the `check` gate) | **FAILED** — 336 drainable jobs after 45 s |
| `vitest run --project api apps/api/test/audit/outbox-dispatch.test.ts` | passed, 12/12, 1.0 s |
| `vitest run --project api apps/api/test/audit` (the whole directory) | passed, 9 files / 83 tests, 21.0 s |
| `vitest run --project api --testTimeout=600000` (the whole `api` project, 139 files / 1458 tests, 24.8 min) | **passed** — 138 passed \| 1 skipped, exit 0; the drain did **not** recur |

So it is composed-run, order- and timing-dependent, and **intermittent even between two
composed runs**: one occurrence in two full composed runs on the same tree. REV-B could
not, in the time available, isolate which earlier file leaves the backlog. Note the two
composed runs differ in extent — the failing one was the whole workspace (171 files /
2182 tests, all five vitest projects), the passing one the `api` project alone (139
files / 1458 tests) — so "different file set" is not excluded as the discriminator.

**The seam is visible in the source.** `drainableJobCount`
(`apps/api/test/support/queue.ts:72`) counts `outbox.%` and `audit.%`.
`drainQueue` starts an outbox runner that registers the `audit.*` periodic tasks **only
when a `signer` is supplied** — the module's own R-10 docblock says so and says why:
"a signer-less drainer has no handler for an `audit.checkpoint` job and therefore cannot
empty a queue holding one". The failing call site,
`apps/api/test/audit/outbox-dispatch.test.ts:122`, passes **no signer**. A backlog that
contains a single unhandleable `audit.*` job makes that loop unsatisfiable for its whole
45 s, whatever the machine speed.

**Why MAJOR rather than BLOCKING.** It fails a precondition hook, not a product
assertion; no product claim is falsified by it. But "VERIFIED / clean across the
complete seed set" is a claim about this exact failure, and it did not hold on the first
full run REV-B executed on the baseline.

**Affected.** NR-15 (RISK-REGISTER) · doc 36 §9 · FAD-15 Layer 3 · the `check` gate's
unit row.

**Evidence.** `transcripts/t01-pnpm-check.txt` (lines 6660–6676) ·
`transcripts/t13-outbox-drain-repeat.txt` · `transcripts/t14-api-suite-raised-timeout.txt`.

---

### REV-B-003 — MAJOR

**Claim attacked.** doc 36 §6 row 1 (`pnpm check` 17/17, unit "2153 passed | 14
skipped", exit 0) as a property of the code rather than of one machine; and the delta's
GH-005 record, which repaired the machine-speed class on exactly two arms.

**What is true instead.** On this machine (measured 2.7–3.9× slower than the M4
reference), the unit gate fails with two tests timing out at the **global 120 000 ms
ceiling**:

```
 FAIL   api  test/solver/e2-objective.test.ts > the objective is TIERED and every component
        weight is recorded > records rank, multiplier, scale and each rule's scaled weight
Error: Test timed out in 120000ms.      (e2-objective.test.ts:159)

 FAIL   api  test/solver/e2-objective.test.ts > status honesty and the metric set, end to end
        > measures SPEC-04 §7 and leaves the unmeasurable rates NULL
Error: Test timed out in 120000ms.      (e2-objective.test.ts:754)
```

Both pose `B-fairness-shaped` under the pinned set — the same class GH-005 measured at
150–177 s on a container and gave explicit 480 s / 540 s ceilings. **GH-005 raised the
ceiling on the two TWO-solve arms only.** These two are SINGLE-solve arms in the same
file with the same fixture, and they were left at the 120 s default. The repair was not
generalised to its own class, so `pnpm check` is not green on a correct-but-slower
machine — while `red-cases` and the real-stack e2e both are.

**Measured cost, on a calm machine, with `--testTimeout=600000`:**

```
✓ the objective is TIERED … > records rank, multiplier, scale and each rule's scaled weight   130177ms
✓ status honesty and the metric set, end to end > measures SPEC-04 §7 …                        129429ms
```

**130.2 s and 129.4 s against a 120.0 s ceiling — over by 8.5 % and 7.9 %.** This is a
knife edge, not a gulf: the same two arms pass on the GitHub runner (the CI unit gate
completed in 906 s on the baseline) and fail here. With the ceiling raised, the whole
`api` project passes — **138 files passed | 1 skipped, 1444 tests passed | 14 skipped,
exit 0, 1489.8 s** — which is what makes this a ceiling problem and not a defect in the
code under test.

**Affected.** doc 36 §6 row 1 · doc 38 §7 · GH-005's record · the standing CI condition
in doc 36 §10.1 (a Python-3.12 rerun on other hardware runs straight into this).

**Evidence.** `transcripts/t01-pnpm-check.txt` (lines 6681–6704) ·
`transcripts/t14-api-suite-raised-timeout.txt`.

---

### REV-B-004 — MINOR

**Claim attacked.** doc 36 §2's reproducibility paragraph: "`deterministicTimeUnits`
moved 21.76→12.53 under load with the clock binding, and **pinned at exactly 76.702882
across a 1.7×-slower machine** without it."

**What is true instead.** FAD-52 (ARCHITECTURE-DECISIONS, 2026-08-22) records that the
same snapshot under the same pin measures **83.130356** units on a different machine,
and that "deterministic units are same-machine-stable, NOT cross-machine-portable"; the
delta corrected the support docblock in `apps/api/test/support/solver.ts` accordingly
(`git diff cc9f3f9 93a71f5 -- apps/api/test/support/solver.ts`). doc 36 was deliberately
not retro-edited — a defensible convention — but **doc 36 contains no pointer to FAD-52
at all** (`grep -c "FAD-52" docs/fable/36-m4-exit-report.md` → `0`), and doc 36 is the
document doc 38 §2.5 puts in the requirements surface. A reader of the exit report alone
takes a machine-specific number for a portable constant.

The same paragraph-level staleness affects doc 36 §6 row 2 ("red-cases **64/64**") and
§7's parity statement: the live battery is **65** arms (`scripts/red-cases/run.mjs`
declares 65; CI's completeness guard on the baseline reports "Every one of the 65
red-case arms was run by exactly one of the 13 shards"). `docs/dev-setup.md` WAS
corrected 64→65 in the delta; doc 36 was not, and carries no supersession note.

**Affected.** doc 36 §§2, 6, 7 · FAD-49/50/52 · the frozen-record convention itself.

**Evidence.** `transcripts/t06-ci-on-main.txt` · `git diff cc9f3f9 93a71f5` ·
`docs/fable/control/ARCHITECTURE-DECISIONS.md` FAD-52.

---

### REV-B-005 — MINOR

**Claim attacked.** doc 38 §3's evidence instruction ("evidence written ONLY under
`docs/evidence/EV-REVIEW-{A,B,C}/`" · "Required probes … author more") composed with
doc 38 §7's required final battery ("Fable docs validators (plan 36/36 · architecture
95/95 · research PASS)").

**What is true instead.** The two validators forbid application-code extensions
anywhere under `docs/`. `docs/fable/validate.py:166` rejects
`.ts .tsx .js .sql .tf .dockerfile` and `.py`; `docs/architecture/validate.py` assertion
52a rejects the same class and `.sh`. A reviewer who writes a probe source into its own
evidence directory — which is where §3 says probe sources go — turns §7's own battery
red. REV-B hit this by execution, not by reading:

```
52a. Documentation and research trees contain no application code  FAIL
     <- ['docs/evidence/EV-REVIEW-B/probes/red-case-arms.sh',
          'docs/evidence/EV-REVIEW-B/probes/privacy-log-leak.probe.test.ts']
10a. Docs tree contains no application code                        FAIL   (fable 35/36)
```

**Resolution applied in this bundle** (and offered as the convention): probe sources
carry a non-code suffix — `red-case-arms.sh.txt`, `privacy-log-leak.probe.test.ts.txt`.
`.mjs` is in neither list. After the rename: architecture **95/95**, fable **36/36**.

**Affected.** doc 38 §3, §7 · the two validators · every reviewer bundle.

**Evidence.** `transcripts/t17-validator-falsifiability.txt`.

---

### REV-B-006 — MINOR

**Claim attacked.** GH-008's registered follow-up item "vitest zero-match-exits-0 guard"
— i.e. that the hazard is understood and pending, and meanwhile nothing depends on it.

**What is true instead.** The hazard is real and unguarded, reproduced exactly:

```
$ pnpm exec vitest run packages/domain/test/ports/result-reproducibility.test.ts \
    -t 'NO_SUCH_TEST_NAME_REVB'
 ↓ |domain| test/ports/result-reproducibility.test.ts (31 tests | 31 skipped)
 Test Files  1 skipped (1)
      Tests  31 skipped (31)
EXIT=0
```

Zero tests executed, exit 0, no diagnostic. REV-B then established the mitigating half
by execution too: **no `-t` / `--testNamePattern` filter is used anywhere** in
`package.json`, `scripts/`, or `.github/workflows/ci.yml` (only path filters), and a
wrong PATH exits non-zero with `No test files found`, which
`scripts/red-cases/errored-signatures.mjs` matches and scores ERRORED. So the hazard is
latent, not live — but it is one `-t` away from making a battery decorative, in a
repository whose runner already carries a bespoke guard (FAD-51 D-1) for the sibling
case.

**Affected.** GH-008 · FAD-50 C-3 / FAD-51 D-1 · every battery that shells out to vitest.

**Evidence.** `transcripts/t03-vitest-zero-match.txt` ·
`transcripts/t04-vitest-nofiles-and-errored-signatures.txt`.

---

### REV-B-007 — NOTE

**Claim attacked.** I-17 / non-bypass rule 9 as it applies to 4xx error bodies —
"nothing leaks … for 5xx the message is a fixed string" (`apps/api/src/http/errors.ts`).

**What is true instead.** The 5xx half holds. On the 4xx half, one zod message shape
echoes caller-supplied text back into the response body:

```
marker in an unknown key
  echoes marker: YES
  body: Unrecognized key(s) in object: 'REVB-ECHO-MARKER-abcdef'
```

`parseBody` (`apps/api/src/http/routes/builds.route.ts:151`) relays `issue.message`
verbatim (truncated at 300 chars) into `validationProblemBodySchema`. The other shapes
tested do NOT echo: `Invalid uuid`, `String must contain at most 120 character(s)`,
`Expected string, received number`.

**Why only a NOTE.** The echoed text is the caller's own key name returned to the same
caller in the same exchange — no cross-tenant disclosure, no delivery material, and (per
REV-B-008) it does not reach the log. It is recorded because it is the one measured
channel by which client-supplied text crosses back out of a protected ingestion path,
and because a future route could put a free-text value in that position.

**Evidence.** `transcripts/t10-error-body-echo.txt`.

---

### REV-B-008 — NOTE

**Claim attacked.** I-17 / non-bypass rule 9 for the class it names first: "never log
delivery material or **payload bodies**". The repository proves this for authn secret
material (`apps/api/test/authn/secrecy.test.ts`) and proves audit payloads are closed
(`apps/api/test/audit/payload-closedness.test.ts`). REV-B could find **no test that
proves it for an ordinary request-body value**, and `apps/api/src/index.ts` ships
`logger: true` with no `redact` configuration.

**What REV-B measured.** A probe (source retained at
`probes/privacy-log-leak.probe.test.ts.txt`, applied as
`apps/api/test/builds/__revb_privacy_probe__.test.ts` and removed afterwards; tree
verified clean) drove one marker through six wire positions against the real server on
the real database and then read every line the server's own logger wrote:

```
REV-B PRIVACY PROBE
  marker: REVB-MARKER-352b3e0d2fcb4947be855afec7c0b26a
  requests: accepted-body-name=200  refused-body-id=422  refused-unknown-key=422
            query-string=404  path-segment=400  unknown-header=200
  log lines captured: 1
  log lines containing the marker: 0
  response bodies echoing the marker: 2
```

Both probe tests passed, including the falsifiability control (a needle planted through
`harness.app.log.info` IS found by the same hunt).

**The honest caveat, which is why this is a NOTE and not a clean pass.** Only **one** log
line was captured across six requests. The marker did not reach the log because on these
paths the server writes almost nothing: `buildServer` sets
`disableRequestLogging: true` (so no `req.url` line, which is what would otherwise carry
a query string), and `builds.route.ts`'s Postgres-error path logs only
`{ correlationId, sqlstate }`. That is a good design and it is the reason for the
result — but a "0 hits in 1 line" measurement is a thin haystack, and it says nothing
about routes whose 5xx path reaches `errors.ts`'s `request.log.error({ err: error }, …)`
with a driver error whose `detail` quotes a row value. REV-B did not construct such a
5xx.

**Recommendation (for the adjudicator, not a repair).** A standing regression of this
shape — marker in, log hunted, needle control — is cheap and would make rule 9's first
clause a tested property rather than a design intention.

**Evidence.** `transcripts/t20-privacy-log-probe.txt` · `transcripts/t05-privacy-static-sweep.txt`.

---

## C. Every battery figure, claimed against re-executed

Claimed = EV-M4-005 §24 (the M4 acceptance battery on `4f41935`, the frozen record) and,
where the delta supersedes it, the delta's own record. Re-executed = REV-B on
`review/rev-b` @ `f855340` (tree = `origin/main` + docs), this machine.

| # | Battery | Claimed | REV-B re-executed | Verdict |
| --- | --- | --- | --- | --- |
| 0 | `python3 docs/architecture/validate.py` | 95/95, exit 0 | **95/95, exit 0** | matches |
| 0 | `python3 docs/fable/validate.py` | 36/36, exit 0 | **36/36, exit 0** | matches |
| 0b | `bash schedulepoint-research/validate.sh` | PASS, exit 0 | **PASS, exit 0** (repository root; a genuinely fresh clone was NOT re-done — declared, §D) | matches as scoped |
| 1 | `corepack pnpm check` | 17 gates: 17 passed, 0 failed; exit 0 | **17 gates: 16 passed, 1 failed; exit 1** (unit) | **DIVERGES** — REV-B-002, REV-B-003 |
| 1a | └ unit | 2153 passed \| 14 skipped | **2166 passed \| 2 failed \| 14 skipped (2182); 2 failed test FILES** | count grows with the delta as expected; the failures are new — REV-B-002/003 |
| 1b | └ axe | green | **PASS — 430 passed, 16 skipped, 0 failed (11.6 min)** | matches locally; **fails on CI on the same tree** — REV-B-001 |
| 1c | └ request-budget | green | **PASS — 44 budgeted interactions, 87 recordings** | matches locally; **fails on CI on the same tree** — REV-B-001 |
| 1d | └ the other 14 gates | pass | **all pass** (route-policy 113 routes · migration-rls 19 files · raw-nul 1304 text / 273 binary, 0 violations · network-guard · import-boundary 251 modules / 685 deps · secret-scan · invariant-ids · rule-node-mapping · rule-kind-registry · provider-boundary · solver-kind-parity · lint · typecheck · build) | matches |
| 2 | `corepack pnpm red-cases` | **64/64 proven** (frozen record) / **65 arms** after FAD-52 | **not run in full — declared (§D)**. 5 arms run in the runner's own form, both directions: `network-guard-source`, `network-guard-bundle`, `request-budget-over`, `request-budget-missing`, `red-case-runner-errored-signatures` — **5/5 PROVEN, tree restored after each**. Plus the arms below. | as far as executed, matches |
| 2b | the full battery at the baseline | — | **corroborated independently**: CI run 32612471848 on `main` @ 93a71f5 ran all 13 shards green with the completeness guard reporting "Every one of the **65** red-case arms was run by exactly one of the 13 shards" | the 65/65 claim holds at the baseline |
| 3 | `corepack pnpm fixture-regression` | 153/153 (13 fixed seeds + 1 rotating + 139 standalone) | **not run — declared (§D)**; the arithmetic 13 + 1 + 139 = 153 verified against `scripts/sbx/fixture-regression.mjs` and `find apps/api/test -name '*.test.ts' \| wc -l` = **139** | the composition of the number is exact |
| 4 | `corepack pnpm sbx` | 9/9, 371 readings / 53 of 53 tables / 0 wrong-tenant, 0 vacuous | **`scenarios required 9 · executed 9 · passed 9 · failed 0 · blocked 0 · vacuous 0 · probe-error 0 · not-runnable 0`**; `readings: 371 (role, context, table) readings across 7 contexts; 0 wrong-tenant rows; 53 of 53 tables observed with visible rows`; all 9 marked `falsifiability probe: FALSIFIABLE`, 0 NOT-falsifiable; audit chain 0/1/0 per organization across 3 organizations; exit 0 | **matches, figure for figure** |
| 5 | migration populated cycle 0001–0019 | CLEAN by name, up→down→up→down→up, exit 0 | ran inside the unit gate (`migration-0019-populated-cycle.test.ts`, 2 tests) — **passed**; `migration-rls` gate PASS over 19 migration files | matches |
| 6 | real-stack critical path | **2 passed (39.4 s)**, both viewports, zero skipped | **2 passed (56.6 s), exit 0**, both viewports, zero skipped, MustRunReporter armed | **matches** |
| 6a | └ per-interaction request counts | 0 / 2 / 2 / 1 / 2 / 0 / 2 / 2 / 2 | **0 / 2 / 2 / 1 / 2 / 0 / 2 / 2 / 2** at both viewports | **identical to the retained record** |
| 7 | hygiene | tree clean | **tree clean after every probe** (`git status --porcelain` excluding this bundle: empty, checked after each red-case arm, each mutation and each validator probe) | matches |

### C-2. Probe-level figures REV-B produced

| Probe | Figure |
| --- | --- |
| assertion-mutation sample (vacuity) | **9 of 9 load-bearing, 0 vacuous**; every inversion drove its suite to exit 1; every file restored byte-identically (sha256 compared) — `transcripts/t15` |
| red-case arms in the runner's own form | **5 of 5 PROVEN both directions**, tree restored after each — `transcripts/t16` |
| validator falsifiability | **3 of 3 arms fail on demand** (architecture 31, architecture 33, fable 10a), each restored — `transcripts/t17` |
| REV-B-001 reproduction | **1 failure in 8 isolated runs**, then 0/12, then 0/10 under deliberate 4-core load — a ~1-in-30 local rate for the isolated test against ~1-in-≥4 in CI's full-suite run — `transcripts/t18` |
| registered routes / policy | **113** routes, all policy-declared; **112** exercised by SBX-001's role×route matrix; the one exclusion is `GET /health`, declared public — `transcripts/t09` |
| client third-party hosts in the built bundle | **0** request-capable hosts; 4 vendor string hosts (w3.org, reactjs.org, tanstack.com, tailwindcss.com), all inert; **2** `fetch` call sites in `apps/web/src`, both relative to `/api` — `transcripts/t07` |
| e2e inventory | 11 specs, 188 `test(` declarations, 446 collected cases across two projects, **10** explicit 320-pixel viewport assertions — `transcripts/t08` |
| concurrency/recovery matrix | 46 executed `it()` in `concurrency-recovery-matrix.test.ts` against doc 36 §2's claim of "40 named proofs"; the M-row ids run M-01…M-25 **with M-22 absent**, exactly as doc 36 §10.6 discloses | 


## D. Per-scope-area coverage (doc 38 §3's REV-B enumeration, verbatim, in order)

**executed** = REV-B ran something and read its exit code. **declared** = not executable
in this environment or this budget, with the reason and the arithmetic. No area is
silent.

| Scope area (doc 38 §3) | Status | What was executed / why not |
| --- | --- | --- |
| API enforcement | **executed** | `route-policy` gate: 113 registered routes, every one policy-declared (t09). The whole authorization surface re-ran inside the unit gate (`test/authz/**`, `test/sbx/**`) — all green. Route enumeration is done by booting the server and reading `onRoute`, so it cannot drift from a hand-list. |
| UI / backend agreement | **executed** | `apps/web/test/build-vocabulary.test.ts` (13) and `context-declaration.test.ts` (10) both green and both mutation-probed (M-04, M-05 — load-bearing). The FAD-52 `stopped-early` label is carried on both sides through one schema. |
| direct-request denial | **executed** | SBX-001's role×route matrix covers **112 of 113** routes × every principal, with real `__Host-sp_session` cookies, and refuses to pass if no cell allows; the T-05b byte-identical-404 pair runs inside it; its own falsifiability probe strips a policy and requires the oracle to notice. The single uncovered route is `GET /health`, declared public (t09). |
| database consistency | **executed** | `migration-rls` gate over 19 migration files; `migration-0019-populated-cycle.test.ts` (up→down→up→down→up, by name) green inside the unit gate; `roles-and-schema.test.ts`, `tenant-registry.test.ts` green. |
| jobs and queue recovery | **executed — and it produced REV-B-002** | `concurrency-recovery-matrix.test.ts` 46/46 green; `outbox-dispatch.test.ts`'s drain hook FAILED in the composed run (REV-B-002) and passed standalone and per-directory. |
| idempotency and duplicate operations | **executed** | matrix rows for idempotent retry, duplicate/stale worker results and double selection ran green inside the unit gate; the `publish-idempotency-key-retained` red-case arm exists and is covered by the CI shard battery at this baseline (not re-run locally — see the red-cases row). |
| error handling | **executed** | `apps/api/src/http/errors.ts` read and probed: 5xx is a fixed string; 4xx relays zod messages, one of which echoes caller text (REV-B-007, t10). `builds.route.ts`'s pg-error path logs only `correlationId` + `sqlstate`. |
| privacy boundaries (I-07/I-17) — grep AND execute | **executed** | grep: t05 (no `console.*` in any `src/`; every `request.log.*` call site inspected). execute: t19 — a marker driven through six wire positions and hunted in the server's own captured log, with a planted-needle falsifiability control. |
| browser network behaviour (allowlist EMPTY) | **executed** | `requestHosts: []` verified; REV-B's own independent scan of the built bundle found **0** request-capable third-party hosts and **2** relative `fetch` call sites (t07); the `network-guard-source` and `network-guard-bundle` red-case arms both PROVEN in both directions (t16). |
| form and interface states | **executed** | the axe suite ran all 446 collected cases (430 passed, 16 skipped, 0 failed) at both viewports, including the `SurfaceState` loading/empty/error/permission-denied assertions (t01, t11). |
| desktop, mobile and 320-pixel behaviour | **executed** | both standing viewports in the axe suite and in the real-stack run; 10 explicit `setViewportSize({width: 320})` assertions across 6 specs, all inside the passing run (t08, t01). |
| keyboard and accessibility behaviour | **executed** | axe-core across every page at both viewports, 0 violations; the keyboard journeys embedded in those specs ran green. **Not** re-derived by REV-B with its own axe configuration — the gate's own configuration was used. |
| request budgets | **executed** | re-measured: 44 budgeted interactions, 87 recordings, gate PASS locally; the same gate FAILS on CI on the same tree (REV-B-001); both budget red-case arms PROVEN in both directions (t16). |
| skipped or zero-test suites | **executed** | no `.only`; no `test.todo`; **zero** test files with zero `it()`/`test()` declarations; the 14 unit skips are all one opt-in measurement suite (`deterministic-cost.test.ts`, `describe.skipIf(!SP_MEASURE_DETERMINISTIC_COST)`); the 16 axe skips are viewport-specific `test.skip(info.project.name !== …)` plus the 2 real-stack guards; the vitest zero-match hazard reproduced and scoped (REV-B-006). |
| vacuous assertions | **executed** | 10 assertions sampled across 7 files in 5 vitest projects; 9 run (M-10 separately, see §C-2); **0 vacuous** (t15). |
| fixture and order coupling | **partly declared** | the `fixture-regression` gate's composition verified exactly (13 fixed + 1 rotating + 139 standalone = 153) but the gate was **not run** — see the rotating-seed row. |
| red cases | **executed + corroborated** | 5 arms locally in the runner's own form, both directions; the complete 65-arm battery green in CI on the baseline tree with a mechanical completeness guard (t06, t16). The full serial battery was **not** run locally: it measured **2 h 06 min** on the M4 reference machine (transcript 39, 14:23:44Z→16:30:19Z), i.e. **5.7–8.2 h** here. |
| rotating seeds | **declared not executable in budget** | `pnpm fixture-regression` runs 13 full shuffled `api` suites + 1 rotating + 139 standalone runs. One full `api` suite measured **~27 min** here (t14), so the fixed+rotating half alone is ≈ 6.3 h and the standalone sweep is on top of that. Not run. The rotating-seed MECHANISM was read and verified non-decorative (`Math.floor(Math.random()*1e6)`, printed before the run, FAD-15 ruling 3 stated in the output). |
| SBX non-vacuity | **executed** | see t20. |
| validator falsifiability | **executed** | 3 arms proven falsifiable (t17) — the packet asked for at least two. |
| CI and retained evidence accuracy | **executed** | the whole Actions ledger read through the API; the `main` gate-battery job log read in full; EV-M4-005 §24's six rows compared one by one against re-execution (§C); the retained real-stack transcript compared line-for-line against REV-B's own run. |


## E. Could not falsify — what REV-B attacked, and how it held

Each of these is something REV-B tried to break and could not. They are listed because
a review that reports only what it found is half a review.

1. **The client talks to no third party.** REV-B wrote its own scanner rather than
   trusting the gate's: every scheme-ful and protocol-relative URL in
   `apps/web/dist/**` resolves to four hosts, all of them string literals
   (`www.w3.org` ×12 namespace URIs, `reactjs.org`, `tanstack.com`, `tailwindcss.com`),
   none in a request-shaped context; the bundle contains 16 `fetch(` sites and **no**
   absolute-URL fetch target; `apps/web/src` has exactly **two** `fetch` call sites and
   both build their URL from `const API_PREFIX = '/api'`. `requestHosts` is `[]`. Both
   guard arms bite in both directions. Held.
2. **The real-stack critical path.** Re-executed end to end at both viewports against a
   throwaway migrated PostgreSQL cluster with RLS on, the production `apps/api` process,
   the real graphile-worker queue runner and real CP-SAT. 2 passed, exit 0, zero
   skipped, MustRunReporter armed. Every one of the nine recorded per-interaction
   request counts is **identical** to the retained M4 record. Held.
3. **Assertion non-vacuity.** Ten assertions inverted across seven files and five vitest
   projects — the reproducibility verdict in both polarities, the tenant-context epoch,
   two UI-vocabulary counts, the client's exact request count, a contract refusal, the
   client-host scanner, the request-budget gate, the domain layering boundary, and the
   NR-16 bare-SQL scanner. Every single one drove its suite red. None was vacuous. Held.
4. **The red-case arms bite in both directions.** Five arms re-run through the runner's
   own machinery, each `pass / fail / PROVEN`, each leaving a clean tree. Held.
5. **The doc validators are falsifiable.** Three separate assertions across two
   validators were made to fail on demand and restored. They are not decorative. Held.
6. **No suite is silently empty.** No `.only`, no `test.todo`, no zero-test file, and
   the two skip populations are both explained by construction (an opt-in measurement
   suite; viewport-specific declines plus the real-stack precondition, which is itself
   guarded by a reporter that fails a run in which nothing executed). Held.
7. **`GET /health` is the only route outside the role×route matrix**, and it is
   declared `public` with a stated reason. There is no undeclared route and no
   quietly-uncovered protected route. Held.
8. **The disclosed limitations are real and honestly sized.** doc 36 §10.6 says the
   matrix numbering skips M-22; the ids in
   `concurrency-recovery-matrix.test.ts` run M-01…M-25 with **M-22 genuinely absent** —
   a disclosed gap, not a renumbering. doc 36 §3 says two of the fourteen critical-path
   steps have no browser surface; the spec labels exactly those two as API-level in its
   own output. Held.
9. **The audit/authn secrecy hunt is not vacuous.** It carries a planted-needle control
   that fails if the hunt cannot find a needle in its own haystack. REV-B's own privacy
   probe was built the same way for the same reason. Held.
10. **The delta does not alter a frozen M4 claim it does not supersede.** `git diff
    cc9f3f9 93a71f5` over the code paths is additive: two explicit per-test timeouts,
    four `tabIndex={0}` attributes, a latched query key, a new verdict value with its
    label and its red-case arm, an `exitCode`-instead-of-`exit` flush fix, and comment
    corrections. No assertion was deleted, no budget raised, no gate removed; the arm
    count moved 64→65 by ADDITION. Held. (The one documentation consequence is
    REV-B-004.)


## F. Declared not executed, with the reason and the arithmetic

Nothing in this list is silent, and nothing in it is dismissed as unimportant.

| Not executed | Reason, measured |
| --- | --- |
| the complete serial `pnpm red-cases` battery (65 arms) | **2 h 06 min** on the M4 reference machine (transcript 39: begins 14:23:44Z, ends 16:30:19Z) → **5.7–8.2 h** at this machine's measured ratio. 13 arms were run individually instead, and the complete battery is independently corroborated green at this baseline by CI's 13 shards plus the completeness guard. |
| `pnpm fixture-regression` (153 runs) | 13 full shuffled `api` suites + 1 rotating + 139 standalone runs. One full `api` suite measured **1489.8 s (24.8 min)** here (t14), so the shuffled half alone is ≈ **6.3 h** before the standalone sweep. The composition of the claimed 153 was verified exactly instead (13 + 1 + 139, with `find apps/api/test -name '*.test.ts' \| wc -l` = 139). |
| red-case arms 21 (`i13-schedule-authoring`) and 22 (`publish-idempotency-key-retained`) | each runs `gate:axe` three times (green, red, restore). The axe gate measured **697 s** here (t01), so each arm costs ≈ **35 min**. Arm 22 was started and abandoned after 10 min; the interruption happened inside its GREEN half, before any patch, and the tree was verified clean immediately (`git status --porcelain` → only this bundle). Both arms are covered green at this baseline by CI shards 8 and 9. |
| a genuinely fresh clone for the research validator, and doc 38 §7's "fresh-clone validation against `origin/main`" | §7's final-battery item, not a §3 REV-B probe. The research validator was run from the repository root (PASS, exit 0). |
| an independent axe configuration | the gate's own Playwright + `@axe-core/playwright` configuration was used, at both standing viewports. REV-B did not build a second accessibility harness; the packet asks for keyboard and accessibility BEHAVIOUR, which the existing suite exercises and which ran green. |
| assistive-technology sessions | doc 36 §3 already declares SPEC-14's 10 M-cells unclaimed. REV-B confirms they are unclaimed and does not claim them. |
| reading `.evidence-scratch/` and the untracked `scripts/gates/request-budget/recordings/` produced by an earlier process in this container (before 03:27) | **the blindness rule.** Those artifacts could carry another reviewer's output. They were not read. Files written by REV-B's OWN runs were read, with the mtime checked first (e.g. the SBX scenario report, mtime 04:44:23). |

## G. The delta (`milestone/M4..origin/main`), judged per doc 38 §1

**(a) Does it alter a frozen M4 claim it does not explicitly supersede?** No, on
inspection of the whole diff. The code changes are additive or comment-only:
two explicit per-test timeouts (`e2-objective.test.ts` — 480 s / 540 s), one explicit
timeout on the R-B4a sweep (`zoned-time.test.ts`, 120 s), four `tabIndex={0}` attributes
in `apps/web/src/catalogue/**`, a latched period id in `VersionComparisonPage.tsx`, a
sixth `resultReproducibility` value (`stopped-early`) with its contracts enum entry, its
route lift, its web label and its own new red-case arm, `process.exit` →
`process.exitCode` in `check.mjs` (a stdout-flush fix), and additive fields on the
`wallClockVerdict` test helper. **No assertion was deleted, no budget raised, no gate
removed, no arm renamed or reordered.** The battery moved 64 → 65 by ADDITION, which the
CI completeness guard now asserts mechanically.

**(b) Its own correctness.** The FAD-52 derivation is exercised by 31 domain tests, and
REV-B inverted two of its assertions (both polarities of `reproducible`) and both went
red; both of its red-case arms bite in both directions. The GH-006 latching fix is
exercised by `publication-change-comparison` at budget 2, which passed here. The GH-003
`tabIndex` change is covered by the axe gate, which passed here (430/0). The GH-005
timeout raise is correct as far as it goes — **and incomplete**, which is REV-B-003.

**(c) One documentation consequence.** doc 36 is a frozen record and was deliberately not
retro-edited; FAD-52 carries the supersession. doc 36 nonetheless contains a
now-superseded portability claim and a now-superseded arm count with **no pointer to
FAD-52**, which is REV-B-004.

## H. The single question

> **Does the evidence at the baseline support the claims the exit reports make — no more,
> no less?**

**Substantially yes, with two exceptions that are real and one class of documentation
drift.**

What the evidence genuinely supports, re-executed rather than read: the marquee claim —
the 14-step critical path against a real browser, a real API, a real migrated
RLS-enforced PostgreSQL, the real queue runner and real CP-SAT — reproduces at both
viewports with request counts identical to the retained record. SBX reproduces figure
for figure: 9/9, 0 vacuous, 371 readings, 53 of 53 tables, 0 wrong-tenant, every
scenario carrying a falsifiability probe. The complete 65-arm red-case battery is green
on this exact tree in CI with a mechanical completeness guard, and 13 arms re-proven
locally bite in both directions. Ten sampled assertions across five vitest projects are
all load-bearing; none is vacuous. Three doc-validator assertions can be made to fail on
demand. The client contacts no third party — verified against the built bundle with
REV-B's own scanner, not the repository's. Every registered route declares a policy and
112 of 113 are swept by a role×route matrix that refuses to pass if nothing is allowed.
The disclosed limitations REV-B could check (the M-22 gap, the two API-only critical-path
steps) are real and honestly sized. This is a strong evidentiary record, and it is
stronger than most of what is claimed for it.

Where it does **not** support the claim as stated:

1. **"17/17 gates, exit 0" is not a property of this tree.** It is red on `main` in CI at
   the baseline (REV-B-001, an intermittent I-13/I-10 harness race, reproduced locally 1
   in 34) and it is red on a correct-but-slower machine (REV-B-003, two arms exceeding
   the 120 s ceiling by 8 %). Doc 38 §9's criterion 8 does not hold today.
2. **"NR-15 … VERIFIED, clean across the complete seed set" did not hold** on the first
   full composed run REV-B executed on the baseline (REV-B-002), and the seam it names is
   still visible at the failing call site.
3. **doc 36 carries superseded figures with no pointer to their supersession**
   (REV-B-004) — the frozen-record convention is defensible, but a reader of the exit
   report alone is currently misled about a portability property and an arm count.

None of the three falsifies a product claim. All three falsify a claim about the
*evidence*, which is exactly what this packet was asked to test. The correct disposition
for REV-B-001 is to repair the recorder window; the invariant and its budget must not
move.

---

**Filed by REV-B, 2026-08-23, blind to REV-A. This reviewer implemented nothing. Every
figure above was produced by a command whose exit code was read; every command's output
is in `transcripts/`; every code-modifying probe was restored and the tree verified
clean after each.**
