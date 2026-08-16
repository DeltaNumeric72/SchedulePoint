import { AUDIT_EVENT_NAMES } from '@schedulepoint/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type DeclaredCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantScheduleCapabilities } from '../support/schedule.js';
import { createRuntime, type Runtime } from '../support/harness.js';

/**
 * The schedule-authoring HTTP surface, over the real database (OPUS-M3-004).
 *
 * ## An ALLOW control comes first, every time
 *
 * FAD-15 vacuity discipline: a deny test whose subject does not exist denies for
 * the wrong reason and passes anyway. Every deny below is preceded by the same
 * request succeeding for an authorized actor against the same route and the same
 * body shape, so a 403 can only mean the capability gate.
 *
 * ## What the compare-and-set arm proves, and how it could fail
 *
 * The stale-edit tests do not merely observe a 409. They assert that the SECOND
 * writer's change did **not** land — because a compare-and-set that answered 409
 * after writing would look identical from the status code alone, and that is the
 * defect worth catching.
 */

const multi = ownedMulti('schedule-authoring', {
  profile: 'full',
  seed: { catalogue: ['alpha'], schedule: true },
});

let harness: HttpHarness;
let runtime: Runtime;
let admin: pg.Client;

beforeAll(async () => {
  harness = await buildHttpHarness();
  runtime = createRuntime('app_runtime', { max: 3 });
  admin = adminClient();
  await admin.connect();
}, 180_000);

afterAll(async () => {
  await harness.close();
  await runtime.destroy();
  await admin.end();
});

function schedulePath(groupId?: string): string {
  const alpha = multi().alpha;
  return `/organizations/${alpha.organizationId}/groups/${groupId ?? alpha.groupOne.id}/schedule`;
}

async function countersFor(userId: string, groupId?: string): Promise<DeclaredCounters> {
  const alpha = multi().alpha;
  return currentCounters(admin, {
    organizationId: alpha.organizationId,
    groupId: groupId ?? alpha.groupOne.id,
    userId,
  });
}

interface Reply {
  readonly statusCode: number;
  readonly body: unknown;
  readonly raw: string;
}

