import { capabilityDefinition } from '@schedulepoint/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { capabilityRouteConfig, routeActionProblems } from '../../src/http/policy.js';
import type { RouteTableEntry } from '../../src/http/route-table.js';
import { buildServer } from '../../src/http/server.js';

/**
 * The request surface's POLICY declarations — SPEC-08 §4, SPEC-06, I-02
 * (OPUS-M5-001, doc 42 §5c Part D; EXTENDED by OPUS-M5-002, doc 42 §5d Part C).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## Why this file exists beside `test/http/route-declarations.test.ts`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That file asserts the GENERAL obligations over every route Fastify registers:
 * a policy exists, a scope is declared, the action key is in the catalogue, the
 * scope and module agree with it. Those apply to this surface automatically and
 * are not restated here.
 *
 * This file asserts what is SPECIFIC to the request surface, and specifically the
 * one thing SPEC-08 §4 states as a rule and this codebase enforces as a **config
 * field**:
 *
 * > **Withdraw** — **Requester-initiated only.** An administrator "withdrawing"
 * > for someone is a **denial with a reason**, recorded as such.
 *
 * The mechanism is `ownershipRequired: true` with **no**
 * `ownershipOverrideCapability`. An ownership override on the withdrawal route
 * would be precisely the confusion §4 forbids, spelled as one added line — and
 * nothing else in the build would object, because an override is a perfectly
 * valid field that other routes legitimately use. **A rule enforced by the
 * ABSENCE of a field needs a test that asserts the absence**, or the field can
 * be added back by anybody who thinks it looks like an oversight.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## OPUS-M5-002 — THE DECLARED RESTRUCTURING OF THIS FILE. Read this before
 *    comparing it to its M5-001 form.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * M5-001 shipped this file asserting that the surface registers **exactly four**
 * routes and that **every** route on it is self-scoped — `requiresObjectPolicy`
 * and `ownershipRequired` both true. Both assertions were correct then and both
 * are deliberately changed here, in the M5-001 three-way-restructuring style:
 * state the change, say why, and preserve the prior assertions' MEANING rather
 * than their letter.
 *
 * **What changes.** The exact-count assertion was written to make the
 * scheduler-queue scope MOVE a decision rather than something that quietly slips:
 * *"an added route on this surface fails here until somebody updates the list."*
 * It has now done its job — the queue arrived in the packet it was moved to — so
 * the list is updated, deliberately, and the count assertion stays.
 *
 * **What is PRESERVED, exactly.** The surface is split into two named sets, and
 * every M5-001 assertion is re-run over `OWN_ROUTES` unchanged:
 *
 *  * `OWN_ROUTES` — the four staff routes. Still self-scoped, still
 *    `ownershipRequired: true`, still no override. The §4 withdrawal ruling is
 *    asserted over exactly the set it was written about, so the assertion has not
 *    been diluted by averaging it across a wider surface.
 *  * `SCHEDULER_ROUTES` — the six M5-002 routes. `requiresObjectPolicy: false`
 *    and no ownership, because they act on other people's rows on purpose. What
 *    scopes their rows is migration 0023's narrowing (`requests_group_read_any`,
 *    `requests_group_administration`), which is a property of the DATA rather
 *    than of which URL was called.
 *
 * **The no-override assertion is NOT narrowed** — it still runs over the whole
 * surface. On a route that does not require ownership an override is meaningless,
 * so asserting its absence everywhere costs nothing and keeps the rule from being
 * quietly re-scoped later.
 *
 * ## The one assertion that would be weaker if it were split, and is not
 *
 * "No route on this surface names another PERSON in its path" runs over the whole
 * registered surface, both sets, exactly as it did. `:requestId` names a REQUEST;
 * there is still no `:membershipId` and no subject parameter of any kind.
 *
 * ## No cluster
 *
 * `buildServer()` registers the route table without touching a database, so this
 * runs in milliseconds. The policy declaration is a static property of the
 * surface, and proving it does not need a tenant.
 */

const BASE = '/organizations/:organizationId/groups/:groupId/requests';
const VACATION_BASE = '/organizations/:organizationId/groups/:groupId/vacation/selections';
/** OPUS-M5-003's member-facing half of the same surface. */
const VACATION_ROUNDS = '/organizations/:organizationId/groups/:groupId/vacation/rounds';

