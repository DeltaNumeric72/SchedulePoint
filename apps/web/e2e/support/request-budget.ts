import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page, Request } from '@playwright/test';

/**
 * Requests-per-interaction recorder (SP-HR-2 / I-10).
 *
 * The browser side of the budget gate. It records how many network requests one
 * named interaction produced and writes the recording where
 * `scripts/gates/request-budget.mjs` can compare it against
 * `scripts/gates/request-budget/budgets.json`.
 *
 * Recording and enforcement are split on purpose: the recorder needs a browser,
 * the gate must be able to fail in CI on a machine where the browser step has
 * already run, and the gate must fail **loudly when a budgeted interaction has
 * no recording at all** — otherwise a broken e2e run would silently satisfy the
 * budget.
 */

const RECORDINGS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../scripts/gates/request-budget/recordings',
);

/**
 * How long the page must stay silent before it counts as quiet, in ms.
 *
 * This is the DEFINITION of quiescence, not a sleep. It is the same 500 ms
 * Playwright's own `networkidle` uses, and it is never waited out on purpose:
 * the wait below ends as soon as the condition holds, and a page that is
 * already quiet clears it in one timer tick. Raising or lowering it changes
 * what "settled" means; it does not tune a delay.
 */
const QUIET_PERIOD_MS = 500;

/**
 * Fail-loud upper bound on a single quiescence wait, in ms.
 *
 * A page that never goes quiet must not be waited on forever, and it must not
 * be silently proceeded past either — proceeding would put the recorder back in
 * the business of measuring a race. So this THROWS, naming the last request
 * seen, and never resolves-and-continues. `apps/web/src` issues no timer,
 * polling, `EventSource` or socket traffic, so reaching this bound means
 * something genuinely new is on the page and the recording would have been
 * meaningless anyway.
 *
 * It is 10s rather than something rounder because it has to fire FIRST to be
 * worth anything. `playwright.config.ts` sets no per-test `timeout`, so
 * Playwright's own 30s default applies; a 30s bound here would always lose that
 * race and the diagnosis below — which names the request still in flight —
 * would never print. A test that dies on the generic timeout tells whoever
 * reads the CI log nothing about why.
 */
const QUIESCENCE_TIMEOUT_MS = 10_000;

/**
 * Resolves once nothing has been in flight for `QUIET_PERIOD_MS` — **among the
 * requests this call has observed since it began**.
 *
 * That bound is the honest one and it is worth stating precisely, because the
 * shorter version ("nothing in flight") claims more than a per-call primitive
 * can deliver. A request already open when the wait starts was never seen
 * starting, so it is tracked only if it SETTLES inside the quiet period: a fast
 * straggler re-arms the timer and is duly waited for, while one that outlives
 * the whole 500 ms is invisible at this layer. Playwright's own `networkidle`
 * does not have that hole because it tracks from page creation — and it is
 * unusable here for the sticky-lifecycle reason below. This is the trade: a
 * primitive that is always live and slightly short-sighted, over one that sees
 * everything and goes permanently stale after the first firing.
 *
 * In this suite the trade costs nothing, because every caller reaches the open
 * side after its own page-load awaits and the close side after `action` has
 * resolved. It is written down so the next person changing this knows which
 * guarantee they actually have.
 *
 * ## Why this is not `page.waitForLoadState('networkidle')`
 *
 * Because that call does not do this. Playwright's `networkidle` is a
 * **lifecycle event, and the lifecycle is sticky**: `_inflightRequestStarted`
 * (playwright-core `lib/server/frames.js`) calls only `_stopNetworkIdleTimer`,
 * which clears the pending timer — it never removes `'networkidle'` from
 * `_firedLifecycleEvents`. The one place that removes it, `_recalculateNetworkIdle`,
 * is reached from the idle timer's own callback and from `_onClearLifecycle`,
 * i.e. from NAVIGATION. So once the state has fired for a document, every later
 * `waitForLoadState('networkidle')` on that same document returns immediately,
 * however much traffic is in flight.
 *
 * Measured, not inferred. With a deliberately 2000 ms request in flight:
 *
 *     firstWait=2535ms  waitWith2000msRequestInFlight=2ms  thirdWait=2ms
 *
 * An earlier revision of this file used `waitForLoadState` on both sides. The
 * open side worked by accident — it ran before the state had first fired — and
 * three things were wrong with it: the CLOSE-side wait was inert (1-3 ms on 42
 * of 43 invocations); the open-side wait PRE-FIRED the lifecycle, which
 * silently disabled the spec-local `waitForLoadState` that OPUS-GH-006 had put
 * inside `publication.spec.ts` (503-505 ms at HEAD, 1-2 ms with that revision
 * in place — an existing protection turned off as a side effect); and the open
 * side was real only for the FIRST recording on a document, so every
 * second-and-later `recordRequests` call in the same test got nothing.
 *
 * Two of those three are repaired by not being possible here. The third is not,
 * and saying otherwise would be the same mistake again: **GH-006's spec-local
 * wait is still inert, measured at 2-4 ms with this primitive in place.** It has
 * to be. Any correct open-side quiescence wait leaves the page idle for 500 ms
 * before the action, and Playwright's own idle timer fires its lifecycle during
 * exactly that silence — no call of ours required. What removes the risk is not
 * that line waking up again; it is that the recorder's own close-side wait now
 * does the job non-stickily (measured 501-503 ms on the same interaction, and
 * it captures the follow-on read every run).
 *
 * This primitive has no such failure mode because it holds no state between
 * calls: it attaches its own listeners, counts what is in flight, and detaches.
 * There is nothing to go stale, so the stickiness point is moot rather than
 * worked around, and every invocation is as real as the first.
 *
 * ## What it waits for
 *
 * `networkidle`'s semantics: quiet means nothing IN FLIGHT, so the timer is
 * armed when the in-flight count reaches zero and cancelled when a request
 * starts. It deliberately does not resolve 500 ms after the last request was
 * *issued* — a slow request would still be open, and a follow-on read triggered
 * by its response is exactly the thing these windows exist to catch.
 */
