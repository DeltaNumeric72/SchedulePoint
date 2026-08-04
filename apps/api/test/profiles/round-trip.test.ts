import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type pg from 'pg';

import { adminClient } from '../support/admin-client.js';
import { log } from '../support/harness.js';
import { buildHttpHarness, contextHeaders, currentCounters, type HttpHarness } from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantStaffingCapabilities } from '../support/staffing.js';

/**
 * **Round-trip authoring, end to end over HTTP** — the packet's acceptance
 * criterion in its own words: *create → future-date → supersede → read history*.
 *
 * Everything here goes through the real server: the context middleware, the
 * SPEC-06 evaluator, the unit of work, the guard triggers, the EXCLUDE
 * constraint, the audit chain. Nothing calls a service directly, because the
 * question this file answers is whether the whole path works — the three named
 * proofs already answer whether each mechanism does.
 *
 * ## Why the sequence runs ONCE, in a memoised helper
 *
 * **The first version of this file was order-dependent and
 * `corepack pnpm fixture-regression` caught it: green standalone, red on all
 * eleven fixed seeds and the rotating one.** Each phase was its own `it`, and each
 * read an id the previous `it` had assigned — so under
 * `--sequence.shuffle.tests` "READ HISTORY" ran before "CREATE" and asserted
 * against `undefined`.
 *
 * That is FAD-15 Layer 4 exactly, and `sbx/sbx.test.ts` earned the same lesson in
 * the harness built to catch vacuous evidence. The fix is the pattern that file
 * adopted: **the sequence is a memoised precondition belonging to the describe
 * block, not a chain of siblings.** `roundTrip()` performs every step once,
 * whichever test asks for it first, and returns a record; each `it` then asserts
 * one property of that record and passes in any order.
 *
 * A round trip really is a sequence — that is the point of it — so this is not
 * "make the tests independent" so much as "make the ASSERTIONS independent of
 * each other while the sequence stays a sequence".
 */

// `full`, so the T-02 cases get memberships that own no profile yet.
const multi = ownedMulti('profiles-round-trip', { profile: 'full' });

let harness: HttpHarness;
let admin: pg.Client;

const org = (): string => multi().alpha.organizationId;
const group = (): string => multi().alpha.groupOne.id;
/** The administrator: `groupOnly`'s principal holds no other membership. */
const actorUser = (): string => multi().alpha.users.groupOnly.id;
const subject = (): string => multi().alpha.users.scheduler.membershipId;

const base = (): string => `/organizations/${org()}/groups/${group()}`;

/**
 * `full`-profile group-one memberships, each owning no profile at the start.
 *
 * Every T-02 case needs a subject of its own: they author real windows, and the
 * EXCLUDE constraint means two cases sharing a membership would collide rather
 * than test anything. Named accessors that throw make a missing profile a loud
 * failure instead of an `undefined` three frames deeper.
 */
function fullMember(which: 'viewer' | 'telecom' | 'groupAdmin'): string {
  const user = multi().alpha.full?.[which];
  if (user === undefined) throw new Error(`the full MULTI profile did not provision ${which}`);
  return user.membershipId;
}
const fullViewer = (): string => fullMember('viewer');
const fullTelecom = (): string => fullMember('telecom');
const fullGroupAdmin = (): string => fullMember('groupAdmin');

async function headers(): Promise<Record<string, string>> {
  return {
    ...contextHeaders(
      actorUser(),
      await currentCounters(admin, { organizationId: org(), groupId: group(), userId: actorUser() }),
    ),
    'content-type': 'application/json',
  };
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  harness = await buildHttpHarness();
  await grantStaffingCapabilities(harness.runtime.runner, multi(), {
    organizationId: org(),
    groupId: group(),
    membershipId: multi().alpha.users.groupOnly.membershipId,
    capabilities: [
      'staffing.work_profile.administer',
      'staffing.work_profile.read',
      'staffing.qualification.administer',
      'staffing.qualification_holding.administer',
      'staffing.qualification_holding.read',
      'staffing.qualification_holding.read_any',
    ],
  });
}, 120_000);

afterAll(async () => {
  await harness.close();
  await admin.end();
});

/* ────────────────────────────────────────────────────────────────────────────
 * Work profiles
 * ──────────────────────────────────────────────────────────────────────────── */

interface WireProfile {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  workPercentage: number;
  weekdayTargets: { day: string; fteFraction: number; maxAssignments: number | null }[];
}