/** M5-001's four. Self-scoped, and every M5-001 assertion still runs over these. */
const OWN_ROUTES = [
  { method: 'POST', url: BASE, key: 'requests.own.submit' },
  { method: 'POST', url: `${BASE}/:requestId/withdraw`, key: 'requests.own.withdraw' },
  { method: 'GET', url: `${BASE}/mine`, key: 'requests.own.read' },
  { method: 'GET', url: `${BASE}/deadline`, key: 'requests.own.read' },
  /* ── OPUS-M5-00C (FAD-58): the requester's half of §4's fifth row ───────────
   *
   * Both self-scoped, and asserted against exactly the same properties the four
   * above are — `requiresObjectPolicy: true`, `ownershipRequired: true`, no
   * override — because they are the same kind of route: a person acting on, and
   * reading, their OWN request.
   *
   * The reason-code POST additionally joins the BY-ID OWN-SCOPED WRITE set two
   * tests below, which is the M5-003 class doing what it was built to do: a new
   * member of the class meets the rule at its declaration rather than after
   * somebody notices. */
  { method: 'POST', url: `${BASE}/:requestId/reason-codes`, key: 'requests.own.comment' },
  { method: 'GET', url: `${BASE}/:requestId/comments`, key: 'requests.own.read' },
] as const;

/** M5-002's six. NOT self-scoped, deliberately — see the header. */
const SCHEDULER_ROUTES = [
  { method: 'GET', url: `${BASE}/queue`, key: 'requests.read_any' },
  { method: 'GET', url: `${BASE}/:requestId`, key: 'requests.read_any' },
  { method: 'POST', url: `${BASE}/:requestId/approve`, key: 'requests.approve' },
  { method: 'POST', url: `${BASE}/:requestId/deny`, key: 'requests.deny' },
  { method: 'POST', url: `${BASE}/:requestId/reverse`, key: 'requests.approve' },
  { method: 'POST', url: `${BASE}/decisions`, key: 'requests.batch_approve' },
  /* OPUS-M5-00C (FAD-58.2): the DECIDER's half of §4's fifth row. Shaped like
   * its six neighbours rather than like the two staff routes above — a decider
   * who could only comment on their own requests would not be a decider — and
   * carrying its OWN key, because commenting on a request is not deciding it. */
  { method: 'POST', url: `${BASE}/:requestId/comments`, key: 'requests.comment_any' },
] as const;

const EXPECTED = [...OWN_ROUTES, ...SCHEDULER_ROUTES];

/** The vacation DECISION surface — §5.4/§5.5's two routes. NOT self-scoped. */
const VACATION_DECISION_ROUTES = [
  { method: 'POST', url: `${VACATION_BASE}/:selectionId/approve`, key: 'requests.approve' },
  { method: 'POST', url: `${VACATION_BASE}/:selectionId/deny`, key: 'requests.deny' },
] as const;

/**
 * The vacation MEMBER surface — OPUS-M5-003's three. Self-scoped, exactly as
 * M5-001's four are, and asserted against the same `OWN_ROUTES` properties: the
 * §5f half of doc 08 §6's "Submit requests/**vacation**" row is the same row.
 */
const VACATION_OWN_ROUTES = [
  { method: 'GET', url: VACATION_ROUNDS, key: 'requests.own.read' },
  { method: 'GET', url: `${VACATION_ROUNDS}/:periodId`, key: 'requests.own.read' },
  {
    method: 'POST',
    url: `${VACATION_BASE}/:selectionId/withdraw`,
    key: 'requests.own.withdraw',
  },
] as const;

/**
 * The vacation COMMIT surface — OPUS-M5-004's two (SPEC-08 §5.6, FAD-59).
 *
 * Listed apart from the five above for ONE reason and it is the load-bearing
 * one: these declare **CAP-023** ("Vacation commit to schedule"), where every
 * other route on this surface declares CAP-021. Folding them into
 * `EXPECTED_VACATION` would have made the whole-surface capability assertion
 * below either wrong or weakened to "one of two", and a weakened assertion is
 * how a route acquires the wrong baseline capability quietly.
 *
 * Both are scheduler/administrative and NEITHER is self-scoped: a commit is an
 * act on the GROUP's round and a reversal an act on a week a published version
 * carries, so `requiresObjectPolicy` is false and there is no ownership
 * predicate to override. The M5-003 by-id-write ownership class therefore does
 * not take them, and the structural test that re-derives that class from the
 * route table is what checks the claim rather than this comment.
 */