async function waitForQuiet(page: Page): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    /* The set IDENTIFIES what is in flight rather than counting it, and that is
     * load-bearing. `requestfinished` also fires for requests that were already
     * open when this wait began — requests `onRequest` never saw. A counter
     * decrements on those anyway, so an unrelated settle could zero it while a
     * request this wait IS tracking was still open, and the wait would resolve
     * early. Deleting an unknown member of a Set is a no-op, so the same event
     * is correctly ignored here, and the straggler re-arm behaviour is
     * unchanged: the set empties only when everything it actually saw start has
     * settled. */
    const inFlight = new Set<Request>();
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let lastRequest = '(none — the page was already quiet when the wait began)';

    const cap = setTimeout(() => {
      cleanup();
      rejectPromise(
        new Error(
          `recordRequests: the page never went quiet for ${String(QUIET_PERIOD_MS)}ms within ` +
            `${String(QUIESCENCE_TIMEOUT_MS)}ms (${String(inFlight.size)} request(s) still in ` +
            `flight; last request seen: ${lastRequest}). A recording taken here would be a race, ` +
            `so this fails rather than proceeding.`,
        ),
      );
    }, QUIESCENCE_TIMEOUT_MS);

    function cleanup(): void {
      page.off('request', onRequest);
      page.off('requestfinished', onSettled);
      page.off('requestfailed', onSettled);
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      clearTimeout(cap);
    }

    function arm(): void {
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        cleanup();
        resolvePromise();
      }, QUIET_PERIOD_MS);
    }

    function onRequest(request: Request): void {
      lastRequest = `${request.method()} ${request.url()}`;
      inFlight.add(request);
      if (quietTimer !== undefined) {
        clearTimeout(quietTimer);
        quietTimer = undefined;
      }
    }

    function onSettled(request: Request): void {
      inFlight.delete(request); // no-op when untracked — that is the D-2 fix
      if (inFlight.size === 0) arm(); // ...and an untracked settle still re-arms
    }

    page.on('request', onRequest);
    page.on('requestfinished', onSettled);
    page.on('requestfailed', onSettled);
    arm();
  });
}

export interface RequestRecording {
  readonly interaction: string;
  readonly project: string;
  readonly requests: readonly { method: string; url: string; resourceType: string }[];
  readonly recordedAt: string;
}

