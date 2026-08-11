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
import { setTimezone } from '../../src/settings/service.js';
import { tzdbVersion } from '../../src/schedule/timezone.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { buildHttpHarness, contextHeaders, currentCounters, type HttpHarness } from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantStaffingCapabilities } from '../support/staffing.js';
import { fixtureInstant, publicationKey, scheduleActor } from '../support/schedule.js';

/**
 * **NAMED-CONDITION PROOF — the timezone snapshot (OPUS-M4-000B; doc 34 §4-F).**
 *
 * Doc 34 §4-F requires "the timezone interpretation needed to reproduce a
 * build/published version snapshotted", and "timezone changes coordinated with
 * build-input creation". Migration 0014 adds
 * `schedule_versions.timezone_basis` / `.tzdb_version`; this file proves the
 * four behaviours that make those columns mean something:
 *
 * | # | Property | What breaks silently without it |
 * |---|---|---|
 * | 1 | a draft RECORDS the zone its instants were derived under | nothing can tell later whether a rota is an hour out |
 * | 2 | a CLONE INHERITS the source's basis | a clone of a pre-change version publishes silently wrong instants — the exact hole escalation E1 was about |
 * | 3 | a stale basis REFUSES publication (`TIMEZONE_BASIS_STALE`) | a group timezone change quietly re-times every unpublished draft |
 * | 4 | a PUBLISHED version renders identically after a group tz change | an administrator changing a setting mutates immutable history (I-18) through a surface that never touched the row |
 *
 * ## Property 2 asserts on the COLUMNS, not on `cloneVersion`'s body
 *
 * `cloneVersion` is jointly edited in M4 — 000B contributes the two basis
 * columns, 000C contributes credit preservation — and the second merger composes
 * both. A proof written against the function's shape would break on composition
 * and would then be "fixed" by whoever merged second, which is how a real
 * assertion turns into a formality. Every assertion below reads
 * `schedule_versions` and asserts on the stored values.
 */

/**
 * The shape a typed refusal is read through.
 *
 * Declared once, at module scope, because `error as typeof refusal` inside the
 * catch resolves against the CONTROL-FLOW-narrowed type of the variable (which
 * is `null` at that point), collapsing every later property read to `never`. A
 * named type is what keeps the assertions readable and type-checked.
 */
interface Refusal {
  readonly code?: string;
  readonly message?: string;
  readonly recordedZone?: string;
  readonly currentZone?: string;
}