const VACATION_COMMIT_ROUTES = [
  { method: 'POST', url: `${VACATION_ROUNDS}/:periodId/commit`, key: 'vacation.commit' },
  { method: 'POST', url: `${VACATION_BASE}/:selectionId/reverse`, key: 'vacation.commit' },
] as const;

const EXPECTED_VACATION = [
  ...VACATION_DECISION_ROUTES,
  ...VACATION_OWN_ROUTES,
  ...VACATION_COMMIT_ROUTES,
];

/** Which baseline capability each vacation route declares. */
function expectedCapabilityFor(url: string): 'CAP-021' | 'CAP-023' {
  return VACATION_COMMIT_ROUTES.some((route) => route.url === url) ? 'CAP-023' : 'CAP-021';
}

let app: FastifyInstance;
let routeTable: readonly RouteTableEntry[];

/** The registered entry for a method/url pair, or `undefined`. */
function entryFor(method: string, url: string): RouteTableEntry | undefined {
  return routeTable.find((entry) => entry.method === method && entry.url === url);
}

/** Every registered route on the request surface, HEAD excluded. */
function requestRoutes(): readonly RouteTableEntry[] {
  return routeTable.filter((entry) => entry.method !== 'HEAD' && entry.url.startsWith(BASE));
}

/**
 * Every registered route on the vacation surface, HEAD excluded — the decision
 * half AND the member half.
 *
 * The prefix is `/vacation` rather than `/vacation/selections`, because
 * OPUS-M5-003's round routes live under `/vacation/rounds` and a filter keyed to
 * the selections prefix would have silently excluded them from every
 * whole-surface assertion in this file — including the ownership-override one,
 * which is the assertion this file says matters most.
 */
function vacationRoutes(): readonly RouteTableEntry[] {
  return routeTable.filter(
    (entry) =>
      entry.method !== 'HEAD' &&
      entry.url.startsWith('/organizations/:organizationId/groups/:groupId/vacation'),
  );
}

beforeAll(async () => {
  ({ app, routeTable } = await buildServer());
});

afterAll(async () => {
  await app.close();
});

describe('the request surface registers exactly the thirteen routes these three packets ship', () => {
  it('each expected route is REGISTERED, with the expected action key', () => {
    for (const expected of EXPECTED) {
      const entry = entryFor(expected.method, expected.url);
      expect(entry, `${expected.method} ${expected.url} is not registered`).toBeDefined();
      const config = capabilityRouteConfig(entry?.config);
      expect(config, `${expected.method} ${expected.url} has no capability config`).toBeDefined();
      expect(config?.action.key).toBe(expected.key);
    }
  });

  it('and registers NO OTHERS — the count is still a DECISION, not a default', () => {
    /* M5-001's words for this assertion, which are unchanged in force: "an added
     * route on this surface fails here until somebody updates the list." The list
     * grew by six because doc 42 §5d landed the queue and §4's decision verbs;
     * the mechanism that made that a decision rather than a slip is this
     * assertion, and it stays.
     *
     * *(OPUS-M5-00C, 2026-08-27: ten → THIRTEEN. Doc 42 §5g landed §4's fifth
     * row under FAD-58 — two staff routes and one decider route. The mechanism
     * worked again: adding them meant editing this list, which meant deciding
     * that three routes were what the reader table needs, in the open.)* */
    const registered = requestRoutes()
      .map((entry) => `${entry.method} ${entry.url}`)
      .sort();
    expect(registered).toEqual(EXPECTED.map((expected) => `${expected.method} ${expected.url}`).sort());
  });

  it('every one declares CAP-021, group scope, and the requests_vacation module', () => {
    for (const entry of requestRoutes()) {
      const where = `${entry.method} ${entry.url}`;
      expect(entry.policy?.kind, where).toBe('capability');
      const config = capabilityRouteConfig(entry.config);
      expect(config, where).toBeDefined();
      expect(config?.policy.capability, where).toBe('CAP-021');
      expect(config?.actionScope, where).toBe('group');
      expect(config?.action.moduleKey, where).toBe('requests_vacation');
      /* And the general obligations, run over this surface specifically, so a
       * failure here names the request route rather than appearing in a
       * repo-wide list. */
      expect(routeActionProblems(entry), where).toEqual([]);
    }
  });

  it('every action key EXISTS in the catalogue with a matching scope and module', () => {
    /* The catalogue keys and the routes landed in the same change, so this is
     * the assertion that they landed CONSISTENTLY. `routeActionProblems` checks
     * it too; this states it directly so the failure message is about the key. */
    for (const expected of [...EXPECTED, ...EXPECTED_VACATION]) {
      const definition = capabilityDefinition(expected.key);
      expect(definition, `${expected.key} is not in the capability catalogue`).toBeDefined();
      expect(definition?.scope, expected.key).toBe('group');
      expect(definition?.module, expected.key).toBe('requests_vacation');
    }
  });
});