/**
 * Counts every request the page issues while `action` runs.
 *
 * Data URLs and blob URLs are excluded: they are not network requests and
 * counting them would make the budget measure bundling choices rather than
 * request amplification.
 *
 * ## The window is bounded by measured quiescence at BOTH ends (R-1 / FAD-53)
 *
 * The window used to open the moment the caller reached this function, which in
 * practice meant the moment some element became VISIBLE in the caller's own
 * `await expect(...).toBeVisible()`. A painted element is not a settled page:
 * `PeriodsPage` renders its "New period" control ABOVE the `SurfaceState` that
 * the `['schedule-periods', …]` query feeds, so the control is visible while
 * that query's own fetch is still to come. The page's OWN read then landed
 * inside a window that exists to count what a CLICK caused, and an I-13
 * assertion of ZERO failed for a reason that has nothing to do with I-13.
 *
 * That was not a theory. Instrumented at HEAD before this change (22 runs,
 * mobile): the page issues its second `GET …/schedule/periods` between 4 ms and
 * 12 ms BEFORE the window opened on every passing run, a page-load request was
 * still IN FLIGHT at window-open on all 22 (+5..+9 ms), and under CPU load one
 * run in 25 issued it 8 ms AFTER — captured, budget 0, red. Three consecutive
 * `main` push runs died this way, in two different batteries. The product was
 * innocent every time: against the real stack the same interaction records 0 at
 * both viewports.
 *
 * So the boundary is a CONDITION rather than a coincidence. `waitForQuiet`
 * above runs before the listener is attached and again after `action` returns.
 * Both ends matter and they are not the same repair:
 *
 * - **Open side.** Waiting first means nothing has started for 500 ms when
 *   recording begins, and nothing the wait SAW start is still open (the bound
 *   `waitForQuiet` documents — a request already in flight at entry is covered
 *   only if it settles inside the quiet period). So page-load traffic the
 *   interaction did not cause cannot be charged to it. This makes the count
 *   HONEST, not smaller-on-purpose: what it excludes is measurement noise, and
 *   every zero-budget assertion (18 of the 44 budgeted interactions run through
 *   this helper) is unchanged.
 * - **Close side.** Waiting last can only ever ADD requests to the recording,
 *   never remove one, so it is a strengthening and can never be a way to pass a
 *   budget. This is OPUS-GH-006's fix promoted out of the one spec that first
 *   needed it: on the publication comparison page a follow-on read issued from
 *   a React passive effect ~4 ms after the response the window closed on fell
 *   outside the recording on a quiet machine and inside it on a loaded CI
 *   runner. That spec's own wait is left in place because its comment is the
 *   record of that incident — but it is inert, and the protection that actually
 *   holds is this one, because this one is not sticky. See `waitForQuiet`.
 *
 * No budget, assertion or expected count moved for any of this, and no sleep or
 * timeout constant was introduced: `QUIET_PERIOD_MS` defines "settled" and
 * `QUIESCENCE_TIMEOUT_MS` only decides how loudly an unsettleable page fails.
 *
 * ## The boundary is about REQUESTS, and only requests
 *
 * Quiescence waits for the network, not for a React commit. That distinction is
 * the counter-lesson recorded at `critical-path.spec.ts:681-698`, where a spec
 * that used `networkidle` to wait for a rendered OUTCOME was looking one commit
 * too early. It does not apply here and this helper must not be read as licence
 * to repeat it: the recorder's contract is about REQUESTS, which is exactly
 * what quiescence bounds. A caller that needs a rendered outcome still has to
 * await that outcome itself, inside `action`, as every caller here does.
 *
 * ## Known residual, named rather than left to be discovered
 *
 * `critical-path.spec.ts` has its own private `recordStep` recorder with the
 * same DOM-signal shape this repair removes. It is NOT fixed here, and it is not
 * harmless-by-construction either: lines 364 and 486 are hard
 * `expect(...requests...).toEqual([])` I-13 assertions, so this recorder CAN
 * fail a run. It cannot fail CI *today* only because the real-stack config is
 * not wired into `ci.yml` — and doc 38 §7 puts the real-stack e2e in the
 * required final battery, so that reprieve is temporary rather than structural.
 *
 * What actually holds it up is placement: both sites bracket with an explicit
 * `waitForLoadState('networkidle')` (lines 358 and 474) that is the FIRST such
 * call after their `page.goto` (lines 326 and 472). A fresh navigation clears
 * the lifecycle, so that one position is where the call is not yet sticky and
 * genuinely waits. Move either assertion, add a second recording to those
 * tests, or let anything else fire the state first, and the mitigation is gone.
 * It is out of R-1's scope and stays a residual until someone rules on it.
 */
export async function recordRequests(
  page: Page,
  interaction: string,
  project: string,
  action: () => Promise<void>,
): Promise<RequestRecording> {
  // The page's own load settles BEFORE the window opens. See the docblock.
  await waitForQuiet(page);

  const requests: { method: string; url: string; resourceType: string }[] = [];

  const listener = (request: Request): void => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    requests.push({ method: request.method(), url, resourceType: request.resourceType() });
  };

  page.on('request', listener);
  try {
    await action();
    // Everything the action set off has landed before the window closes.
    await waitForQuiet(page);
  } finally {
    page.off('request', listener);
  }

  const recording: RequestRecording = {
    interaction,
    project,
    requests,
    recordedAt: new Date().toISOString(),
  };

  mkdirSync(RECORDINGS_DIR, { recursive: true });
  writeFileSync(
    resolve(RECORDINGS_DIR, `${interaction}.${project}.json`),
    `${JSON.stringify(recording, null, 2)}\n`,
    'utf8',
  );

  return recording;
}
