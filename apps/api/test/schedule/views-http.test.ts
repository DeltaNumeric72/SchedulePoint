import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { publishVersion } from '../../src/schedule/publication.js';
import {
  addManualAssignment,
  cloneVersion,
  createDraftVersion,
  createPeriod,
  transitionVersion,
} from '../../src/schedule/service.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **NAMED-CONDITION PROOF — the staff-facing schedule views (OPUS-M3-006).**
 *
 * Five properties, each one a packet key proof, each asserted over HTTP against
 * the real database with a real published history seeded through the production
 * write path:
 *
 * | # | Property | Why it could fail silently |
 * |---|---|---|
 * | 1 | **self-scoping** — member A cannot fetch member B's personal view | a route that took the membership from the path and trusted it would look identical in every green test |
 * | 2 | **draft invisibility** — a draft version's assignments never appear | a draft rendered to staff is indistinguishable from a published one on screen; the person turns up for a shift nobody agreed to |
 * | 3 | **overnight rendering** — a 22:00 → 06:00 shift appears on BOTH days, the second labelled a continuation | showing it on one day only is a night-shift worker missing a shift, and it looks correct on the other day |
 * | 4 | **timezone correctness** — every local rendering resolves against `groups.timezone` | a server in UTC rendering an Auckland rota puts an 08:00 shift on the previous day, and the fixture is built so that mistake is visible |
 * | 5 | **cross-group denial** — byte-identical to a membership that does not exist | a 409 or a different body would disclose that a named person exists in another group |
 *
 * ## The fixture is deliberately hostile to a UTC-shaped bug
 *
 * The group's zone is `Pacific/Auckland` (UTC+12 in June) and every assignment
 * is seeded as an INSTANT that falls on a different UTC date from its local one.
 * A rendering that read the UTC date, or the server's zone, or the snapshot's
 * `date` column without converting, produces the wrong day for every row here —
 * so property 4 cannot pass by accident.
 *
 * ## An ALLOW control precedes every DENY
 *
 * FAD-15 vacuity discipline: a deny whose subject does not exist denies for the
 * wrong reason and passes anyway. Every 403/404 below is preceded by the same
 * request succeeding for an authorized actor against the same route.
 */