describe('SPEC-08 §4 — withdrawal is REQUESTER-INITIATED ONLY, enforced by an absence', () => {
  it('the SIX staff routes are self-scoped: ownershipRequired, object policy on', () => {
    /* M5-001's assertion, re-run over exactly the set it was written about. It is
     * scoped to `OWN_ROUTES` rather than to the whole surface because the whole
     * surface now includes routes that act on other people's rows BY DESIGN —
     * and running an averaged assertion over both sets would have meant either
     * weakening this one or misdescribing those. */
    for (const expected of [...OWN_ROUTES, ...VACATION_OWN_ROUTES]) {
      const config = capabilityRouteConfig(entryFor(expected.method, expected.url)?.config);
      const where = `${expected.method} ${expected.url}`;
      expect(config, where).toBeDefined();
      expect(config?.action.requiresObjectPolicy, `${where}: L5.1 must run`).toBe(true);
      expect(config?.action.ownershipRequired, `${where}: ownership must be required`).toBe(true);
      expect(config?.action.key, where).toBe(expected.key);
    }
  });

  it('the declaration is NECESSARY and NOT SUFFICIENT — the by-id writes self-scope as well', () => {
    /* **A finding, recorded where the declaration lives** (OPUS-M5-003).
     *
     * The assertion above is the whole of what a route DECLARATION can promise,
     * and on this surface it promises less than it appears to: SPEC-06 L5.1
     * compares a TARGET's owner to the acting membership, and every route here
     * names the ACTING MEMBERSHIP as its own target because none of them names a
     * subject in its path (the assertion four tests below). So L5.1 passes by
     * construction and cannot decide whose row a by-id write touches. Migration
     * 0023's `_own` policy does not decide it either: `_group_administration` is
     * `FOR ALL` behind `requests.administer`, which is the design — "RLS decides
     * which ROWS, never which OPERATIONS".
     *
     * The control is therefore an operation-layer predicate on the VERIFIED
     * context's membership, and the routes that need one are exactly the
     * own-scoped WRITES that address a row BY ID. This test names that set, so a
     * future route joining it meets the rule here; the BEHAVIOUR is proven over
     * HTTP in `test/requests/own-write-ownership.test.ts`, both directions.
     *
     * Reads are deliberately not in the set: a member's read is row-scoped by
     * RLS, and a scheduler reading a colleague's row rides `requests.read_any`,
     * which is a granted power rather than an accident. */
    const byIdOwnWrites = [
      { method: 'POST', url: `${BASE}/:requestId/withdraw` },
      { method: 'POST', url: `${VACATION_BASE}/:selectionId/withdraw` },
      /* OPUS-M5-00C: the class's THIRD member, and it arrived through this
       * assertion rather than past it. `attachReasonCode` carries the predicate
       * (`root.membershipId !== command.membershipId → not-found`);
       * `test/requests/request-comments.test.ts` proves it over HTTP in both
       * directions, with the owner's own success as the positive control beside
       * the colleague's 404.
       *
       * **On this route the predicate is A control and not THE control**, and
       * the distinction was established at review by mutation rather than by
       * reading: migration 0026's `request_comments_own` arm asks the same
       * ownership question in its `WITH CHECK`, so dropping the service
       * predicate alone leaves the forged write refused by the database with
       * `42501`, which `withRequests` maps to the IDENTICAL `404`. Both layers
       * had to go before the property broke. That is DEFENCE IN DEPTH and it
       * does not weaken this set's rule — the rule is that every member carries
       * the service predicate, because on the other two members
       * (`…/requests/:requestId/withdraw`, `…/vacation/selections/:selectionId/
       * withdraw`) the database does NOT re-ask ownership for the actor who
       * matters. *(Corrected 2026-08-27 at the second condition round: an
       * earlier version of this sentence said those tables' OWN-arms are
       * `FOR ALL` and therefore do not re-ask it. That is false, and reading
       * 0023 is what settles it — `requests_own` (line 632) and
       * `vacation_selections_own` (line 845) are `FOR ALL` and DO re-ask, with
       * `membership_id = nullif(current_setting('app.membership_id', true),
       * '')::uuid` in BOTH `USING` and `WITH CHECK`.)* The real mechanism is the
       * ADMINISTRATION arms: `requests_group_administration` (line 650) and
       * `vacation_selections_group_administration` (line 863) are `FOR ALL`
       * behind `app_acting_membership_holds('requests.administer')` with **no
       * ownership predicate at all**, and permissive RLS policies combine with
       * OR — so for a holder of `requests.administer` that arm alone admits the
       * write and the own-arm's ownership question is never reached. On those
       * two routes the service predicate is therefore the only control, which is
       * exactly the composition gap M5-003 found by measurement.
       * `request_comments` differs because ITS administration arm additionally
       * pins `channel = 'scheduler'` (and the author), so the OR-escape is shut:
       * a forged requester-channel row satisfies neither arm and the database
       * refuses it. A future member may have no second layer at all, which is
       * exactly why the declaration-time rule stays unconditional. */
      { method: 'POST', url: `${BASE}/:requestId/reason-codes` },
    ] as const;

    for (const route of byIdOwnWrites) {
      const entry = entryFor(route.method, route.url);
      expect(entry, `${route.method} ${route.url} must be registered`).toBeDefined();
      const config = capabilityRouteConfig(entry?.config);
      expect(config?.action.ownershipRequired).toBe(true);
      expect(config?.action.ownershipOverrideCapability).toBeUndefined();
    }

    /* Non-vacuity, and the sweep's own closing condition: this set is exactly the
     * own-scoped routes that write and take an id. If a new one appears with
     * neither, the count below moves and this test says so. */
    /* Every verb that WRITES, not only POST (condition C-4). A `PUT …/:id` or a
     * `DELETE …/:id` on a self-scoped surface would be the same defect wearing a
     * different method, and a POST-only filter would have let it through this
     * sweep silently — which is the failure mode the sweep exists to close. */
    const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    const ownScopedWrites = [...requestRoutes(), ...vacationRoutes()].filter((entry) => {
      const config = capabilityRouteConfig(entry.config);
      return (
        WRITE_METHODS.has(entry.method) &&
        config?.action.ownershipRequired === true &&
        entry.url.split('/').some((segment) => segment.startsWith(':') &&
          segment !== ':organizationId' && segment !== ':groupId')
      );
    });
    expect(
      ownScopedWrites.map((entry) => `${entry.method} ${entry.url}`).sort(),
      'the by-id own-scoped write set has changed — every member needs the service predicate',
    ).toEqual(byIdOwnWrites.map((route) => `${route.method} ${route.url}`).sort());
  });

  it('NO route on this surface carries an ownership OVERRIDE — the §4 ruling', () => {
    /* **This is the assertion that matters most in this file**, and it is NOT
     * narrowed to the staff set. An `ownershipOverrideCapability` on the
     * withdrawal route would make "withdraw somebody else's request" a power that
     * exists, which §4 says it is not: an administrator ending a request does it
     * by DENYING with a reason — which is now a real route, under
     * `requests.deny`, three tests below.
     *
     * On a route that does not require ownership an override is meaningless, so
     * asserting the absence across the WHOLE surface costs nothing and stops the
     * rule from being quietly re-scoped by a later split. */
    for (const entry of [...requestRoutes(), ...vacationRoutes()]) {
      const config = capabilityRouteConfig(entry.config);
      expect(
        config?.action.ownershipOverrideCapability,
        `${entry.method} ${entry.url} must NOT lift its ownership requirement`,
      ).toBeUndefined();
    }
  });

  it('the DENIAL route exists, and it is the only administrative way to end a request', () => {
    /* §4's other half, now assertable because the route exists: an administrator
     * ends somebody else's request through `requests.deny`, and through nothing
     * else. The withdrawal route cannot reach another member's row (the assertion
     * above), and no route on this surface other than deny and reverse moves a
     * request to a terminal state on somebody's behalf. */
    const deny = entryFor('POST', `${BASE}/:requestId/deny`);
    expect(deny, 'the denial route must exist for §4 to be satisfiable').toBeDefined();
    expect(capabilityRouteConfig(deny?.config)?.action.key).toBe('requests.deny');
    expect(capabilityRouteConfig(deny?.config)?.action.ownershipRequired).toBeUndefined();
  });

  it('no route on this surface names another PERSON in its path', () => {
    /* The structural half, asserted over the REGISTERED table rather than over a
     * list: there is no `:membershipId`, no `:userId` and no subject parameter of
     * any kind, so there is no request that could act on somebody else's
     * behalf even if a policy declaration were disarmed. The path parameters
     * beyond the tenant pair are `:requestId`, which names a REQUEST, and
     * `:selectionId`, which names a vacation SELECTION — and the narrowed RLS
     * policies make another member's row invisible without the read or
     * administration key, so either resolves to a 404 rather than to somebody
     * else's row.
     *
     * Unchanged from M5-001 except for the added parameter, which is a SELECTION
     * and not a person. */
    const tenantParameters = new Set([
      ':organizationId',
      ':groupId',
      ':requestId',
      ':selectionId',
      /* OPUS-M5-003. `:periodId` names a vacation ROUND — a bounded date range
       * with a mode and a state — and is no more a person than the two above. */
      ':periodId',
    ]);
    for (const entry of [...requestRoutes(), ...vacationRoutes()]) {
      const parameters = entry.url.split('/').filter((segment) => segment.startsWith(':'));
      for (const parameter of parameters) {
        expect(
          tenantParameters.has(parameter),
          `${entry.method} ${entry.url} names ${parameter} — a subject parameter on a self-scoped surface`,
        ).toBe(true);
      }
    }
  });
});