async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  userId: string,
  options: { body?: unknown; groupId?: string } = {},
): Promise<Reply> {
  const response = await harness.app.inject({
    method,
    url,
    headers: {
      ...contextHeaders(userId, await countersFor(userId, options.groupId)),
      'content-type': 'application/json',
    },
    ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    parsed = undefined;
  }
  return { statusCode: response.statusCode, body: parsed, raw: response.body };
}

/** A period name nothing else in this run collides with (the name is UNIQUE per group). */
let nameCounter = 0;
function uniqueName(prefix: string): string {
  nameCounter += 1;
  return `${prefix} ${String(nameCounter)}`;
}

/**
 * Non-overlapping 2028 windows.
 *
 * D-2 excludes overlapping periods per group, and the fixture already holds a
 * 2027 window, so each test that creates a period takes its own month far from
 * both. A careless reuse would fail on the exclusion constraint and be read as a
 * defect in the route.
 */
let windowCounter = 0;
function freshWindow(): { startDate: string; endDate: string } {
  const index = windowCounter;
  windowCounter += 1;
  const year = 2028 + Math.floor(index / 12);
  const month = String((index % 12) + 1).padStart(2, '0');
  return { startDate: `${String(year)}-${month}-02`, endDate: `${String(year)}-${month}-20` };
}

interface CreatedDraft {
  readonly periodId: string;
  readonly versionId: string;
  readonly startDate: string;
  readonly shiftTypeId: string;
}

/** Create a period and a draft version through the real routes. */
async function createDraft(): Promise<CreatedDraft> {
  const scheduler = multi().alpha.users.scheduler.id;
  const window = freshWindow();

  const period = await call('POST', `${schedulePath()}/periods`, scheduler, {
    body: { name: uniqueName('Authoring window'), ...window },
  });
  expect(period.statusCode, period.raw).toBe(200);
  const periodId = (period.body as { period: { id: string } }).period.id;

  const version = await call('POST', `${schedulePath()}/periods/${periodId}/versions`, scheduler, {
    body: {},
  });
  expect(version.statusCode, version.raw).toBe(200);

  const shiftTypeId = multi().catalogue?.alpha?.shiftTypeIds[0];
  if (shiftTypeId === undefined) throw new Error('the catalogue seed produced no shift type');

  return {
    periodId,
    versionId: (version.body as { version: { id: string } }).version.id,
    startDate: window.startDate,
    shiftTypeId,
  };
}

interface GridBody {
  version: { id: string; isEditable: boolean; state: string };
  period: { id: string; startDate: string; endDate: string };
  dates: string[];
  shiftTypes: { id: string; code: string }[];
  cells: {
    date: string;
    shiftTypeId: string;
    requiredCount: number;
    revision: string;
    assignments: {
      assignmentIdentityId: string;
      membershipId: string;
      isPinned: boolean;
      creditId: string | null;
      creditedMembershipId: string | null;
      overrideReasonGiven: boolean;
    }[];
  }[];
  emptyCellRevision: string;
  roster: { membershipId: string; displayName: string }[];
  conflicts: { id: string; severity: string }[];
  timezone: string;
}

async function readGrid(versionId: string, userId?: string): Promise<GridBody> {
  const reply = await call(
    'GET',
    `${schedulePath()}/versions/${versionId}/grid`,
    userId ?? multi().alpha.users.scheduler.id,
  );
  expect(reply.statusCode, reply.raw).toBe(200);
  return reply.body as GridBody;
}

function cellOf(grid: GridBody, date: string, shiftTypeId: string) {
  return grid.cells.find((cell) => cell.date === date && cell.shiftTypeId === shiftTypeId);
}

function revisionOf(grid: GridBody, date: string, shiftTypeId: string): string {
  return cellOf(grid, date, shiftTypeId)?.revision ?? grid.emptyCellRevision;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Periods and versions
 * ──────────────────────────────────────────────────────────────────────────── */

describe('period administration (schedule.period.administer)', () => {
  it('ALLOW: a scheduler creates a period and reads it back', async () => {
    const window = freshWindow();
    const name = uniqueName('Allow window');
    const created = await call('POST', `${schedulePath()}/periods`, multi().alpha.users.scheduler.id, {
      body: { name, ...window },
    });
    expect(created.statusCode, created.raw).toBe(200);
    expect((created.body as { period: { name: string; status: string } }).period).toMatchObject({
      name,
      startDate: window.startDate,
      endDate: window.endDate,
      status: 'planning',
    });

    const list = await call('GET', `${schedulePath()}/periods`, multi().alpha.users.scheduler.id);
    expect(list.statusCode).toBe(200);
    expect(
      (list.body as { periods: { name: string }[] }).periods.map((period) => period.name),
    ).toContain(name);
  });

  it('DENY: a member without the capability is refused the SAME request', async () => {
    const denied = await call('POST', `${schedulePath()}/periods`, multi().alpha.users.member.id, {
      body: { name: uniqueName('Denied window'), ...freshWindow() },
    });
    // L4.2 — the actor holds an active membership here, so the tenant's
    // existence is already known to them and the disclosure class is 403.
    expect(denied.statusCode, denied.raw).toBe(403);
    // P-3: the reason never reaches the body.
    expect(denied.raw).not.toMatch(/capability|schedule\.period/i);
  });

  it('DENY: the read is refused for the same actor', async () => {
    const denied = await call('GET', `${schedulePath()}/periods`, multi().alpha.users.member.id);
    expect(denied.statusCode).toBe(403);
  });

  it('a malformed date range is a 422 naming the field, not a 500', async () => {
    const invalid = await call('POST', `${schedulePath()}/periods`, multi().alpha.users.scheduler.id, {
      body: { name: uniqueName('Backwards'), startDate: '2028-11-20', endDate: '2028-11-02' },
    });
    expect(invalid.statusCode, invalid.raw).toBe(422);
    expect(
      (invalid.body as { error: { problems: { field: string }[] } }).error.problems.map(
        (problem) => problem.field,
      ),
    ).toContain('endDate');
  });
});

describe('draft versions (schedule.version.edit)', () => {
  it('ALLOW: a scheduler creates a draft, and it is editable', async () => {
    const draft = await createDraft();
    const grid = await readGrid(draft.versionId);
    expect(grid.version.state).toBe('draft');
    expect(grid.version.isEditable).toBe(true);
    expect(grid.dates[0]).toBe(draft.startDate);
    expect(grid.shiftTypes.length).toBeGreaterThan(0);
    expect(grid.roster.length).toBeGreaterThan(0);
  });

  it('DENY: a member cannot create a draft against the same period', async () => {
    const draft = await createDraft();
    const denied = await call(
      'POST',
      `${schedulePath()}/periods/${draft.periodId}/versions`,
      multi().alpha.users.member.id,
      { body: {} },
    );
    expect(denied.statusCode, denied.raw).toBe(403);
  });

  it('a clone preserves assignment identity', async () => {
    const draft = await createDraft();
    const grid = await readGrid(draft.versionId);
    const added = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/assignments`,
      multi().alpha.users.scheduler.id,
      {
        body: {
          date: draft.startDate,
          shiftTypeId: draft.shiftTypeId,
          membershipId: multi().alpha.users.member.membershipId,
          expectedCellRevision: grid.emptyCellRevision,
        },
      },
    );
    expect(added.statusCode, added.raw).toBe(200);
    const identity = (added.body as { cell: { assignments: { assignmentIdentityId: string }[] } })
      .cell.assignments[0]?.assignmentIdentityId;

    const cloned = await call('POST', `${schedulePath()}/versions/clone`, multi().alpha.users.scheduler.id, {
      body: { sourceVersionId: draft.versionId },
    });
    expect(cloned.statusCode, cloned.raw).toBe(200);
    const cloneId = (cloned.body as { version: { id: string } }).version.id;

    const clonedGrid = await readGrid(cloneId);
    expect(
      cellOf(clonedGrid, draft.startDate, draft.shiftTypeId)?.assignments[0]
        ?.assignmentIdentityId,
    ).toBe(identity);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The compare-and-set (PO-DEC-18)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('stale-edit handling is server-authoritative and never merges', () => {
  it('a cell edit with a stale revision is refused, and nothing is written', async () => {
    const draft = await createDraft();
    const scheduler = multi().alpha.users.scheduler.id;
    const before = await readGrid(draft.versionId);
    const staleToken = revisionOf(before, draft.startDate, draft.shiftTypeId);

    // The first writer wins.
    const first = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/assignments`,
      scheduler,
      {
        body: {
          date: draft.startDate,
          shiftTypeId: draft.shiftTypeId,
          membershipId: multi().alpha.users.member.membershipId,
          expectedCellRevision: staleToken,
        },
      },
    );
    expect(first.statusCode, first.raw).toBe(200);
    const afterFirst = (first.body as { cell: { revision: string } }).cell.revision;
    expect(afterFirst).not.toBe(staleToken);

    // The second writer holds the token it read BEFORE the first write.
    const second = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/assignments`,
      scheduler,
      {
        body: {
          date: draft.startDate,
          shiftTypeId: draft.shiftTypeId,
          membershipId: multi().alpha.users.scheduler.membershipId,
          expectedCellRevision: staleToken,
        },
      },
    );
    expect(second.statusCode, second.raw).toBe(409);
    expect((second.body as { error: { code: string } }).error.code).toBe('STALE_EDIT');
    // The refusal carries the CURRENT revision, so the refetch flow is explicit
    // rather than a guess.
    expect((second.body as { error: { currentRevision: string } }).error.currentRevision).toBe(
      afterFirst,
    );

    // The property that matters: the loser's change did NOT land. A CAS that
    // answered 409 after writing would be indistinguishable by status code.
    const after = await readGrid(draft.versionId);
    const cell = cellOf(after, draft.startDate, draft.shiftTypeId);
    expect(cell?.assignments).toHaveLength(1);
    expect(cell?.assignments[0]?.membershipId).toBe(multi().alpha.users.member.membershipId);
    expect(cell?.revision).toBe(afterFirst);
  });

  it('retrying with the CURRENT revision succeeds — the refetch flow works', async () => {
    const draft = await createDraft();
    const scheduler = multi().alpha.users.scheduler.id;
    const grid = await readGrid(draft.versionId);

    const first = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/assignments`,
      scheduler,
      {
        body: {
          date: draft.startDate,
          shiftTypeId: draft.shiftTypeId,
          membershipId: multi().alpha.users.member.membershipId,
          expectedCellRevision: grid.emptyCellRevision,
        },
      },
    );
    expect(first.statusCode).toBe(200);
    const current = (first.body as { cell: { revision: string } }).cell.revision;

    const retried = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/assignments`,
      scheduler,
      {
        body: {
          date: draft.startDate,
          shiftTypeId: draft.shiftTypeId,
          membershipId: multi().alpha.users.scheduler.membershipId,
          expectedCellRevision: current,
        },
      },
    );
    expect(retried.statusCode, retried.raw).toBe(200);
    expect((retried.body as { cell: { assignments: unknown[] } }).cell.assignments).toHaveLength(2);
  });

  it('a requirement write with a stale revision is refused, and the count does not move', async () => {
    const draft = await createDraft();
    const scheduler = multi().alpha.users.scheduler.id;

    const list = await call(
      'GET',
      `${schedulePath()}/periods/${draft.periodId}/requirements`,
      scheduler,
    );
    expect(list.statusCode, list.raw).toBe(200);
    // OPUS-M4-000A: the editor's token is the AGGREGATE set version.
    const loadedVersion = (list.body as { version: number }).version;

    const first = await call(
      'PUT',
      `${schedulePath()}/periods/${draft.periodId}/requirements`,
      scheduler,
      {
        body: {
          requirements: [
            { date: draft.startDate, shiftTypeId: draft.shiftTypeId, requiredCount: 2 },
          ],
          expectedVersion: loadedVersion,
        },
      },
    );
    expect(first.statusCode, first.raw).toBe(200);

    // Without the aggregate CAS the replacement would silently replace the 2
    // with a 7 — the second writer presents the version the first consumed.
    const second = await call(
      'PUT',
      `${schedulePath()}/periods/${draft.periodId}/requirements`,
      scheduler,
      {
        body: {
          requirements: [
            { date: draft.startDate, shiftTypeId: draft.shiftTypeId, requiredCount: 7 },
          ],
          expectedVersion: loadedVersion,
        },
      },
    );
    expect(second.statusCode, second.raw).toBe(409);
    expect((second.body as { error: { code: string } }).error.code).toBe('STALE_SET_VERSION');

    const after = await call(
      'GET',
      `${schedulePath()}/periods/${draft.periodId}/requirements`,
      scheduler,
    );
    const written = (after.body as { requirements: { requiredCount: number; date: string }[] })
      .requirements.find((row) => row.date === draft.startDate);
    expect(written?.requiredCount).toBe(2);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Draft-only (I-18), and the rest of the cell editor
 * ──────────────────────────────────────────────────────────────────────────── */

describe('a published version is not editable through this surface (I-18)', () => {
  it('an assignment against the published version is refused', async () => {
    const published = multi().schedule?.groupOne.currentVersionId;
    if (published === undefined) throw new Error('the schedule seed produced no published version');

    const grid = await readGrid(published);
    expect(grid.version.state).toBe('published');
    expect(grid.version.isEditable).toBe(false);

    const refused = await call(
      'POST',
      `${schedulePath()}/versions/${published}/assignments`,
      multi().alpha.users.scheduler.id,
      {
        body: {
          date: grid.period.startDate,
          shiftTypeId: grid.shiftTypes[0]?.id,
          membershipId: multi().alpha.users.member.membershipId,
          expectedCellRevision: revisionOf(grid, grid.period.startDate, grid.shiftTypes[0]?.id ?? ''),
        },
      },
    );
    // The service's `assertEditable` refuses; D-15a would refuse independently.
    expect(refused.statusCode, refused.raw).toBe(409);
    expect((refused.body as { error: { code: string } }).error.code).toBe('CONFLICT');
  });
});

describe('the cell editor drives every manual operation', () => {
  it('assign, pin, credit, reassign and remove each land through the service', async () => {
    const draft = await createDraft();
    const scheduler = multi().alpha.users.scheduler.id;
    const memberMembership = multi().alpha.users.member.membershipId;
    const schedulerMembership = multi().alpha.users.scheduler.membershipId;

    const grid = await readGrid(draft.versionId);
    const added = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/assignments`,
      scheduler,
      {
        body: {
          date: draft.startDate,
          shiftTypeId: draft.shiftTypeId,
          membershipId: memberMembership,
          overrideReason: 'covering an unfilled requirement',
          expectedCellRevision: grid.emptyCellRevision,
        },
      },
    );
    expect(added.statusCode, added.raw).toBe(200);
    let cell = (added.body as { cell: GridBody['cells'][number] }).cell;
    const identity = cell.assignments[0]?.assignmentIdentityId ?? '';
    expect(cell.assignments[0]?.overrideReasonGiven).toBe(true);
    // The reason TEXT is never on the wire — only that one was given.
    expect(added.raw).not.toContain('covering an unfilled requirement');

    const pinned = await call(
      'PUT',
      `${schedulePath()}/versions/${draft.versionId}/assignments/${identity}/pin`,
      scheduler,
      { body: { isPinned: true, expectedCellRevision: cell.revision } },
    );
    expect(pinned.statusCode, pinned.raw).toBe(200);
    cell = (pinned.body as { cell: GridBody['cells'][number] }).cell;
    expect(cell.assignments[0]?.isPinned).toBe(true);

    // The credited membership deliberately differs from the assignee: who works
    // a shift and who is scored for it can legitimately differ (doc 07).
    const credited = await call(
      'PUT',
      `${schedulePath()}/versions/${draft.versionId}/assignments/${identity}/credit`,
      scheduler,
      {
        body: { creditedMembershipId: schedulerMembership, expectedCellRevision: cell.revision },
      },
    );
    expect(credited.statusCode, credited.raw).toBe(200);
    cell = (credited.body as { cell: GridBody['cells'][number] }).cell;
    expect(cell.assignments[0]?.creditedMembershipId).toBe(schedulerMembership);
    // The credit did NOT move the assignee — the separation is the point.
    expect(cell.assignments[0]?.membershipId).toBe(memberMembership);
    const creditId = cell.assignments[0]?.creditId ?? '';

    const voided = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/credits/${creditId}/void`,
      scheduler,
      { body: { expectedCellRevision: cell.revision } },
    );
    expect(voided.statusCode, voided.raw).toBe(200);
    cell = (voided.body as { cell: GridBody['cells'][number] }).cell;

    const reassigned = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/assignments/${identity}/reassignment`,
      scheduler,
      {
        body: {
          toMembershipId: schedulerMembership,
          reason: 'swap agreed at handover',
          expectedCellRevision: cell.revision,
        },
      },
    );
    expect(reassigned.statusCode, reassigned.raw).toBe(200);
    cell = (reassigned.body as { cell: GridBody['cells'][number] }).cell;
    expect(cell.assignments[0]?.membershipId).toBe(schedulerMembership);
    // The IDENTITY survived the reassignment — that is what makes the
    // affected-staff diff a join rather than a heuristic.
    expect(cell.assignments[0]?.assignmentIdentityId).toBe(identity);

    const removed = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/assignments/${identity}/removal`,
      scheduler,
      { body: { reason: 'requirement withdrawn', expectedCellRevision: cell.revision } },
    );
    expect(removed.statusCode, removed.raw).toBe(200);
    expect((removed.body as { cell: { assignments: unknown[] } }).cell.assignments).toHaveLength(0);
  });

  it('every mutation is audited by the service, under a known event name', async () => {
    const draft = await createDraft();
    const grid = await readGrid(draft.versionId);
    const added = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/assignments`,
      multi().alpha.users.scheduler.id,
      {
        body: {
          date: draft.startDate,
          shiftTypeId: draft.shiftTypeId,
          membershipId: multi().alpha.users.member.membershipId,
          expectedCellRevision: grid.emptyCellRevision,
        },
      },
    );
    expect(added.statusCode).toBe(200);
    const identity = (added.body as { cell: { assignments: { assignmentIdentityId: string }[] } })
      .cell.assignments[0]?.assignmentIdentityId;

    const rows = await admin.query<{ event_name: string }>(
      'select event_name from audit_events where subject_id = $1 order by sequence',
      [identity],
    );
    expect(rows.rows.map((row) => row.event_name)).toContain('schedule.assignment.added');
    for (const row of rows.rows) {
      expect(AUDIT_EVENT_NAMES).toContain(row.event_name);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Tenancy
 * ──────────────────────────────────────────────────────────────────────────── */

describe('cross-group isolation', () => {
  it("a scheduler declaring Group Two cannot read Group One's version", async () => {
    const draft = await createDraft();
    const alpha = multi().alpha;

    // The SAME principal, holding a scheduler membership in both groups, so a
    // 404 here cannot be "this user has no access anywhere".
    const control = await call(
      'GET',
      `${schedulePath(alpha.groupTwo.id)}/periods`,
      alpha.users.scheduler.id,
      { groupId: alpha.groupTwo.id },
    );
    expect(control.statusCode, control.raw).toBe(200);

    const crossed = await harness.app.inject({
      method: 'GET',
      url: `${schedulePath(alpha.groupTwo.id)}/versions/${draft.versionId}/grid`,
      headers: contextHeaders(
        alpha.users.scheduler.id,
        await countersFor(alpha.users.scheduler.id, alpha.groupTwo.id),
      ),
    });
    // RLS makes the other group's version invisible, so "not found" and "not
    // yours" are deliberately the same reply.
    expect(crossed.statusCode, crossed.body).toBe(404);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The eligibility ruling: ABSENT is not EMPTY
 * ──────────────────────────────────────────────────────────────────────────── */

describe('eligibility absent-vs-empty (the ruling this packet owns)', () => {
  it('ABSENT: a scheduler without the credential-read key gets null, not false', async () => {
    const draft = await createDraft();
    const reply = await call(
      'GET',
      `${schedulePath()}/versions/${draft.versionId}/candidates?date=${draft.startDate}&shiftTypeId=${draft.shiftTypeId}`,
      multi().alpha.users.scheduler.id,
    );
    expect(reply.statusCode, reply.raw).toBe(200);
    const body = reply.body as {
      eligibilityKnown: boolean;
      candidates: { eligible: boolean | null; missingQualificationIds: string[] }[];
    };

    // `staffing.qualification_holding.read` is grant-only — no role carries it —
    // so this is the DEFAULT scheduler experience, not a contrived one.
    expect(body.eligibilityKnown).toBe(false);
    expect(body.candidates.length).toBeGreaterThan(0);
    for (const candidate of body.candidates) {
      // The whole ruling in one assertion: never `false`, which would state
      // "not qualified" about somebody this caller simply cannot see.
      expect(candidate.eligible).toBeNull();
      expect(candidate.missingQualificationIds).toEqual([]);
    }
    // The roster is still offered — this surface is the override and recovery
    // mechanism, and absent eligibility does not block a manual assignment.
    expect(body.candidates.some((candidate) => candidate.eligible === null)).toBe(true);
  });

  /**
   * The KNOWN arm uses a DIFFERENT actor, and that is what makes the pair
   * order-independent.
   *
   * A capability grant is permanent for the fixture's lifetime, so granting it
   * to the scheduler would make the ABSENT test above pass or fail depending on
   * which ran first — and the acceptance battery runs under test-order shuffle.
   * The group administrator holds `schedule.version.edit` by role exactly as the
   * scheduler does, so the only difference between the two arms is the
   * credential-read key.
   */
  it('KNOWN: with the credential-read key the same call returns booleans', async () => {
    const alpha = multi().alpha;
    const groupAdmin = alpha.full?.groupAdmin;
    if (groupAdmin === undefined) throw new Error('the full profile provides no group admin');

    await grantScheduleCapabilities(runtime.runner, multi(), {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      membershipId: groupAdmin.membershipId,
      capabilities: ['staffing.qualification_holding.read'],
    });

    const draft = await createDraft();
    const reply = await call(
      'GET',
      `${schedulePath()}/versions/${draft.versionId}/candidates?date=${draft.startDate}&shiftTypeId=${draft.shiftTypeId}`,
      groupAdmin.id,
    );
    expect(reply.statusCode, reply.raw).toBe(200);
    const body = reply.body as {
      eligibilityKnown: boolean;
      candidates: { eligible: boolean | null }[];
    };
    expect(body.eligibilityKnown).toBe(true);
    expect(body.candidates.length).toBeGreaterThan(0);
    for (const candidate of body.candidates) {
      expect(typeof candidate.eligible).toBe('boolean');
    }
  });
});


/* ────────────────────────────────────────────────────────────────────────────
 * FAD-44(1) — the `origin` parameter, from the MANUAL side
 * ──────────────────────────────────────────────────────────────────────────── */

describe('assignment origin (FAD-44(1))', () => {
  it('the manual authoring path still writes `manual`, with no caller change', async () => {
    /* The default is what makes the grant byte-compatible: every existing caller
     * omits the parameter and every existing row keeps its meaning. If this ever
     * went the other way, the production mechanism and a human override would
     * become indistinguishable in the data — the conflation rule 7 exists to
     * prevent. Asserted from the HTTP surface, because that is the caller that
     * did not change. */
    const rows = await admin.query<{ origin: string }>(
      `SELECT s.origin FROM assignment_snapshots s
         JOIN schedule_versions v ON v.id = s.version_id
        WHERE v.organization_id = $1 AND s.origin <> 'clone'`,
      [multi().alpha.organizationId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every((row) => row.origin === 'manual')).toBe(true);
  });
});
