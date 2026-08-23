# REV-B — delta verification of R-1 / FAD-53 (the repair for REV-B-001)

**Reviewer:** REV-B, the original finder of REV-B-001, continued (doc 38 §6 step 6 —
"delta verification by that reviewer", the same-agent form). The blindness constraint of
doc 38 §4.2 ended when REV-B filed; this verification is not blind to anything.

**Under verification:** the uncommitted three-file diff on
`claude/schedulepoint-github-auth-a4ns2p` @ `9ee1ae1`:

| File | sha256 as found (and as left) |
| --- | --- |
| `apps/web/e2e/support/request-budget.ts` | `d6deff3865912acecb9d2370f0f5437c3f53ccb03b75d0402c2a1bce21fe1791` |
| `apps/web/e2e/settings.spec.ts` | `f52845d5e78668e26414d0c979293a5341c33a47a00a0b45670f6c612f9f1fd0` |
| `apps/web/e2e/catalogue.spec.ts` | `85ae3106941df62075a7b4887fa646a9aa9cb77c5bd0ac8dd9c4842416c3d627` |

REV-B implemented nothing. Four temporary probes were applied and every one restored
byte-identically, verified by sha256 before and after (§4). Transcript:
`transcripts/t22-r1-delta-instrumented.txt`.

---

## 1. What the diff actually does (read, not summarised from the packet)

`recordRequests` now brackets its window with `waitForQuiet(page)` on **both** sides:

```
await waitForQuiet(page);          // OPEN side — before the listener is attached
const requests = [];
page.on('request', listener);
try {
  await action();
  await waitForQuiet(page);        // CLOSE side — listener still attached
} finally {
  page.off('request', listener);   // detached only here
}
```

Two properties matter and REV-B checked both **in the source** before measuring anything:

1. **The open-side wait completes before `page.on('request', listener)`.** So the
   recorder cannot be handed a page-load request it never caused. Confirmed by reading
   the order of the statements above.
2. **The close-side wait sits inside the `try`, and `page.off` is in the `finally`.**
   The listener is therefore *live* throughout the close-side wait, so that wait can
   only ever ADD requests to the recording and can never remove one. This is the
   property that makes the change incapable of masking a real amplification, and it is
   structural rather than incidental. Confirmed by reading.

`waitForQuiet` itself holds no state between calls — it attaches its own
`request`/`requestfinished`/`requestfailed` listeners, tracks in-flight requests in a
`Set<Request>`, arms a 500 ms timer when the set empties, cancels it when a request
starts, and detaches. That is what makes it immune to the `networkidle` stickiness the
docblock documents. The 10 s cap **throws** naming the in-flight count rather than
resolving-and-continuing, so an unsettleable page fails loudly instead of producing a
raced recording.

The two spec-local zero-assertion brackets (`settings.spec.ts`, `catalogue.spec.ts`)
move their `page.on('request', listener)` inside `action()`. Both keep their `page.off`
**after** `recordRequests` returns, so they also observe the close-side extension — the
same strictly-stronger position as the recorder. Both assertions are byte-unchanged:
`expect(requests, …).toEqual([])`.

## 2. The measurements REV-B took with its own hands

### 2a. The window boundary, instrumented

Temporary instrumentation inside `recordRequests` printed the open-side wait duration,
what the page issued during it, and the close-side wait duration. Run against **the
original REV-B-001 reproduction shape** — `schedule.spec.ts`, `--project=mobile`,
`--grep "New period"`:

```
[REVB] schedule-open-new-period/mobile open-side wait = 508ms; ... the page was ALREADY quiet at entry
[REVB] schedule-open-new-period/mobile close-side wait = 503ms; recorded 0 request(s): (none)
[REVB] ... open-side wait = 508ms ... close-side wait = 502ms; recorded 0 request(s)
[REVB] ... open-side wait = 507ms ... close-side wait = 503ms; recorded 0 request(s)
```

The window opens **~507 ms after the page last did anything**, and it closes only after
another ~502 ms of silence. On a calm machine the page's own `GET …/schedule/periods`
has already settled at entry, which is exactly the "4–12 ms before the window opened"
condition REV-B measured at HEAD in its review — the near-miss side of the same race.