const multi = ownedMulti('schedule-timezone-basis', {
  profile: 'full',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let harness: HttpHarness;
let runtime: Runtime;
let admin: pg.Client;
let context: { organizationId: string; groupId: string; membershipId: string; correlationId: string };
let actor: ReturnType<typeof scheduleActor>;
let shiftTypeId: string;
let assigneeA: string;

const alpha = () => multi().alpha;
const full = () => {
  const value = multi().alpha.full;
  if (value === undefined) throw new Error('the full profile provisions groupAdmin');
  return value;
};

const run = async <T>(fn: (uow: Parameters<Parameters<Runtime['runner']['run']>[1]>[0]) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn as never) as Promise<T>;

/** The two basis columns, straight out of the table. */
async function basisOf(versionId: string): Promise<{ zone: string | null; tzdb: string | null }> {
  const row = await run(async (uow) =>
    uow.query
      .selectFrom('schedule_versions')
      .select(['timezone_basis', 'tzdb_version'])
      .where('id', '=', versionId)
      .executeTakeFirstOrThrow(),
  );
  return { zone: row.timezone_basis, tzdb: row.tzdb_version };
}

/** Change the group's zone through the real settings service. */
async function changeZone(to: string): Promise<{ staleDraftVersionIds: readonly string[] }> {
  return run(async (uow) => {
    const current = await uow.query
      .selectFrom('groups')
      .select('settings_version')
      .where('id', '=', context.groupId)
      .executeTakeFirstOrThrow();
    const outcome = await setTimezone(uow, to, current.settings_version, true);
    if (outcome.kind !== 'ok') throw new Error(`timezone change failed: ${outcome.kind}`);
    return { staleDraftVersionIds: outcome.value.staleDraftVersionIds };
  });
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 6 });
  admin = adminClient();
  await admin.connect();
  harness = await buildHttpHarness();

  const fixture = multi();
  const catalogue = fixture.catalogue?.alpha;
  if (catalogue === undefined) throw new Error('needs the alpha catalogue seed');
  const type = catalogue.shiftTypeIds[1];
  if (type === undefined) throw new Error('no shift type');
  shiftTypeId = type;

  context = {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupOne.id,
    membershipId: fixture.alpha.users.scheduler.membershipId,
    correlationId: 'timezone-basis',
  };
  actor = scheduleActor(fixture.alpha.users.scheduler.id);
  assigneeA = fixture.alpha.users.scheduler.membershipId;

  /* `group.timezone.administer` is grant-only (doc 08 §6) and no fixture role
   * carries it, so it is GRANTED through the production grant path — exactly as
   * a real administrator would be — rather than by writing `groups.timezone`
   * directly. Migration 0010's trigger demands it on every zone change, and a
   * test that bypassed the grant would be proving the basis behaviour against a
   * write path production does not have. */
  await grantStaffingCapabilities(runtime.runner, fixture, {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupOne.id,
    membershipId: fixture.alpha.users.scheduler.membershipId,
    capabilities: ['group.timezone.administer'],
  });

  /* `schedule.publish` is a `G` cell (grant-only, doc 08 §4): no fixture ROLE
   * carries it, so the HTTP publication proofs in §5 would answer 403 rather
   * than reaching the timezone gate at all. Granted through the production
   * grant path to the group administrator who drives those requests. */
  await grantStaffingCapabilities(runtime.runner, fixture, {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupOne.id,
    membershipId: full().groupAdmin.membershipId,
    capabilities: ['schedule.publish'],
  });

  /* Start from a NON-UTC zone with a real DST rule, so a bug that reads the
   * server's zone or falls back to UTC is visible rather than accidentally
   * right. */
  await changeZone('America/Toronto');
});

afterAll(async () => {
  await harness?.close();
  await runtime?.destroy();
  await admin?.end();
});

/* ────────────────────────────────────────────────────────────────────────────
 * 1 — a draft records the interpretation it was built under
 * ──────────────────────────────────────────────────────────────────────────── */

describe('1 — a new draft RECORDS its timezone basis', () => {
  it('stores the group’s zone and the runtime tz rule set', async () => {
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'basis-capture period',
        startDate: '2036-01-05',
        endDate: '2036-01-05',
      }),
    );
    const versionId = await run(async (uow) => createDraftVersion(uow, actor, periodId));

    const basis = await basisOf(versionId);
    expect(basis.zone).toBe('America/Toronto');
    expect(basis.tzdb).toBe(tzdbVersion());
    // `unknown` is a permitted RECORDED ABSENCE, never a fabricated version.
    expect(basis.tzdb).toMatch(/^[0-9a-z.]+$|^unknown$/);
    log(`draft basis: ${String(basis.zone)} @ tzdb ${String(basis.tzdb)}`);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2 — a clone INHERITS, and does not re-capture
 * ──────────────────────────────────────────────────────────────────────────── */

describe('2 — a CLONE inherits the source’s basis (escalation E1)', () => {
  it('inherits it even after the group has moved to a different zone', async () => {
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'basis-clone period',
        startDate: '2036-02-10',
        endDate: '2036-02-10',
      }),
    );
    const sourceId = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodId);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2036-02-10',
        startsAt: fixtureInstant('2036-02-10', 13),
        endsAt: fixtureInstant('2036-02-10', 21),
      });
      return draft;
    });
    expect((await basisOf(sourceId)).zone).toBe('America/Toronto');

    // The group moves. The source's INSTANTS do not.
    await changeZone('Europe/London');

    const cloneId = await run(async (uow) => cloneVersion(uow, actor, sourceId));
    const cloneBasis = await basisOf(cloneId);

    /* THE ASSERTION THAT MATTERS. A clone copies `starts_at`/`ends_at`
     * verbatim, so its content was built under the SOURCE's interpretation.
     * Stamping it with the current zone would assert a fact that is not true and
     * would let the staleness check pass on a draft whose instants are five
     * hours out. */
    expect(cloneBasis.zone, 'the clone must inherit, not re-capture').toBe('America/Toronto');
    expect(cloneBasis.zone).not.toBe('Europe/London');
    expect(cloneBasis.tzdb).toBe(tzdbVersion());

    // A NEW draft created at the same moment captures the CURRENT zone — which
    // is what makes the inheritance above a decision rather than a bug.
    const freshId = await run(async (uow) => createDraftVersion(uow, actor, periodId));
    expect((await basisOf(freshId)).zone).toBe('Europe/London');

    await changeZone('America/Toronto');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3 — a stale basis refuses publication, and says so
 * ──────────────────────────────────────────────────────────────────────────── */