describe('OPUS-M5-002 — the scheduler half, and the §5c binding note at the route layer', () => {
  it('the seven scheduler routes declare no ownership, and say so explicitly', () => {
    for (const expected of [...SCHEDULER_ROUTES, ...VACATION_DECISION_ROUTES]) {
      const config = capabilityRouteConfig(entryFor(expected.method, expected.url)?.config);
      const where = `${expected.method} ${expected.url}`;
      expect(config, where).toBeDefined();
      /* `false`, not absent: a route that acts on other people's rows must SAY
       * that L5.1 does not apply, rather than leaving a reader to infer it. */
      expect(config?.action.requiresObjectPolicy, `${where}: L5.1 is off by design`).toBe(false);
      expect(config?.action.ownershipRequired, `${where}`).toBeUndefined();
    }
  });

  it('EVERY route that can write `approved` declares a DECISION key', () => {
    /* **The structural half of the §5c binding note.** 0023's `requests_own` is
     * `FOR ALL` with `status` in the column grant, so at the SQL layer a member's
     * own row can walk every §2 edge; what makes `approved` unreachable except
     * through a decision path is that every route capable of writing it declares
     * `requests.approve` or `requests.deny`.
     *
     * Each of the five write routes is looked up in the REGISTERED table and
     * required to declare one of the two keys.
     *
     * **What this assertion does NOT do, corrected rather than left flattering:**
     * it iterates a hard-coded list, so a SEVENTH route added to this surface
     * with a read key and a decision body would not be caught here — this loop
     * would never look at it. The assertion that protects the surface against
     * that is the exact-count one in the last describe block ("and the surface is
     * NON-EMPTY, so the assertions above are not vacuous",
     * `requestRoutes().length` equals `EXPECTED.length`), which fails the moment
     * an unlisted route is registered. The two are complementary: the count
     * assertion notices a NEW route, this one notices a listed route losing its
     * key. Neither subsumes the other, and an earlier version of this comment
     * credited this loop with the count assertion's work.
     *
     * The behavioural half is `test/requests/decision-authority.test.ts`, which
     * drives each of them as a member and checks the refusal comes from the
     * authorization layer. */
    const DECISION_KEYS = new Set(['requests.approve', 'requests.deny']);
    const writeRoutes = [
      `POST ${BASE}/:requestId/approve`,
      `POST ${BASE}/:requestId/deny`,
      `POST ${BASE}/:requestId/reverse`,
      `POST ${VACATION_BASE}/:selectionId/approve`,
      `POST ${VACATION_BASE}/:selectionId/deny`,
    ];
    for (const where of writeRoutes) {
      const [method, url] = where.split(' ') as [string, string];
      const config = capabilityRouteConfig(entryFor(method, url)?.config);
      expect(config, `${where} is not registered`).toBeDefined();
      expect(
        DECISION_KEYS.has(config?.action.key ?? ''),
        `${where} writes a decision and must declare one`,
      ).toBe(true);
    }

    /* The batch is the ONE decision route that declares something else, and the
     * exception is deliberate and load-bearing: doc 08 §6 makes batching an
     * ADDITIONAL grant, so the route declares `requests.batch_approve` and its
     * handler re-evaluates the per-item decision key in the same transaction. If
     * that second evaluation were removed, the batch grant alone would decide —
     * which is why this assertion names the route rather than exempting it
     * silently. `test/requests/decision-authority.test.ts` drives the case. */
    const batch = capabilityRouteConfig(entryFor('POST', `${BASE}/decisions`)?.config);
    expect(batch?.action.key).toBe('requests.batch_approve');
  });

  it('the READ keys carry no write power: the queue and the detail are GET only', () => {
    /* `requests.read_any` is a READ key, so a scheduler who must see the queue
     * does not thereby gain the ability to decide anything. Asserted structurally:
     * every route declaring it is a GET. */
    for (const entry of requestRoutes()) {
      const config = capabilityRouteConfig(entry.config);
      if (config?.action.key === 'requests.read_any') {
        expect(entry.method, `${entry.method} ${entry.url} holds a READ key`).toBe('GET');
      }
    }
  });

  it('the vacation surface registers exactly SEVEN routes: two decisions, three member, two commit', () => {
    const registered = vacationRoutes()
      .map((entry) => `${entry.method} ${entry.url}`)
      .sort();
    expect(registered).toEqual(
      EXPECTED_VACATION.map((expected) => `${expected.method} ${expected.url}`).sort(),
    );
    for (const expected of EXPECTED_VACATION) {
      const config = capabilityRouteConfig(entryFor(expected.method, expected.url)?.config);
      expect(config?.action.key, `${expected.method} ${expected.url}`).toBe(expected.key);
      expect(config?.policy.capability, `${expected.method} ${expected.url}`).toBe(
        expectedCapabilityFor(expected.url),
      );
      expect(config?.actionScope).toBe('group');
    }
  });
});

describe('I-02 — deny-by-default holds over this surface', () => {
  it('no route on this surface is public, internal, or pre-auth', () => {
    /* A request surface reachable without a tenant would be a request surface
     * whose rows RLS cannot scope. Every one is a capability route, and the three
     * other policy kinds are asserted absent rather than assumed absent. */
    for (const entry of [...requestRoutes(), ...vacationRoutes()]) {
      expect(entry.policy?.kind, `${entry.method} ${entry.url}`).toBe('capability');
    }
  });

  it('and the surface is NON-EMPTY, so the assertions above are not vacuous', () => {
    expect(requestRoutes().length).toBe(EXPECTED.length);
    expect(requestRoutes().length).toBeGreaterThan(0);
    expect(vacationRoutes().length).toBe(EXPECTED_VACATION.length);
  });
});