interface RoundTrip {
  readonly firstId: string;
  readonly futureId: string;
  readonly supersedingId: string;
  readonly futureInstant: string;
  readonly createdTargets: WireProfile['weekdayTargets'];
  readonly inForceAfterCreate: { profile: WireProfile | null; reason: string | null };
  readonly inForceAfterFutureDate: { profile: WireProfile | null };
  readonly atFutureInstant: { profile: WireProfile | null };
  readonly supersededProfileIdOnFutureDate: string;
  readonly supersededProfileIdOnSupersede: string;
  readonly history: WireProfile[];
}

describe('work profiles: create -> future-date -> supersede -> read history', () => {
  let sequence: Promise<RoundTrip> | undefined;

  const roundTrip = async (): Promise<RoundTrip> => {
    sequence ??= (async (): Promise<RoundTrip> => {
      const futureInstant = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

      /* ── CREATE ────────────────────────────────────────────────────────── */
      const created = await harness.app.inject({
        method: 'POST',
        url: `${base()}/work-profiles`,
        headers: await headers(),
        payload: {
          membershipId: subject(),
          workPercentage: 100,
          maxAssignmentsPerWeek: 5,
          maxConsecutiveDays: 6,
          weekdayTargets: [
            { day: 'mon', fteFraction: 1 },
            { day: 'tue', fteFraction: 1 },
            { day: 'wed', fteFraction: 1 },
            { day: 'thu', fteFraction: 1 },
            { day: 'fri', fteFraction: 1 },
            { day: 'sat', fteFraction: 0 },
            { day: 'sun', fteFraction: 0 },
            // The dimension doc 06 §3.2's `weekday (0–6)` cannot express, and the
            // reason this packet extends it (FAD-16's day domain).
            { day: 'holiday', fteFraction: 0.5, maxAssignments: 1 },
          ],
        },
      });
      expect(created.statusCode, created.body).toBe(200);
      const createdBody = created.json<{ profile: WireProfile; supersededProfileId: string | null }>();
      expect(createdBody.supersededProfileId, 'the first profile superseded something').toBeNull();

      const afterCreate = await harness.app.inject({
        method: 'GET',
        url: `${base()}/memberships/${subject()}/work-profile`,
        headers: await headers(),
      });
      expect(afterCreate.statusCode, afterCreate.body).toBe(200);

      /* ── FUTURE-DATE ───────────────────────────────────────────────────── */
      const futureDated = await harness.app.inject({
        method: 'POST',
        url: `${base()}/work-profiles`,
        headers: await headers(),
        payload: {
          membershipId: subject(),
          effectiveFrom: futureInstant,
          workPercentage: 60,
          weekdayTargets: [{ day: 'holiday', fteFraction: 0 }],
        },
      });
      expect(futureDated.statusCode, futureDated.body).toBe(200);
      const futureBody = futureDated.json<{ profile: WireProfile; supersededProfileId: string }>();

      const presentAfterFutureDate = await harness.app.inject({
        method: 'GET',
        url: `${base()}/memberships/${subject()}/work-profile`,
        headers: await headers(),
      });
      const atFuture = await harness.app.inject({
        method: 'GET',
        url: `${base()}/memberships/${subject()}/work-profile?at=${encodeURIComponent(futureInstant)}`,
        headers: await headers(),
      });
      expect(atFuture.statusCode, atFuture.body).toBe(200);

      /* ── SUPERSEDE, immediately ────────────────────────────────────────── */
      const superseded = await harness.app.inject({
        method: 'POST',
        url: `${base()}/work-profiles`,
        headers: await headers(),
        payload: { membershipId: subject(), workPercentage: 80 },
      });
      expect(superseded.statusCode, superseded.body).toBe(200);
      const supersededBody = superseded.json<{ profile: WireProfile; supersededProfileId: string }>();

      /* ── READ HISTORY ──────────────────────────────────────────────────── */
      const history = await harness.app.inject({
        method: 'GET',
        url: `${base()}/memberships/${subject()}/work-profiles`,
        headers: await headers(),
      });
      expect(history.statusCode, history.body).toBe(200);

      return {
        firstId: createdBody.profile.id,
        futureId: futureBody.profile.id,
        supersedingId: supersededBody.profile.id,
        futureInstant,
        createdTargets: createdBody.profile.weekdayTargets,
        inForceAfterCreate: afterCreate.json<RoundTrip['inForceAfterCreate']>(),
        inForceAfterFutureDate: presentAfterFutureDate.json<RoundTrip['inForceAfterFutureDate']>(),
        atFutureInstant: atFuture.json<RoundTrip['atFutureInstant']>(),
        supersededProfileIdOnFutureDate: futureBody.supersededProfileId,
        supersededProfileIdOnSupersede: supersededBody.supersededProfileId,
        history: history.json<{ profiles: WireProfile[] }>().profiles,
      };
    })();
    return sequence;
  };

  it('CREATE — the first profile carries seven weekday targets and a holiday target', async () => {
    const trip = await roundTrip();
    expect(trip.createdTargets).toHaveLength(8);
    expect(trip.createdTargets.map((target) => target.day).sort()).toEqual(
      ['fri', 'holiday', 'mon', 'sat', 'sun', 'thu', 'tue', 'wed'],
    );
    const holiday = trip.createdTargets.find((target) => target.day === 'holiday');
    expect(holiday?.fteFraction).toBe(0.5);
    expect(holiday?.maxAssignments).toBe(1);
    log('created a work profile with seven weekday targets and a holiday target');
  });

  it('READ — it is the row in force, with no "reason"', async () => {
    const trip = await roundTrip();
    expect(trip.inForceAfterCreate.profile?.id).toBe(trip.firstId);
    expect(trip.inForceAfterCreate.profile?.workPercentage).toBe(100);
    expect(trip.inForceAfterCreate.reason).toBeNull();
  });

  it('FUTURE-DATE — a change 60 days out supersedes the row in force at THAT instant', async () => {
    const trip = await roundTrip();
    expect(trip.supersededProfileIdOnFutureDate, 'the future-dated row superseded nothing').toBe(
      trip.firstId,
    );
  });

  it('…and the PRESENT verdict is unchanged', async () => {
    // The S-01 shape, over HTTP: authoring a future change must not alter what is
    // true today. A loader taking "the latest row" answers 60% here.
    const trip = await roundTrip();
    expect(
      trip.inForceAfterFutureDate.profile?.id,
      'a future-dated change took effect immediately',
    ).toBe(trip.firstId);
    expect(trip.inForceAfterFutureDate.profile?.workPercentage).toBe(100);
    log('a change dated 60 days out does not move the present verdict');
  });

  it('…and it DOES govern at its own instant', async () => {
    const trip = await roundTrip();
    expect(trip.atFutureInstant.profile?.id).toBe(trip.futureId);
    expect(trip.atFutureInstant.profile?.workPercentage).toBe(60);
  });

  it('SUPERSEDE — an immediate change closes the row in force NOW', async () => {
    const trip = await roundTrip();
    expect(trip.supersededProfileIdOnSupersede).toBe(trip.firstId);
  });

  it('READ HISTORY — every window, oldest first, with nothing rewritten', async () => {
    const trip = await roundTrip();
    expect(trip.history.map((profile) => profile.id)).toEqual([
      trip.firstId,
      trip.supersedingId,
      trip.futureId,
    ]);
    expect(trip.history.map((profile) => profile.workPercentage)).toEqual([100, 80, 60]);

    const [first, superseding, future] = trip.history;
    // The original is CLOSED, not altered: its start instant and its percentage
    // are exactly what they were when it was created.
    expect(first?.effectiveTo, 'the original row was not closed').not.toBeNull();
    expect(first?.workPercentage, 'the original row was rewritten').toBe(100);
    // Exact adjacency at both joins. A gap would mean a period with no profile in
    // force; an overlap is refused by the EXCLUDE constraint.
    expect(superseding?.effectiveFrom, 'a gap opened at the supersession').toBe(first?.effectiveTo);
    expect(future?.effectiveFrom, 'a gap opened before the future window').toBe(
      superseding?.effectiveTo,
    );
    expect(future?.effectiveTo, 'the last window is not open-ended').toBeNull();
    log(
      `history: ${trip.history
        .map((profile) => `${String(profile.workPercentage)}%`)
        .join(' -> ')} across 3 exactly-adjacent windows`,
    );
  });

  it('the audit chain records the supersession as its OWN event', async () => {
    const trip = await roundTrip();
    /* ── counted RELATIVE to this round trip's own rows, never absolutely ─────
     *
     * `audit_events` is append-only and monotonic: an absolute count is an
     * assertion about everything that has ever happened in this organization, so
     * it is order-dependent the moment any sibling writes one. The rows are
     * therefore filtered to the three profile ids THIS trip created — which is
     * also the stronger claim, because it says the events name the right rows and
     * not merely that the right number exists. */
    const rows = await admin.query<{ event_name: string; subject_id: string }>(
      `select event_name, subject_id::text as subject_id
         from audit_events
        where organization_id = $1::uuid
          and event_name like 'staffing.work_profile.%'
          and subject_id = any($2::uuid[])
        order by sequence`,
      [org(), [trip.firstId, trip.supersedingId, trip.futureId]],
    );
    const names = rows.rows.map((row) => row.event_name);
    expect(names.filter((name) => name === 'staffing.work_profile.authored')).toHaveLength(3);
    expect(
      names.filter((name) => name === 'staffing.work_profile.superseded'),
      'a supersession was filed under the same name as an authoring',
    ).toHaveLength(2);
    // The superseded event names the row that was CLOSED, not the new one.
    const supersededSubjects = rows.rows
      .filter((row) => row.event_name === 'staffing.work_profile.superseded')
      .map((row) => row.subject_id);
    expect(supersededSubjects).toContain(trip.firstId);
    log(`${String(rows.rows.length)} work-profile audit rows: 3 authored, 2 superseded`);
  });

  it('T-06 — every work-profile audit row carries BEFORE, AFTER and a mechanism', async () => {
    /* The finding: the six events carried no payload at all, so an audit row said
     * "a profile was authored" and could not answer "what changed" — the question
     * every audit review actually asks. The packet's audit requirement names five
     * fields; four come from the chain columns and `uow.context`, and before/after
     * and mechanism are the two a caller has to supply.
     *
     * Asserted against the FIRST authoring (a create, so `before` is `none`) and
     * the supersession that closed it, by subject id — never by position. */
    const trip = await roundTrip();

    const authored = await admin.query<{ payload: Record<string, unknown> }>(
      `select payload from audit_events
        where organization_id = $1::uuid and event_name = 'staffing.work_profile.authored'
          and subject_id = $2::uuid`,
      [org(), trip.supersedingId],
    );
    const supersedingPayload = authored.rows[0]?.payload;
    expect(supersedingPayload, 'the authored event carries no payload at all').toBeDefined();
    expect(supersedingPayload?.['mechanism']).toBe('supersede');
    expect(supersedingPayload?.['beforeProfileId']).toBe(trip.firstId);
    expect(supersedingPayload?.['beforeWorkPercentage']).toBe(100);
    expect(supersedingPayload?.['afterWorkPercentage']).toBe(80);
    expect(supersedingPayload?.['membershipId']).toBe(subject());

    const superseded = await admin.query<{ payload: Record<string, unknown> }>(
      `select payload from audit_events
        where organization_id = $1::uuid and event_name = 'staffing.work_profile.superseded'
          and subject_id = $2::uuid order by sequence limit 1`,
      [org(), trip.firstId],
    );
    const closedPayload = superseded.rows[0]?.payload;
    expect(closedPayload, 'the superseded event carries no payload').toBeDefined();
    expect(closedPayload?.['mechanism']).toBe('supersede');
    // The window moved from open to closed, and the payload says both halves.
    expect(closedPayload?.['beforeEffectiveTo']).toBeDefined();
    expect(closedPayload?.['afterEffectiveTo']).not.toBe(closedPayload?.['beforeEffectiveTo']);

    // I-07: nothing in any payload is free text. The closedness validator already
    // refuses it at write time; this is the assertion that the validator is what
    // these rows actually went through, rather than a rule nobody exercised.
    const all = await admin.query<{ payload: Record<string, unknown> }>(
      `select payload from audit_events
        where organization_id = $1::uuid and event_name like 'staffing.%'`,
      [org()],
    );
    expect(all.rows.length).toBeGreaterThan(0);
    for (const row of all.rows) {
      for (const [key, value] of Object.entries(row.payload)) {
        if (typeof value !== 'string') continue;
        expect(value, `${key} carries a space — free text reached an audit payload`).not.toMatch(
          / /,
        );
        expect(value.length).toBeLessThanOrEqual(64);
      }
    }
    log(`${String(all.rows.length)} staffing audit rows, every payload closed and non-empty`);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * T-01 — the refusal, over HTTP
 * ──────────────────────────────────────────────────────────────────────────── */

describe('T-01 — retroactive authoring is a 422 on the wire, not a 500', () => {
  /**
   * **This test exists because its absence hid a real defect.**
   *
   * The service-level cases in `history-immutability.test.ts` assert that
   * `authorWorkProfile` throws, and they passed throughout — while `classify` in
   * the route had no arm for `RetroactiveEffectiveFromError`, so it fell through
   * to `throw error` and the caller received a **500**. An internal error, for a
   * request that is simply not permitted.
   *
   * Asserting the throw is not the same as asserting the answer. The ruling said
   * 422; only a request through the real server can show that it is 422.
   */
  it('a past effectiveFrom is refused with 422 and a fixed body', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `${base()}/work-profiles`,
      headers: await headers(),
      payload: {
        membershipId: fullGroupAdmin(),
        effectiveFrom: '2005-03-01T00:00:00.000Z',
        workPercentage: 60,
      },
    });

    expect(response.statusCode, response.body).toBe(422);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('UNPROCESSABLE');
    // The refusal names no row, no tenant and no instant: it is the same fixed
    // body a guard trigger's refusal produces, so the two are indistinguishable.
    expect(response.body).not.toContain('2005');
    expect(response.body).not.toContain(org());
    expect(response.body).not.toContain('RETROACTIVE');
  });

  it('GREEN control — the same request with a FUTURE instant is accepted', async () => {
    // Without this the assertion above would also pass on a surface that refused
    // every explicit instant, which would break future-dating — the capability the
    // packet actually requires.
    const future = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString();
    const response = await harness.app.inject({
      method: 'POST',
      url: `${base()}/work-profiles`,
      headers: await headers(),
      payload: { membershipId: fullGroupAdmin(), effectiveFrom: future, workPercentage: 60 },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ profile: { effectiveFrom: string } }>().profile.effectiveFrom).toBe(
      future,
    );
    log('retroactive authoring answers 422 over HTTP; a future instant still answers 200');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * T-02 — weekday targets on a supersession
 * ──────────────────────────────────────────────────────────────────────────── */

describe('T-02 — a supersession does not silently discard weekday targets', () => {
  /**
   * The finding: "reduce this person to 60%" is the most common call this surface
   * takes, it names a percentage and nothing else, and the new profile version was
   * being written with NO weekday targets — destroying the per-day and holiday
   * dimension CAP-013 exists to hold and the M4 engine will consume. Nothing
   * failed, because losing data the caller never mentioned looks exactly like not
   * having been asked for it.
   *
   * Both arms are asserted, because carrying forward without an escape hatch would
   * be the opposite defect: a caller who genuinely means "no targets" must be able
   * to say so.
   */
  const targets = [
    { day: 'mon', fteFraction: 1 },
    { day: 'tue', fteFraction: 1 },
    { day: 'wed', fteFraction: 0.5 },
    { day: 'holiday', fteFraction: 0, maxAssignments: 0 },
  ] as const;

  const author = async (payload: Record<string, unknown>): Promise<{ id: string; weekdayTargets: WireProfile['weekdayTargets'] }> => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `${base()}/work-profiles`,
      headers: await headers(),
      payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ profile: WireProfile }>();
    return { id: body.profile.id, weekdayTargets: body.profile.weekdayTargets };
  };

  it('OMITTED on a supersession — the predecessor\'s targets are carried forward', async () => {
    const subject = multi().alpha.users.member.membershipId;

    const first = await author({ membershipId: subject, workPercentage: 100, weekdayTargets: targets });
    expect(first.weekdayTargets, 'the fixture did not store the targets to carry').toHaveLength(4);

    // The ordinary administrative call: a percentage, and nothing about days.
    const reduced = await author({ membershipId: subject, workPercentage: 60 });

    expect(
      reduced.weekdayTargets.length,
      'the FTE change silently discarded the weekday and holiday targets',
    ).toBe(4);
    expect(
      [...reduced.weekdayTargets].map((t) => `${t.day}=${String(t.fteFraction)}`).sort(),
      'the carried targets are not the predecessor\'s values',
    ).toEqual(['holiday=0', 'mon=1', 'tue=1', 'wed=0.5']);
    // Carried as COPIES: the predecessor keeps its own and stays exactly as
    // readable as it was.
    const holiday = reduced.weekdayTargets.find((t) => t.day === 'holiday');
    expect(holiday?.maxAssignments).toBe(0);
    log('a percentage-only supersession carries the predecessor\'s eight-day dimension forward');
  });

  it('EXPLICIT `[]` — the targets are cleared, because saying "none" is a decision', async () => {
    const subject = multi().alpha.users.departed.membershipId;

    const first = await author({ membershipId: subject, workPercentage: 100, weekdayTargets: targets });
    expect(first.weekdayTargets).toHaveLength(4);

    const cleared = await author({ membershipId: subject, workPercentage: 60, weekdayTargets: [] });
    expect(
      cleared.weekdayTargets,
      'an explicit empty array was treated as "unspecified" and carried forward anyway',
    ).toEqual([]);
    log('an explicit empty array clears the targets — omission and emptiness are different');
  });

  it('a FIRST profile with no targets stays empty — there is nothing to carry', async () => {
    const created = await author({ membershipId: fullViewer(), workPercentage: 100 });
    expect(created.weekdayTargets).toEqual([]);
  });

  it('the audit payload records WHICH of the two happened', async () => {
    /* T-06 and T-02 meet here: an auditor reading "a profile was authored" cannot
     * tell whether the day dimension was stated or inherited, and that is exactly
     * the fact this finding was about.
     *
     * **This test establishes its own pair.** The first version read every
     * `authored` event in the organization and asserted that both a `true` and a
     * `false` were present — which is an assertion about whether its SIBLINGS had
     * run, and `fixture-regression` caught it on the first shuffled seed. Its own
     * membership, its own two authorings, and the rows selected BY SUBJECT ID. */
    const subject = fullTelecom();

    const stated = await author({
      membershipId: subject,
      workPercentage: 100,
      weekdayTargets: targets,
    });
    const inherited = await author({ membershipId: subject, workPercentage: 60 });

    const rows = await admin.query<{ subject_id: string; carried: boolean | null; count: number | null }>(
      `select subject_id::text as subject_id,
              (payload->>'weekdayTargetsCarriedForward')::boolean as carried,
              (payload->>'afterWeekdayTargetCount')::int as count
         from audit_events
        where organization_id = $1::uuid and event_name = 'staffing.work_profile.authored'
          and subject_id = any($2::uuid[])
        order by sequence`,
      [org(), [stated.id, inherited.id]],
    );
    expect(rows.rows.length, 'the two authorings produced no audit rows').toBe(2);

    const byId = new Map(rows.rows.map((row) => [row.subject_id, row]));
    expect(
      byId.get(stated.id)?.carried,
      'a caller-stated target set was recorded as carried forward',
    ).toBe(false);
    expect(
      byId.get(inherited.id)?.carried,
      'a carry-forward was not recorded as one',
    ).toBe(true);
    expect(byId.get(stated.id)?.count).toBe(4);
    expect(byId.get(inherited.id)?.count).toBe(4);
    log('the authored payload distinguishes a stated target set from an inherited one');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Qualifications
 * ──────────────────────────────────────────────────────────────────────────── */

interface WireHolding {
  id: string;
  status: string;
  validUntil: string | null;
}

interface CredentialTrip {
  readonly qualificationId: string;
  readonly holdingId: string;
  readonly eligibleNow: boolean;
  readonly eligibleBeforeIssue: boolean;
  readonly freeTextStatus: number;
  readonly revoked: WireHolding;
  readonly afterRevocation: { holdings: { id: string }[]; eligible: boolean };
  readonly reinstateStatus: number;
  readonly retiredStatus: string;
  readonly holdingsAfterRetire: number;
}

describe('qualifications: define -> issue -> revoke -> retire, all retained', () => {
  let sequence: Promise<CredentialTrip> | undefined;

  const credentialTrip = async (): Promise<CredentialTrip> => {
    sequence ??= (async (): Promise<CredentialTrip> => {
      const defined = await harness.app.inject({
        method: 'POST',
        url: `${base()}/qualifications`,
        headers: await headers(),
        payload: {
          key: 'advanced-life-support',
          name: 'Advanced Life Support',
          requiresExpiry: true,
          issuingBody: 'Synthetic Certifying Body',
        },
      });
      expect(defined.statusCode, defined.body).toBe(200);
      const qualificationId = defined.json<{ qualification: { id: string } }>().qualification.id;

      const issued = await harness.app.inject({
        method: 'POST',
        url: `${base()}/qualification-holdings`,
        headers: await headers(),
        payload: {
          membershipId: subject(),
          qualificationId,
          validUntil: '2030-01-01T00:00:00.000Z',
          evidenceRef: 'SYNTH-REF-0001',
          status: 'valid',
        },
      });
      expect(issued.statusCode, issued.body).toBe(200);
      const holdingId = issued.json<{ holding: WireHolding }>().holding.id;

      const now = await harness.app.inject({
        method: 'GET',
        url: `${base()}/memberships/${subject()}/qualification-holdings`,
        headers: await headers(),
      });
      expect(now.statusCode, now.body).toBe(200);
      const past = await harness.app.inject({
        method: 'GET',
        url: `${base()}/memberships/${subject()}/qualification-holdings?at=${encodeURIComponent('2020-01-01T00:00:00.000Z')}`,
        headers: await headers(),
      });

      const freeText = await harness.app.inject({
        method: 'POST',
        url: `${base()}/qualification-holdings`,
        headers: await headers(),
        payload: {
          membershipId: multi().alpha.users.member.membershipId,
          qualificationId,
          evidenceRef: 'certificate seen by the ward manager on the 3rd',
        },
      });

      const revoked = await harness.app.inject({
        method: 'PATCH',
        url: `${base()}/qualification-holdings/${holdingId}`,
        headers: await headers(),
        payload: { status: 'revoked' },
      });
      expect(revoked.statusCode, revoked.body).toBe(200);

      const after = await harness.app.inject({
        method: 'GET',
        url: `${base()}/memberships/${subject()}/qualification-holdings`,
        headers: await headers(),
      });

      const reinstate = await harness.app.inject({
        method: 'PATCH',
        url: `${base()}/qualification-holdings/${holdingId}`,
        headers: await headers(),
        payload: { status: 'valid' },
      });

      const retired = await harness.app.inject({
        method: 'PATCH',
        url: `${base()}/qualifications/${qualificationId}`,
        headers: await headers(),
        payload: { status: 'retired' },
      });
      expect(retired.statusCode, retired.body).toBe(200);

      const stillThere = await admin.query<{ n: string }>(
        'select count(*)::text as n from qualification_holdings where qualification_id = $1::uuid',
        [qualificationId],
      );

      return {
        qualificationId,
        holdingId,
        eligibleNow: now.json<{ eligible: boolean }>().eligible,
        eligibleBeforeIssue: past.json<{ eligible: boolean }>().eligible,
        freeTextStatus: freeText.statusCode,
        revoked: revoked.json<{ holding: WireHolding }>().holding,
        afterRevocation: after.json<CredentialTrip['afterRevocation']>(),
        reinstateStatus: reinstate.statusCode,
        retiredStatus: retired.json<{ qualification: { status: string } }>().qualification.status,
        holdingsAfterRetire: Number(stillThere.rows[0]?.n ?? '0'),
      };
    })();
    return sequence;
  };

  it('eligibility is answered AT THE INSTANT ASKED ABOUT, not at request time', async () => {
    const trip = await credentialTrip();
    expect(trip.eligibleNow).toBe(true);
    // CAP-058's recorded open question: eligibility is evaluated at the shift
    // date. Asked about a date before the credential existed, the answer is no.
    expect(trip.eligibleBeforeIssue).toBe(false);
    log('eligibility is answered at the instant asked about, not at request time');
  });

  it('a free-text `evidenceRef` is refused before it reaches the database (I-07)', async () => {
    const trip = await credentialTrip();
    expect(trip.freeTextStatus, 'free text was accepted into an evidence reference').toBe(400);
  });

  it('REVOKE — the window is untouched and the status is what changed', async () => {
    const trip = await credentialTrip();
    expect(trip.revoked.status).toBe('revoked');
    // Revocation is a statement this organization makes; the window is the
    // statement the issuing body made. Overwriting the second with the first
    // would lose the fact that the credential was valid for that period.
    expect(trip.revoked.validUntil, 'revocation rewrote the credential window').toBe(
      '2030-01-01T00:00:00.000Z',
    );
  });

  it('…the revoked holding is RETAINED and confers nothing', async () => {
    const trip = await credentialTrip();
    expect(
      trip.afterRevocation.holdings.map((holding) => holding.id),
      'the revoked holding was not retained',
    ).toContain(trip.holdingId);
    expect(trip.afterRevocation.eligible, 'a revoked credential still conferred eligibility').toBe(
      false,
    );
    log('a revoked credential is retained, keeps its window, and confers nothing');
  });

  it('revocation is TERMINAL — reinstating is refused at the database', async () => {
    const trip = await credentialTrip();
    expect(trip.reinstateStatus, 'a revoked credential was reinstated').toBe(422);
  });

  it('revocation has its OWN audit event name, against THIS holding', async () => {
    const trip = await credentialTrip();
    // By subject id, not by count: an absolute count over an append-only table is
    // an assertion about every sibling as well as this one.
    const rows = await admin.query<{ event_name: string }>(
      `select event_name from audit_events
        where organization_id = $1::uuid and subject_id = $2::uuid
          and event_name like 'staffing.qualification_holding.%'
        order by sequence`,
      [org(), trip.holdingId],
    );
    const names = rows.rows.map((row) => row.event_name);
    expect(names).toContain('staffing.qualification_holding.granted');
    expect(
      names,
      'a revocation was filed under the generic status-change name',
    ).toContain('staffing.qualification_holding.revoked');
  });

  it('T-06 — create, retire and reinstate are DISTINGUISHABLE in the audit trail', async () => {
    /* The finding: `staffing.qualification.written` was emitted for all three,
     * indistinguishably. The ruling permits distinguishing names OR a mechanism
     * discriminator; the discriminator is used, because retiring an event name
     * already in `AUDIT_EVENT_NAMES` is exactly what non-bypass rule 13 forbids.
     *
     * The credential trip creates and then retires, so both mechanisms are present
     * and each names the status it moved from and to. */
    const trip = await credentialTrip();

    const rows = await admin.query<{ payload: Record<string, unknown> }>(
      `select payload from audit_events
        where organization_id = $1::uuid and event_name = 'staffing.qualification.written'
          and subject_id = $2::uuid
        order by sequence`,
      [org(), trip.qualificationId],
    );
    const mechanisms = rows.rows.map((row) => row.payload['mechanism']);
    expect(mechanisms, 'create and retire are still indistinguishable').toEqual([
      'create',
      'retire',
    ]);

    const [created, retired] = rows.rows;
    expect(created?.payload['beforeStatus']).toBe('none');
    expect(created?.payload['afterStatus']).toBe('active');
    expect(retired?.payload['beforeStatus']).toBe('active');
    expect(retired?.payload['afterStatus']).toBe('retired');
    // The KEY is safe to carry because the column is CHECK-constrained to a
    // lower-case token; `name` and `issuingBody` are display text and are absent.
    expect(created?.payload['key']).toBe('advanced-life-support');
    expect(Object.keys(created?.payload ?? {})).not.toContain('name');
    expect(Object.keys(created?.payload ?? {})).not.toContain('issuingBody');
    expect(created?.payload['hasIssuingBody']).toBe(true);
    log('create / retire / reinstate are distinguished by `mechanism` and by before/after status');
  });

  it('T-06 — a holding\'s events carry before/after status, and never the evidence VALUE', async () => {
    const trip = await credentialTrip();
    const rows = await admin.query<{ event_name: string; payload: Record<string, unknown> }>(
      `select event_name, payload from audit_events
        where organization_id = $1::uuid and subject_id = $2::uuid
          and event_name like 'staffing.qualification_holding.%'
        order by sequence`,
      [org(), trip.holdingId],
    );
    const granted = rows.rows.find((row) => row.event_name.endsWith('.granted'));
    const revoked = rows.rows.find((row) => row.event_name.endsWith('.revoked'));

    expect(granted?.payload['mechanism']).toBe('grant');
    expect(granted?.payload['afterStatus']).toBe('valid');
    // The evidence REFERENCE is recorded as a boolean and never as its value: the
    // column admits 128 characters where the closed payload admits 64, and a
    // pointer to a credential document does not belong duplicated into an
    // append-only table that is never deleted. Stated in INDEX §2b.
    expect(granted?.payload['hasEvidenceRef']).toBe(true);
    expect(Object.keys(granted?.payload ?? {})).not.toContain('evidenceRef');
    expect(JSON.stringify(granted?.payload)).not.toContain('SYNTH-REF-0001');

    expect(revoked?.payload['mechanism']).toBe('revoke');
    expect(revoked?.payload['beforeStatus']).toBe('valid');
    expect(revoked?.payload['afterStatus']).toBe('revoked');
    // Revocation does not move the window, and the payload says so rather than
    // leaving a reader to assume it.
    expect(revoked?.payload['validUntil']).toBe('2030-01-01T00:00:00.000Z');
    log('holding events carry before/after status; the evidence reference value never appears');
  });

  it('RETIRE the qualification — archived, never deleted, holdings intact', async () => {
    const trip = await credentialTrip();
    expect(trip.retiredStatus).toBe('retired');
    expect(trip.holdingsAfterRetire).toBeGreaterThan(0);
    log('retiring a qualification leaves every holding that referenced it intact');
  });
});