const multi = ownedMulti('schedule-views', {
  profile: 'full',
  // The catalogue only: this file seeds its own published history below, so the
  // instants and the zone are exactly what the assertions need. `schedule: true`
  // would add a second history whose intervals this file would then have to
  // avoid — D-1b's exclusion is global per membership across periods.
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let harness: HttpHarness;
let runtime: Runtime;
let admin: pg.Client;

const alpha = () => multi().alpha;
const full = () => {
  const value = multi().alpha.full;
  if (value === undefined) throw new Error('the full profile provisions viewer/telecom/groupAdmin');
  return value;
};

/** The group's zone for this fixture. +12 in June, so a UTC bug is visible. */
const ZONE = 'Pacific/Auckland';

/* The seeded content, in LOCAL Auckland terms and in the instants that produce
 * it. Every instant below was computed by hand from the zone offset, so the
 * expectations are independent of the code under test. */
const DAY_SHIFT = {
  localDate: '2029-06-04',
  // 08:00–16:00 NZST on 4 June = 20:00Z on 3 June – 04:00Z on 4 June.
  startsAt: new Date('2029-06-03T20:00:00.000Z'),
  endsAt: new Date('2029-06-04T04:00:00.000Z'),
};
const NIGHT_SHIFT = {
  localDate: '2029-06-06',
  localNextDate: '2029-06-07',
  // 22:00 on 6 June – 06:00 on 7 June NZST = 10:00Z – 18:00Z on 6 June.
  startsAt: new Date('2029-06-06T10:00:00.000Z'),
  endsAt: new Date('2029-06-06T18:00:00.000Z'),
};
/** Held only on a DRAFT version. It must never appear on a staff surface. */
const DRAFT_SHIFT = {
  localDate: '2029-06-10',
  startsAt: new Date('2029-06-09T20:00:00.000Z'),
  endsAt: new Date('2029-06-10T04:00:00.000Z'),
};
/** A colleague's shift on the night-shift date — the daily sheet's other row. */
const COLLEAGUE_SHIFT = {
  localDate: '2029-06-06',
  startsAt: new Date('2029-06-05T20:00:00.000Z'),
  endsAt: new Date('2029-06-06T04:00:00.000Z'),
};

const RANGE = { from: '2029-06-01', to: '2029-06-30' };

let periodId = '';
let publishedVersionId = '';
let draftVersionId = '';

function base(groupId?: string): string {
  return `/organizations/${alpha().organizationId}/groups/${groupId ?? alpha().groupOne.id}/published-schedule`;
}

interface Reply {
  readonly statusCode: number;
  readonly body: unknown;
  readonly raw: string;
}

async function call(url: string, userId: string, groupId?: string): Promise<Reply> {
  const counters = await currentCounters(admin, {
    organizationId: alpha().organizationId,
    groupId: groupId ?? alpha().groupOne.id,
    userId,
  });
  const response = await harness.app.inject({
    method: 'GET',
    url,
    headers: contextHeaders(userId, counters),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    parsed = undefined;
  }
  return { statusCode: response.statusCode, body: parsed, raw: response.body };
}

/** Set the group's zone through the real settings route, before anything is published. */
async function setZone(): Promise<void> {
  const settingsBase = `/organizations/${alpha().organizationId}/groups/${alpha().groupOne.id}/settings`;
  const counters = async () =>
    currentCounters(admin, {
      organizationId: alpha().organizationId,
      groupId: alpha().groupOne.id,
      userId: full().groupAdmin.id,
    });

  const read = await harness.app.inject({
    method: 'GET',
    url: settingsBase,
    headers: contextHeaders(full().groupAdmin.id, await counters()),
  });
  expect(read.statusCode, read.body).toBe(200);
  const version = (JSON.parse(read.body) as { version: number }).version;

  const written = await harness.app.inject({
    method: 'PUT',
    url: `${settingsBase}/timezone`,
    headers: {
      ...contextHeaders(full().groupAdmin.id, await counters()),
      'content-type': 'application/json',
    },
    payload: JSON.stringify({
      timezone: ZONE,
      expectedVersion: version,
      // Nothing is published yet, so no acknowledgement is required and none is
      // claimed. The zone is set BEFORE the history exists on purpose.
      acknowledgePublishedImpact: false,
    }),
  });
  expect(written.statusCode, written.body).toBe(204);
}

/**
 * Seed one published version and one draft, through the production write path.
 *
 * The same functions a route calls — so the seed exercises the SPEC-06 gate, the
 * audit chain and the publication transaction, and the rows it produces are rows
 * the application can actually make.
 */
async function seedHistory(): Promise<void> {
  const actor = { principalUserId: alpha().users.scheduler.id };
  const context = {
    organizationId: alpha().organizationId,
    groupId: alpha().groupOne.id,
    membershipId: alpha().users.scheduler.membershipId,
    correlationId: 'views-seed',
  };
  const shiftTypeId = multi().catalogue?.alpha?.shiftTypeIds[0];
  if (shiftTypeId === undefined) throw new Error('the catalogue seed produced no shift type');

  await runtime.runner.run(context, async (uow) => {
    periodId = await createPeriod(uow, actor, {
      name: 'Staff-view window',
      startDate: RANGE.from,
      endDate: RANGE.to,
    });

    publishedVersionId = await createDraftVersion(uow, actor, periodId);
    for (const shift of [DAY_SHIFT, NIGHT_SHIFT]) {
      await addManualAssignment(uow, actor, {
        versionId: publishedVersionId,
        membershipId: alpha().users.member.membershipId,
        shiftTypeId,
        date: shift.localDate,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
      });
    }
    await addManualAssignment(uow, actor, {
      versionId: publishedVersionId,
      membershipId: alpha().users.scheduler.membershipId,
      shiftTypeId,
      date: COLLEAGUE_SHIFT.localDate,
      startsAt: COLLEAGUE_SHIFT.startsAt,
      endsAt: COLLEAGUE_SHIFT.endsAt,
    });

    await transitionVersion(uow, actor, publishedVersionId, 'in_review');
    await transitionVersion(uow, actor, publishedVersionId, 'approved');
    await publishVersion(uow, actor, {
      periodId,
      versionId: publishedVersionId,
      idempotencyKey: 'views-seed-v1',
      expectedPriorCurrentVersionId: null,
    });

    /* The DRAFT. A separate version in the same period, never transitioned and
     * never published, carrying an assignment for the SAME member on a date
     * inside the same range — so the only thing keeping it off the staff view is
     * the published-only predicate. */
    draftVersionId = await createDraftVersion(uow, actor, periodId);
    await addManualAssignment(uow, actor, {
      versionId: draftVersionId,
      membershipId: alpha().users.member.membershipId,
      shiftTypeId,
      date: DRAFT_SHIFT.localDate,
      startsAt: DRAFT_SHIFT.startsAt,
      endsAt: DRAFT_SHIFT.endsAt,
    });
  });
}

beforeAll(async () => {
  harness = await buildHttpHarness();
  runtime = createRuntime('app_runtime', { max: 3 });
  admin = adminClient();
  await admin.connect();
  await setZone();
  await seedHistory();
}, 180_000);

afterAll(async () => {
  await harness.close();
  await runtime.destroy();
  await admin.end();
});

interface Entry {
  assignmentIdentityId: string;
  membershipId: string;
  displayName: string;
  startsAt: string;
  endsAt: string;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  isContinuation: boolean;
  continuesToNextDay: boolean;
  versionId: string;
  versionNumber: number;
}

interface PersonalBody {
  membershipId: string;
  timezone: string;
  from: string;
  to: string;
  days: { date: string; entries: Entry[] }[];
}

interface SheetBody {
  date: string;
  timezone: string;
  entries: Entry[];
}

function personalUrl(membershipId: string, groupId?: string): string {
  return `${base(groupId)}/members/${membershipId}?from=${RANGE.from}&to=${RANGE.to}`;
}

async function personalAsMember(): Promise<PersonalBody> {
  const reply = await call(
    personalUrl(alpha().users.member.membershipId),
    alpha().users.member.id,
  );
  expect(reply.statusCode, reply.raw).toBe(200);
  return reply.body as PersonalBody;
}

function entriesOn(body: PersonalBody, date: string): Entry[] {
  return body.days.find((day) => day.date === date)?.entries ?? [];
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1 — the allow control, and what the personal view actually contains
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the personal published schedule', () => {
  it('a member reads their OWN schedule, over the whole requested range', async () => {
    const body = await personalAsMember();

    expect(body.membershipId).toBe(alpha().users.member.membershipId);
    expect(body.timezone).toBe(ZONE);
    // Every day of the range is present, including the empty ones: "you are not
    // working" is an answer, and a calendar that skipped them would make the
    // reader count squares.
    expect(body.days).toHaveLength(30);
    expect(body.days[0]?.date).toBe('2029-06-01');
    expect(body.days[29]?.date).toBe('2029-06-30');

    // Nothing but this member's own rows, whatever else the group published.
    const everyEntry = body.days.flatMap((day) => day.entries);
    expect(new Set(everyEntry.map((entry) => entry.membershipId))).toEqual(
      new Set([alpha().users.member.membershipId]),
    );
    expect(everyEntry.every((entry) => entry.versionId === publishedVersionId)).toBe(true);
    expect(everyEntry.every((entry) => entry.versionNumber === 1)).toBe(true);

    log(
      `personal view: ${String(everyEntry.length)} entries across ${String(body.days.length)} days, zone ${body.timezone}`,
    );
  });

  it('a range longer than the contract bound is REFUSED, never truncated', async () => {
    const reply = await call(
      `${base()}/members/${alpha().users.member.membershipId}?from=2029-01-01&to=2029-12-31`,
      alpha().users.member.id,
    );
    expect(reply.statusCode, reply.raw).toBe(422);
    expect((reply.body as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  it('a malformed range is refused with a field-addressed 422', async () => {
    const reply = await call(
      `${base()}/members/${alpha().users.member.membershipId}?from=2029-06-30&to=2029-06-01`,
      alpha().users.member.id,
    );
    expect(reply.statusCode, reply.raw).toBe(422);
    expect(
      (reply.body as { error: { problems: { field: string }[] } }).error.problems[0]?.field,
    ).toBe('to');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4 — timezone correctness (asserted before the rest, because everything else
 *     reads the same rendering)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('timezone correctness under a non-UTC group zone', () => {
  it('an 08:00 Auckland shift lands on its LOCAL day, not its UTC day', async () => {
    const body = await personalAsMember();

    // The instant is 2029-06-03T20:00Z. A rendering that used the UTC date would
    // put this shift on 3 June; the local date is 4 June.
    expect(entriesOn(body, '2029-06-03')).toHaveLength(0);

    const entries = entriesOn(body, DAY_SHIFT.localDate);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.startsAt).toBe(DAY_SHIFT.startsAt.toISOString());
    expect(entry?.startTime).toBe('08:00');
    expect(entry?.endTime).toBe('16:00');
    expect(entry?.startDate).toBe(DAY_SHIFT.localDate);
    expect(entry?.endDate).toBe(DAY_SHIFT.localDate);
    expect(entry?.isContinuation).toBe(false);
    expect(entry?.continuesToNextDay).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3 — the overnight shift, on BOTH days
 * ──────────────────────────────────────────────────────────────────────────── */

describe('an overnight shift appears on both days, the second as a continuation', () => {
  it('22:00 → 06:00 is rendered on its start date AND on the following date', async () => {
    const body = await personalAsMember();

    const first = entriesOn(body, NIGHT_SHIFT.localDate);
    const second = entriesOn(body, NIGHT_SHIFT.localNextDate);
    expect(first, 'the night shift is missing from its start date').toHaveLength(1);
    expect(second, 'the night shift is missing from the day it runs into').toHaveLength(1);

    // ONE assignment, rendered twice. Same identity on both days — a reader that
    // counted rows without reading `isContinuation` would count it twice, which
    // is exactly why the flag is required rather than optional.
    expect(first[0]?.assignmentIdentityId).toBe(second[0]?.assignmentIdentityId);

    expect(first[0]?.startTime).toBe('22:00');
    expect(first[0]?.endTime).toBe('06:00');
    expect(first[0]?.isContinuation).toBe(false);
    expect(first[0]?.continuesToNextDay).toBe(true);

    expect(second[0]?.isContinuation).toBe(true);
    expect(second[0]?.continuesToNextDay).toBe(false);
    // The continuation still names the day it began, so the surface can say so
    // even when that day is off screen.
    expect(second[0]?.startDate).toBe(NIGHT_SHIFT.localDate);
    expect(second[0]?.endDate).toBe(NIGHT_SHIFT.localNextDate);

    log(
      `overnight: ${String(first[0]?.startTime)}→${String(first[0]?.endTime)} on ${NIGHT_SHIFT.localDate} ` +
        `and as a continuation on ${NIGHT_SHIFT.localNextDate}`,
    );
  });

  it('the continuation is present on the daily sheet for the following date too', async () => {
    const reply = await call(
      `${base()}/daily-sheet?date=${NIGHT_SHIFT.localNextDate}`,
      alpha().users.member.id,
    );
    expect(reply.statusCode, reply.raw).toBe(200);
    const sheet = reply.body as SheetBody;
    const night = sheet.entries.filter(
      (entry) => entry.membershipId === alpha().users.member.membershipId,
    );
    expect(night).toHaveLength(1);
    expect(night[0]?.isContinuation).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2 — draft invisibility, at the query level
 * ──────────────────────────────────────────────────────────────────────────── */

describe('a draft version is invisible to staff', () => {
  it('the seeded draft exists and holds an assignment for this member', async () => {
    // The non-vacuity control. Without this, "the draft does not appear" would
    // pass just as well if the draft had never been seeded — which is the shape
    // of a proof that proves nothing.
    const rows = await admin.query<{ count: string }>(
      `select count(*)::text as count
         from assignment_snapshots s
         join schedule_versions v on v.id = s.version_id
        where s.version_id = $1 and s.membership_id = $2 and v.state = 'draft'`,
      [draftVersionId, alpha().users.member.membershipId],
    );
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('EACH clause of the predicate is individually load-bearing, against a state no CHECK forbids', async () => {
    /* N-1. The claim used to be "neither clause is redundant", and the suite did
     * not measure it: an independent reviewer removed each clause on its own and
     * the file still passed 18/18, because publication step 08 supersedes AND
     * clears `is_current` together, so today either clause alone happens to
     * suffice.
     *
     * **Nothing enforces that coupling.** There is no CHECK saying
     * `is_current ⇒ state = 'published'`; it is maintained by one function in
     * one transaction. So the honest way to make the claim true is to craft the
     * two decoupled states and show which clause excludes each.
     *
     * Both crafted states are reached through transitions the DATABASE ITSELF
     * PERMITS — no trigger is disabled and no constraint is dropped:
     *
     *   A. `state='published'`, `is_current=false` — exactly what D-15b's guard
     *      allows on a frozen version (`is_current` true→false is the outgoing
     *      version's own transition);
     *   B. `state='draft'`, `is_current=true` — the guard's frozen branch does
     *      not apply to a draft, and D-16's partial unique index is satisfied
     *      because A cleared the period's current flag first.
     *
     * The whole thing runs inside a transaction that is ROLLED BACK, so no
     * crafted row outlives the probe.
     */
    const selection = (predicate: string): string => `
      select count(*)::int as n
        from assignment_snapshots s
        join schedule_versions v on v.id = s.version_id
       where s.status = 'active'
         and s.membership_id = $1
         and s.ends_at   > timestamptz '2029-05-31 12:00:00+00'
         and s.starts_at < timestamptz '2029-06-30 12:00:00+00'
         ${predicate}`;
    const member = alpha().users.member.membershipId;
    const count = async (predicate: string): Promise<number> =>
      (await admin.query<{ n: number }>(selection(predicate), [member])).rows[0]?.n ?? -1;

    await admin.query('BEGIN');
    try {
      await admin.query('UPDATE schedule_versions SET is_current = false WHERE id = $1', [
        publishedVersionId,
      ]);
      await admin.query('UPDATE schedule_versions SET is_current = true WHERE id = $1', [
        draftVersionId,
      ]);

      const both = await count("and v.state = 'published' and v.is_current = true");
      const stateOnly = await count("and v.state = 'published'");
      const currentOnly = await count('and v.is_current = true');

      // The shipped predicate excludes BOTH crafted states.
      expect(both, 'the shipped predicate leaked a crafted state').toBe(0);
      // Without `is_current`, the published-but-not-current version leaks: the
      // `is_current` clause is what excludes it.
      expect(stateOnly, 'the is_current clause is not load-bearing').toBeGreaterThan(0);
      // Without `state`, the draft marked current leaks: the `state` clause is
      // what excludes it.
      expect(currentOnly, 'the state clause is not load-bearing').toBeGreaterThan(0);

      log(
        `decoupled states: both clauses ${String(both)} rows · state-only ${String(stateOnly)} ` +
          `(published, not current) · is_current-only ${String(currentOnly)} (draft marked current)`,
      );
    } finally {
      await admin.query('ROLLBACK');
    }

    // The rollback really rolled back: the real state is untouched.
    const after = await admin.query<{ state: string; is_current: boolean }>(
      'select state, is_current from schedule_versions where id = $1',
      [publishedVersionId],
    );
    expect(after.rows[0]).toEqual({ state: 'published', is_current: true });
  });

  it('the PREDICATE is the only thing hiding it — the same query without it selects the draft', async () => {
    /* The falsifiability control, stated in SQL rather than in prose.
     *
     * This is the route's own selection — the same joins, the same window, the
     * same active-only clause — run twice: once WITH the published-only
     * predicate and once WITHOUT it. If the two agreed, the predicate would be
     * decorative and the red case would be proving nothing.
     *
     * The window is expressed as the instants the route computes for
     * `2029-06-01 .. 2029-06-30` in `Pacific/Auckland`. */
    const selection = (predicate: string): string => `
      select s.assignment_identity_id
        from assignment_snapshots s
        join schedule_versions v on v.id = s.version_id
       where s.status = 'active'
         and s.membership_id = $1
         and s.ends_at   > timestamptz '2029-05-31 12:00:00+00'
         and s.starts_at < timestamptz '2029-06-30 12:00:00+00'
         ${predicate}`;

    const withPredicate = await admin.query(
      selection("and v.state = 'published' and v.is_current = true"),
      [alpha().users.member.membershipId],
    );
    const withoutPredicate = await admin.query(selection(''), [
      alpha().users.member.membershipId,
    ]);

    expect(withoutPredicate.rowCount ?? 0).toBeGreaterThan(withPredicate.rowCount ?? 0);
    log(
      `published-only predicate: ${String(withPredicate.rowCount)} rows with it, ` +
        `${String(withoutPredicate.rowCount)} without — the difference is the draft`,
    );
  });

  it('the draft assignment appears on NEITHER staff surface', async () => {
    const body = await personalAsMember();
    expect(entriesOn(body, DRAFT_SHIFT.localDate)).toHaveLength(0);
    expect(
      body.days.flatMap((day) => day.entries).some((entry) => entry.versionId === draftVersionId),
    ).toBe(false);

    const sheet = await call(
      `${base()}/daily-sheet?date=${DRAFT_SHIFT.localDate}`,
      alpha().users.member.id,
    );
    expect(sheet.statusCode, sheet.raw).toBe(200);
    expect((sheet.body as SheetBody).entries).toHaveLength(0);
  });

  it('a superseded version is invisible too — the view is the CURRENT schedule', async () => {
    /* This test PUBLISHES, so it owns its own period and its own window.
     *
     * The first version of it cloned and republished the file's main period, and
     * `pnpm fixture-regression` failed it on nine of nine shuffled seeds: under a
     * shuffle it ran before the tests that assert the main window reads version
     * 1, and left them reading version 2. That is an order dependence in the
     * TEST, not a defect in the route — and it is exactly the class the shuffled
     * harness exists to expose. A test that mutates shared state must own that
     * state.
     *
     * August, not June: `current_published_assignments`' exclusion (D-1b) is
     * global per membership across periods, so a second published interval for
     * the same person has to sit somewhere the first one does not. */
    const actor = { principalUserId: alpha().users.scheduler.id };
    const context = {
      organizationId: alpha().organizationId,
      groupId: alpha().groupOne.id,
      membershipId: alpha().users.scheduler.membershipId,
      correlationId: 'views-supersession',
    };
    const shiftTypeId = multi().catalogue?.alpha?.shiftTypeIds[0];
    if (shiftTypeId === undefined) throw new Error('the catalogue seed produced no shift type');

    const range = { from: '2029-08-01', to: '2029-08-31' };
    const published = await runtime.runner.run(context, async (uow) => {
      const ownPeriod = await createPeriod(uow, actor, {
        name: 'Supersession window',
        startDate: range.from,
        endDate: range.to,
      });
      const first = await createDraftVersion(uow, actor, ownPeriod);
      await addManualAssignment(uow, actor, {
        versionId: first,
        membershipId: alpha().users.member.membershipId,
        shiftTypeId,
        date: '2029-08-06',
        // 08:00–16:00 NZST on 6 August = 20:00Z on 5 August – 04:00Z on 6 August.
        startsAt: new Date('2029-08-05T20:00:00.000Z'),
        endsAt: new Date('2029-08-06T04:00:00.000Z'),
      });
      await transitionVersion(uow, actor, first, 'in_review');
      await transitionVersion(uow, actor, first, 'approved');
      await publishVersion(uow, actor, {
        periodId: ownPeriod,
        versionId: first,
        idempotencyKey: 'views-supersede-v1',
        expectedPriorCurrentVersionId: null,
      });

      const second = await cloneVersion(uow, actor, first);
      await transitionVersion(uow, actor, second, 'in_review');
      await transitionVersion(uow, actor, second, 'approved');
      await publishVersion(uow, actor, {
        periodId: ownPeriod,
        versionId: second,
        idempotencyKey: 'views-supersede-v2',
        expectedPriorCurrentVersionId: first,
      });
      return { first, second };
    });

    const reply = await call(
      `${base()}/members/${alpha().users.member.membershipId}?from=${range.from}&to=${range.to}`,
      alpha().users.member.id,
    );
    expect(reply.statusCode, reply.raw).toBe(200);
    const everyEntry = (reply.body as PersonalBody).days.flatMap((day) => day.entries);

    expect(everyEntry.length).toBeGreaterThan(0);
    expect(everyEntry.every((entry) => entry.versionId === published.second)).toBe(true);
    // V1 is still `published`-shaped history in the database; it is not current,
    // so the staff view does not read it.
    expect(everyEntry.some((entry) => entry.versionId === published.first)).toBe(false);
    expect(everyEntry.every((entry) => entry.versionNumber === 2)).toBe(true);
    log(`after supersession the view reads version 2 only (${String(everyEntry.length)} entries)`);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 1 / 5 — self-scoping and cross-group denial
 * ──────────────────────────────────────────────────────────────────────────── */

describe('self-scoping and denial', () => {
  /** The 404 body, with the per-request correlation id normalised away. */
  function normalised(reply: Reply): string {
    return reply.raw.replace(/"correlationId":"[^"]*"/, '"correlationId":"<id>"');
  }

  it('member A cannot fetch member B\'s personal view — 404, not their own data', async () => {
    // ALLOW control first: the same route, the same actor, their own membership.
    const own = await call(
      personalUrl(alpha().users.member.membershipId),
      alpha().users.member.id,
    );
    expect(own.statusCode, own.raw).toBe(200);

    const other = await call(
      personalUrl(alpha().users.scheduler.membershipId),
      alpha().users.member.id,
    );
    expect(other.statusCode, other.raw).toBe(404);
    // And emphatically NOT a 200 carrying the caller's own rows: a route that
    // silently substituted "self" for any requested membership would be a lie
    // the caller could not detect.
    expect(other.body).not.toHaveProperty('days');
  });

  it('a SCHEDULER cannot fetch a member\'s personal view either — there is no override', async () => {
    // The ruling in one assertion: no administrative capability lifts ownership
    // on this route. A scheduler holds `schedule.version.edit`, `schedule.
    // period.administer`, `schedule.publish` and both read keys, and still
    // cannot read a named colleague's personal view.
    const own = await call(
      personalUrl(alpha().users.scheduler.membershipId),
      alpha().users.scheduler.id,
    );
    expect(own.statusCode, own.raw).toBe(200);

    const other = await call(
      personalUrl(alpha().users.member.membershipId),
      alpha().users.scheduler.id,
    );
    expect(other.statusCode, other.raw).toBe(404);
  });

  it('cross-group, non-existent and not-yours are BYTE-IDENTICAL', async () => {
    const other = await call(
      personalUrl(alpha().users.scheduler.membershipId),
      alpha().users.member.id,
    );
    const crossGroup = await call(
      // A membership in Alpha's Group TWO, requested under Group ONE's context.
      personalUrl(alpha().users.groupTwoScheduler.membershipId),
      alpha().users.member.id,
    );
    const absent = await call(
      personalUrl('00000000-0000-4000-8000-000000000000'),
      alpha().users.member.id,
    );

    expect(other.statusCode).toBe(404);
    expect(crossGroup.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(normalised(crossGroup)).toBe(normalised(absent));
    expect(normalised(other)).toBe(normalised(absent));
    log(`the single 404 body: ${normalised(absent)}`);
  });

  it('a malformed membership id is the same 404 — the shape discloses nothing', async () => {
    const reply = await call(personalUrl('not-a-uuid'), alpha().users.member.id);
    expect(reply.statusCode, reply.raw).toBe(404);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The daily sheet, and the role matrix
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the daily assignment sheet', () => {
  it('shows everyone working that date, not only the caller', async () => {
    const reply = await call(
      `${base()}/daily-sheet?date=${NIGHT_SHIFT.localDate}`,
      alpha().users.member.id,
    );
    expect(reply.statusCode, reply.raw).toBe(200);
    const sheet = reply.body as SheetBody;
    expect(sheet.timezone).toBe(ZONE);

    const memberships = [...new Set(sheet.entries.map((entry) => entry.membershipId))];
    expect(memberships).toContain(alpha().users.member.membershipId);
    expect(memberships).toContain(alpha().users.scheduler.membershipId);
    // `docs/fable/08-roles-and-permissions.md` §6: "View published schedules" is
    // a shared read. Knowing who is on
    // with you is the point of publishing a rota.
    expect(sheet.entries.every((entry) => entry.displayName.length > 0)).toBe(true);
    log(`daily sheet ${sheet.date}: ${String(sheet.entries.length)} entries, zone ${sheet.timezone}`);
  });

  it('an empty date is an empty sheet, not an error', async () => {
    const reply = await call(`${base()}/daily-sheet?date=2029-06-20`, alpha().users.member.id);
    expect(reply.statusCode, reply.raw).toBe(200);
    expect((reply.body as SheetBody).entries).toEqual([]);
  });

  it('a viewer may read both surfaces; TELECOM may read neither', async () => {
    const viewerSheet = await call(
      `${base()}/daily-sheet?date=${NIGHT_SHIFT.localDate}`,
      full().viewer.id,
    );
    expect(viewerSheet.statusCode, viewerSheet.raw).toBe(200);

    const viewerOwn = await call(
      personalUrl(full().viewer.membershipId),
      full().viewer.id,
    );
    expect(viewerOwn.statusCode, viewerOwn.raw).toBe(200);

    // `docs/fable/08-roles-and-permissions.md` §6 marks Telecom `—` on "View
    // published schedules": the on-call
    // board only (CAP-044). This is the deny arm both new keys are tested
    // against, and it is a 403 rather than a 404 because the actor holds an
    // active membership here and the tenant's existence is already known to them
    // (SPEC-06 P-6).
    const telecomSheet = await call(
      `${base()}/daily-sheet?date=${NIGHT_SHIFT.localDate}`,
      full().telecom.id,
    );
    expect(telecomSheet.statusCode, telecomSheet.raw).toBe(403);

    const telecomOwn = await call(
      personalUrl(full().telecom.membershipId),
      full().telecom.id,
    );
    expect(telecomOwn.statusCode, telecomOwn.raw).toBe(403);
  });

  it('a malformed date is a 422 naming the parameter', async () => {
    const reply = await call(`${base()}/daily-sheet?date=6-june`, alpha().users.member.id);
    expect(reply.statusCode, reply.raw).toBe(422);
    expect(
      (reply.body as { error: { problems: { field: string }[] } }).error.problems[0]?.field,
    ).toBe('date');
  });
});