describe('3 — publication REFUSES a stale basis', () => {
  it('refuses, names both zones, and leaves the version approved', async () => {
    const date = '2036-03-15';
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, { name: 'basis-stale period', startDate: date, endDate: date }),
    );
    const versionId = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodId);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date,
        startsAt: fixtureInstant(date, 13),
        endsAt: fixtureInstant(date, 21),
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      return draft;
    });

    const change = await changeZone('Australia/Sydney');
    expect(
      change.staleDraftVersionIds,
      'the settings surface must name the drafts it just invalidated',
    ).toContain(versionId);

    /* Asserted on the typed CODE, not on the prose. The message names both
     * zones for a human; a test that matched the sentence would pass for any
     * refusal whose wording happened to overlap and would break the moment
     * somebody improved the copy. */
    let refusal: Refusal | null = null;
    try {
      await run(async (uow) =>
        publishVersion(uow, actor, {
          periodId,
          versionId,
          idempotencyKey: publicationKey('basis-stale'),
          expectedPriorCurrentVersionId: null,
        }),
      );
    } catch (error) {
      refusal = error as Refusal;
    }
    expect(refusal, 'publishing against a stale basis must be refused').not.toBeNull();
    expect(refusal?.code).toBe('TIMEZONE_BASIS_STALE');
    expect(refusal?.recordedZone).toBe('America/Toronto');
    expect(refusal?.currentZone).toBe('Australia/Sydney');
    // And the message tells a human both halves, because the administrator who
    // changed the setting and the scheduler who meets this are usually not the
    // same person.
    expect(refusal?.message).toContain('America/Toronto');
    expect(refusal?.message).toContain('Australia/Sydney');

    // Nothing moved: the refusal is before any write.
    const after = await run(async (uow) =>
      uow.query
        .selectFrom('schedule_versions')
        .select(['state', 'is_current', 'version_number'])
        .where('id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );
    expect(after.state).toBe('approved');
    expect(after.is_current).toBe(false);
    expect(after.version_number).toBeNull();

    // CONTROL — restoring the zone makes the very same publication succeed, so
    // the refusal is about the basis and not about anything else in the draft.
    await changeZone('America/Toronto');
    await expect(
      run(async (uow) =>
        publishVersion(uow, actor, {
          periodId,
          versionId,
          idempotencyKey: publicationKey('basis-restored'),
          expectedPriorCurrentVersionId: null,
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('a version with NO recorded basis publishes — 0014 does not unpublish history', async () => {
    /* Versions created before migration 0014 carry no basis. Refusing them would
     * make an additive migration retroactively break drafts it never touched, so
     * `unrecorded` is permitted — and asserted here by clearing the columns as
     * the migrator, which is what such a row looks like. */
    const date = '2036-04-01';
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, { name: 'basis-unrecorded period', startDate: date, endDate: date }),
    );
    const versionId = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodId);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date,
        startsAt: fixtureInstant(date, 13),
        endsAt: fixtureInstant(date, 21),
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      return draft;
    });

    await admin.query(
      'UPDATE schedule_versions SET timezone_basis = NULL, tzdb_version = NULL WHERE id = $1',
      [versionId],
    );
    expect((await basisOf(versionId)).zone).toBeNull();

    await expect(
      run(async (uow) =>
        publishVersion(uow, actor, {
          periodId,
          versionId,
          idempotencyKey: publicationKey('basis-unrecorded'),
          expectedPriorCurrentVersionId: null,
        }),
      ),
      'a pre-0014 version must still be publishable',
    ).resolves.toBeDefined();
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4 — reproducibility, through the REAL read surface
 * ──────────────────────────────────────────────────────────────────────────── */

describe('4 — a PUBLISHED version renders identically after a group tz change', () => {
  it('the staff daily sheet shows the published wall clock, not the new zone’s', async () => {
    const date = '2036-05-20';
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, { name: 'basis-render period', startDate: date, endDate: date }),
    );
    await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodId);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date,
        // 08:00–16:00 in America/Toronto on 2036-05-20 (EDT, UTC−4).
        startsAt: new Date('2036-05-20T12:00:00.000Z'),
        endsAt: new Date('2036-05-20T20:00:00.000Z'),
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      await publishVersion(uow, actor, {
        periodId,
        versionId: draft,
        idempotencyKey: publicationKey('basis-render'),
        expectedPriorCurrentVersionId: null,
      });
      return draft;
    });

    const sheetUrl =
      `/organizations/${alpha().organizationId}/groups/${alpha().groupOne.id}` +
      `/published-schedule/daily-sheet?date=${date}`;

    const read = async (): Promise<{
      timezone: string;
      entries: { startTime: string; endTime: string; timezone: string; timezoneSource: string }[];
    }> => {
      const counters = await currentCounters(admin, {
        organizationId: alpha().organizationId,
        groupId: alpha().groupOne.id,
        userId: full().groupAdmin.id,
      });
      const response = await harness.app.inject({
        method: 'GET',
        url: sheetUrl,
        headers: contextHeaders(full().groupAdmin.id, counters),
      });
      expect(response.statusCode, response.body).toBe(200);
      return JSON.parse(response.body) as never;
    };

    const before = await read();
    const mine = before.entries.filter((entry) => entry.startTime === '08:00');
    expect(mine.length, 'the seeded shift must be on the sheet').toBeGreaterThan(0);
    expect(mine[0]?.endTime).toBe('16:00');
    expect(mine[0]?.timezone).toBe('America/Toronto');
    expect(mine[0]?.timezoneSource).toBe('version-snapshot');

    /* The group moves to a zone eight hours away. The published version is
     * immutable (I-18) and nothing rewrites a single stored instant. */
    await changeZone('Australia/Sydney');

    const after = await read();
    const sameEntries = after.entries.filter((entry) => entry.timezone === 'America/Toronto');
    expect(sameEntries.length, 'the published entry must still be rendered').toBeGreaterThan(0);
    expect(
      sameEntries[0]?.startTime,
      'a published wall clock may not move because a setting changed',
    ).toBe('08:00');
    expect(sameEntries[0]?.endTime).toBe('16:00');
    expect(sameEntries[0]?.timezoneSource).toBe('version-snapshot');

    /* The CALENDAR AXIS did move, and that is the other half of the ruling: the
     * response-level zone is the group's current one, because a view has to
     * present ONE calendar. Both facts are on the payload; neither is hidden. */
    expect(after.timezone).toBe('Australia/Sydney');
    expect(before.timezone).toBe('America/Toronto');

    log(
      `published entry rendered ${String(mine[0]?.startTime)}–${String(mine[0]?.endTime)} ` +
        `under ${String(mine[0]?.timezone)} before AND after the group moved to ${after.timezone}`,
    );

    await changeZone('America/Toronto');
  });

  /**
   * The MUTATION CONTROL for property 4.
   *
   * Clearing the version's recorded basis is exactly what the "render under the
   * group's current zone" implementation would look like from the outside. With
   * the basis gone the same read reports the NEW zone's wall clock — so the
   * assertions above are detecting the snapshot and not a coincidence.
   */
  it('MUTATION CONTROL: with the basis cleared, the same read DOES move', async () => {
    const date = '2036-06-24';
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, { name: 'basis-mutation period', startDate: date, endDate: date }),
    );
    const draftId = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodId);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date,
        // 08:00–16:00 EDT.
        startsAt: new Date('2036-06-24T12:00:00.000Z'),
        endsAt: new Date('2036-06-24T20:00:00.000Z'),
      });
      return draft;
    });

    /* THE MUTATION: the basis is removed while the version is still a draft,
     * which is precisely what a build that never recorded one would leave
     * behind. Everything else about this version is identical to the one
     * above. */
    await admin.query('UPDATE schedule_versions SET timezone_basis = NULL WHERE id = $1', [
      draftId,
    ]);

    const versionId = await run(async (uow) => {
      await transitionVersion(uow, actor, draftId, 'in_review');
      await transitionVersion(uow, actor, draftId, 'approved');
      await publishVersion(uow, actor, {
        periodId,
        versionId: draftId,
        idempotencyKey: publicationKey('basis-mutation'),
        expectedPriorCurrentVersionId: null,
      });
      return draftId;
    });

    /* The basis had to be cleared BEFORE publication, and the reason is a
     * property worth stating: once a version is published, D-15b freezes every
     * column except its five permitted ones, and `timezone_basis` is
     * deliberately NOT among them. So a published version's recorded
     * interpretation is immutable exactly like the rest of its content (I-18) —
     * asserted here rather than assumed, by trying it as the SUPERUSER and
     * being refused. */
    let frozen: string | null = null;
    try {
      /* A real CHANGE, not a no-op: this version's basis is already NULL, and
       * `IS DISTINCT FROM` correctly permits NULL -> NULL. Writing a VALUE is
       * what the guard has to refuse. */
      await admin.query(
        "UPDATE schedule_versions SET timezone_basis = 'Pacific/Auckland' WHERE id = $1",
        [versionId],
      );
    } catch (error) {
      frozen = (error as Error).message;
    }
    expect(frozen, 'a published version’s recorded basis must be immutable').not.toBeNull();
    expect(frozen).toMatch(/SCHEDULE_VERSION_FROZEN_COLUMN/);

    await changeZone('Australia/Sydney');

    const counters = await currentCounters(admin, {
      organizationId: alpha().organizationId,
      groupId: alpha().groupOne.id,
      userId: full().groupAdmin.id,
    });
    const response = await harness.app.inject({
      method: 'GET',
      url:
        `/organizations/${alpha().organizationId}/groups/${alpha().groupOne.id}` +
        `/published-schedule/daily-sheet?date=${date}`,
      headers: contextHeaders(full().groupAdmin.id, counters),
    });
    expect(response.statusCode, response.body).toBe(200);
    const sheet = JSON.parse(response.body) as {
      entries: { startTime: string; timezone: string; timezoneSource: string }[];
    };

    const fallen = sheet.entries.filter((entry) => entry.timezoneSource === 'group-current');
    expect(fallen.length, 'with no basis the entry must fall back').toBeGreaterThan(0);
    expect(fallen[0]?.timezone).toBe('Australia/Sydney');
    expect(
      fallen[0]?.startTime,
      'and the wall clock MOVES — which is what the snapshot prevents',
    ).not.toBe('08:00');

    await changeZone('America/Toronto');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5 — the refusal reaches the CALLER as 409, not 404 (review B-2)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('5 — TIMEZONE_BASIS_STALE answers 409 with both zones, through the real route', () => {
  /**
   * The defect this closes.
   *
   * `TIMEZONE_BASIS_STALE` was absent from `CONFLICT_CODES`, so
   * `outcomeOfServiceError` fell through to `not-found` and the route answered
   * **404**. A scheduler whose draft had gone stale — a condition a colleague
   * had caused and either of them could fix — was told their version DOES NOT
   * EXIST. The service-level proof in §3 passed throughout, because it asserts
   * on the thrown error and never crosses the HTTP boundary. That is exactly
   * the gap an HTTP-level assertion exists to close.
   */
  it('publishing a stale draft over HTTP is 409 TIMEZONE_BASIS_STALE, naming both zones', async () => {
    const date = '2036-08-12';
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, { name: 'basis-http period', startDate: date, endDate: date }),
    );
    const versionId = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodId);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date,
        startsAt: fixtureInstant(date, 13),
        endsAt: fixtureInstant(date, 21),
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      return draft;
    });

    const scheduleBase =
      `/organizations/${alpha().organizationId}/groups/${alpha().groupOne.id}/schedule`;
    const headers = async (): Promise<Record<string, string>> =>
      contextHeaders(
        full().groupAdmin.id,
        await currentCounters(admin, {
          organizationId: alpha().organizationId,
          groupId: alpha().groupOne.id,
          userId: full().groupAdmin.id,
        }),
      );

    /* The review digest is read FIRST, while the basis is still fresh — so the
     * publish below fails for the timezone reason and not because the review
     * was stale. A test that got a 409 for the wrong reason would look
     * identical. */
    const review = await harness.app.inject({
      method: 'GET',
      url: `${scheduleBase}/versions/${versionId}/publication-review`,
      headers: await headers(),
    });
    expect(review.statusCode, review.body).toBe(200);
    const reviewDigest = (JSON.parse(review.body) as { reviewDigest: string }).reviewDigest;

    // Now the group moves, which is what makes the draft stale.
    await changeZone('Australia/Sydney');

    const published = await harness.app.inject({
      method: 'POST',
      url: `${scheduleBase}/versions/${versionId}/publication`,
      headers: { ...(await headers()), 'content-type': 'application/json' },
      payload: JSON.stringify({
        idempotencyKey: publicationKey('basis-http').slice(0, 64),
        expectedPriorCurrentVersionId: null,
        expectedReviewDigest: reviewDigest,
        acknowledged: true,
        // The type-to-confirm tier: this publication changes a schedule people
        // are already working to, so the route requires the period's name typed
        // back. Supplied so the request reaches the TIMEZONE gate rather than
        // stopping at a 422 that would have masked it.
        confirmationPhrase: 'basis-http period',
      }),
    });

    expect(published.statusCode, published.body).toBe(409);
    const body = JSON.parse(published.body) as {
      error: { code: string; message: string; recordedTimezone?: string; currentTimezone?: string };
    };
    expect(body.error.code).toBe('TIMEZONE_BASIS_STALE');
    expect(body.error.recordedTimezone).toBe('America/Toronto');
    expect(body.error.currentTimezone).toBe('Australia/Sydney');
    // Both zones in the prose too: the administrator who changed the setting and
    // the scheduler who meets this are usually different people.
    expect(body.error.message).toContain('America/Toronto');
    expect(body.error.message).toContain('Australia/Sydney');

    log(`stale publish over HTTP -> ${String(published.statusCode)} ${body.error.code}`);

    // The version did not move.
    const after = await run(async (uow) =>
      uow.query
        .selectFrom('schedule_versions')
        .select(['state', 'is_current'])
        .where('id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );
    expect(after.state).toBe('approved');
    expect(after.is_current).toBe(false);

    await changeZone('America/Toronto');
  });

  it('CONTROL: the same publish succeeds (2xx) once the zone is restored', async () => {
    // Without this the 409 above could be any refusal at all.
    const date = '2036-09-14';
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, { name: 'basis-http-control period', startDate: date, endDate: date }),
    );
    const versionId = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodId);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date,
        startsAt: fixtureInstant(date, 13),
        endsAt: fixtureInstant(date, 21),
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      return draft;
    });

    const scheduleBase =
      `/organizations/${alpha().organizationId}/groups/${alpha().groupOne.id}/schedule`;
    const headers = async (): Promise<Record<string, string>> =>
      contextHeaders(
        full().groupAdmin.id,
        await currentCounters(admin, {
          organizationId: alpha().organizationId,
          groupId: alpha().groupOne.id,
          userId: full().groupAdmin.id,
        }),
      );

    const review = await harness.app.inject({
      method: 'GET',
      url: `${scheduleBase}/versions/${versionId}/publication-review`,
      headers: await headers(),
    });
    expect(review.statusCode, review.body).toBe(200);
    const reviewDigest = (JSON.parse(review.body) as { reviewDigest: string }).reviewDigest;

    const published = await harness.app.inject({
      method: 'POST',
      url: `${scheduleBase}/versions/${versionId}/publication`,
      headers: { ...(await headers()), 'content-type': 'application/json' },
      payload: JSON.stringify({
        idempotencyKey: publicationKey('basis-http-ok').slice(0, 64),
        expectedPriorCurrentVersionId: null,
        expectedReviewDigest: reviewDigest,
        acknowledged: true,
        confirmationPhrase: 'basis-http-control period',
      }),
    });
    expect(published.statusCode, published.body).toBeLessThan(300);
  });
});