### 2b. The race itself, forced

A calm machine cannot show the repair absorbing the racing read, because the read is
already done. REV-B therefore held the page's OWN periods read open for a controlled
interval (temporary route delay in `schedule.spec.ts`, restored) so that it was
genuinely in flight when `recordRequests` was entered — the precise condition
REV-B-001 was about:

| forced delay on the page's own read | open-side wait | close-side wait | recorded | test |
| --- | --- | --- | --- | --- |
| 0 ms (control) | 510 ms | 502 ms | **0** | passed |
| **300 ms** | **805 ms** | 504 ms | **0** | passed |
| 700 ms | 507 ms | 653 ms | **0** | passed |
| 1500 ms | 507 ms | 504 ms | **0** | passed |

The 300 ms row is the one that matters: **805 ≈ 300 + 500.** The read was in flight at
entry, its settle re-armed the quiet timer, and the wait extended to absorb it — the
straggler re-arm the docblock describes, measured rather than asserted. The recording
stayed 0 in every row.

### 2c. Anti-masking — can the repaired recorder still SEE what the click caused?

Reading the code is not enough for this one, so REV-B injected real amplifications into
the product (temporary patch to `apps/web/src/schedule/PeriodsPage.tsx`, rebuilt,
measured, restored, rebuilt):

| injected click-caused request | close-side wait | recorded | test |
| --- | --- | --- | --- |
| immediate `fetch('/api/health')` (the shipped red case's violation) | 548 ms | **1** | **FAILED, as required** |
| the same fetch **400 ms after** the click | **939 ms** | **1** | **FAILED, as required** |
| the same fetch **2000 ms after** the click | 502 ms | 0 | passed |

Row 1 proves the existing red case still bites. **Row 2 is the important one: it is
coverage the recorder did not have before the repair** — a 400 ms-late amplification
fell outside the old window entirely, and the close-side wait now catches it (939 ≈
500 + the tail of the delay). Row 3 is the honest bound: an amplification arriving more
than one quiet period after the action resolves is still not seen. That bound is
strictly wider than the pre-repair behaviour, never narrower, so the change is a
strengthening at every point.

### 2d. The green sweep, idle and loaded

Instrumentation removed, files byte-identical to as-found, the original reproduction
shape run 12 times:

```
IDLE FAILURES: 0 of 6          (1-min load average 0.57 at start)
LOADED FAILURES: 0 of 6        (four busy loops; 1-min load average 2.93 at finish)
TOTAL: 0 failures in 12 runs
```

REV-B's pre-repair measurement of the same shape was **1 failure in 34**; the CI rate at
the baseline was ~1 in ≥4 clean-tree axe runs on one commit. Twelve green runs do not by
themselves refute a 1-in-34 intermittent — that is stated plainly — which is why §2b is
the load-bearing evidence and this sweep is corroboration, not proof.

### 2e. The two gates that were RED in CI at the baseline

Both re-run in full on the repaired tree, by REV-B:

```
$ corepack pnpm gate:axe
  16 skipped
  430 passed (13.0m)
AXE EXIT=0

$ corepack pnpm gate:request-budget
PASS  request-budget (SP-HR-2 / I-10) — 44 budgeted interaction(s), 87 recording(s)
BUDGET EXIT=0
```

Same 446 collected cases as REV-B's pre-repair run (430 passed / 16 skipped / 0 failed),
13.0 min against 11.6 min before — the ~1.4 min the two waits cost, which matches §3.3.

REV-B then checked the recordings **this** run wrote, independently of the gate:

```
recordings on disk: 87
zero-budget recordings checked: 36; NOT at zero: 0
recordings over budget: 0
```

36 = the 18 zero-budget interactions × two projects. **Every one is literally
`"requests": []`, and no recording anywhere exceeds its budget.** The repair did not buy
a green gate by lowering what is measured.

## 3. Residuals REV-B is naming rather than leaving to be found

1. **The `waitForQuiet` bound is real and reachable.** A request already in flight at
   entry is absorbed only if it settles inside the 500 ms quiet period. §2b row 3
   (700 ms) shows the wait resolving at 507 ms with the read still open. In this
   interaction it is harmless — a *response* is not a request, and nothing followed it —
   but the original failure class is **narrowed, not eliminated**: it would now require
   the page's own in-flight read to outlive 500 ms *and* its response to trigger a
   follow-on request. That is a far smaller target and it is documented in the source,
   which is the right disposition; it is recorded here so nobody reads "fixed" as
   "impossible".
2. **One clause of the repair's own residual note is wrong.** The docblock says of
   `critical-path.spec.ts`'s private `recordStep`: *"It feeds the real-stack EVIDENCE
   LEDGER rather than the budget gate, so it cannot fail CI."* The first half is right;
   the conclusion is not. `critical-path.spec.ts:364` is
   `expect(openForm.requests, 'opening the period form issued a request').toEqual([]);`
   and `:486` is the same for the configuration form — hard I-13 assertions on the
   unrepaired recorder shape, not ledger writes. They cannot fail CI **today** only
   because the real-stack configuration is not wired into `ci.yml`; doc 38 §7 puts
   "real-stack e2e at both viewports" in the required final battery. Mitigating, and
   verified by reading: both sites bracket with `waitForLoadState('networkidle')` at
   line 358 and line 474, each the **first** such call after a `page.goto` (lines 326
   and 472) — the one position where that call is not sticky. So the residual is
   genuinely low-risk and genuinely out of R-1's scope; only its stated reason needs
   correcting.
3. **`QUIET_PERIOD_MS` costs wall time.** Each recording now spends ~1.0 s in the two
   waits. With 18 zero-budget interactions plus the rest of the 44 budgeted ones across
   two projects, that is roughly a minute added to the axe gate. Named, not objected to.

## 4. Tree discipline

Four temporary probes, each restored and each verified by sha256:

| probe | file touched | restored |
| --- | --- | --- |
| timing instrumentation | `apps/web/e2e/support/request-budget.ts` | `d6deff38…` — matches as-found |
| forced in-flight read | `apps/web/e2e/schedule.spec.ts` | `08f42938…` — matches its committed state |
| three injected amplifications | `apps/web/src/schedule/PeriodsPage.tsx` | `d95c3a16…` — matches its committed state |
| the bundle | `apps/web/dist` (untracked) | rebuilt from restored source |

`git status --porcelain` was left showing exactly the three repair files as modified, and
nothing else.

## 5. Verdict

**REV-B-001: CLOSED.**

The finding was that `pnpm check`'s `axe` and `request-budget` gates fail intermittently
because the recorder's window could open before the page's own initial query was on the
wire, charging a page-load read to a click and turning an I-13 zero-request assertion
red for a reason that has nothing to do with I-13.

The repair addresses that mechanism at the mechanism, not at the symptom:

- the window boundary is now a **measured condition** (500 ms of network silence) rather
  than a DOM signal — verified by instrumentation at 507–508 ms on the open side;
- the exact race is **absorbed** — verified by forcing the page's own read to be in
  flight at entry and watching the wait extend to 805 ms and the recording stay 0;
- **no assertion, budget or expected count moved.** All 36 zero-budget recordings are
  still empty and `expect(...).toEqual([])` is byte-unchanged in both specs. CLAUDE.md
  rule 10 is satisfied: the test was strengthened, not weakened;
- the fix **cannot mask a real amplification** — proven positively, by injecting one and
  watching the recorder catch it, including a 400 ms-late one the old window would have
  missed;
- the product's innocence, which REV-B established in its review (`transcripts/t12`:
  0 requests at both viewports against the real stack), is untouched and remains the
  reason this was always a harness defect.

Two residuals are recorded above (§3.1 the narrowed-not-eliminated bound, §3.2 the
incorrect "cannot fail CI" clause about `critical-path.spec.ts`). **Neither reopens
REV-B-001** — the first is an honest, documented, much smaller bound on the same
primitive; the second is a comment correction plus a scope question about a file R-1
deliberately did not touch. Both belong in the docket, not in this finding.
