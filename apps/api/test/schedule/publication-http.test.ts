import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type DeclaredCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantScheduleCapabilities } from '../support/schedule.js';

/**
 * The publication HTTP surface, over the real database (OPUS-M3-005).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## An ALLOW control comes first, every time
 *
 * FAD-15 vacuity discipline: a deny test whose subject does not exist denies for
 * the wrong reason and passes anyway. Every deny below is preceded by the SAME
 * request succeeding for an authorized actor against the same route and the same
 * body shape, so a 403 can only mean the capability gate.
 *
 * The deny actor is deliberately `groupOnly`, which holds the **scheduler role
 * in the same group** and differs from the allow actor in exactly one thing: it
 * has no `schedule.publish` grant. A deny proved with a `member` would also be
 * proving the role check, and would pass with the grant-only property broken.
 *
 * ## Every refusal is checked for what it did NOT do
 *
 * A compare-and-set that answered `409` after writing would look identical from
 * the status code alone. So each refusal below re-reads the version afterwards
 * and asserts it is still `approved`, still not current, and that no publication
 * record exists — the defect worth catching is the write, not the code.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const multi = ownedMulti('schedule-publication', {
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

/* ────────────────────────────────────────────────────────────────────────────
 * Building an approved draft through the real routes
 * ──────────────────────────────────────────────────────────────────────────── */

let nameCounter = 0;
function uniqueName(prefix: string): string {
  nameCounter += 1;
  return `${prefix} ${String(nameCounter)}`;
}

/**
 * Non-overlapping 2031+ windows.
 *
 * D-2 excludes overlapping periods per group and D-1b excludes overlapping
 * ASSIGNMENT intervals per membership across every period, so each test takes
 * its own month far from the 2027 fixture and from OPUS-M3-004's 2028 windows.
 */
let windowCounter = 0;
function freshWindow(): { startDate: string; endDate: string } {
  const index = windowCounter;
  windowCounter += 1;
  const year = 2031 + Math.floor(index / 12);
  const month = String((index % 12) + 1).padStart(2, '0');
  return { startDate: `${String(year)}-${month}-02`, endDate: `${String(year)}-${month}-20` };
}

interface Draft {
  readonly periodId: string;
  readonly periodName: string;
  readonly versionId: string;
  readonly startDate: string;
  readonly shiftTypeId: string;
}

function schedulerId(): string {
  return multi().alpha.users.scheduler.id;
}

/** The same GROUP and the same ROLE as the scheduler, with no publish grant. */
function ungrantedSchedulerId(): string {
  return multi().alpha.users.groupOnly.id;
}

async function createDraft(options: { assignees?: readonly string[] } = {}): Promise<Draft> {
  const scheduler = schedulerId();
  const window = freshWindow();
  const periodName = uniqueName('Publication window');

  const period = await call('POST', `${schedulePath()}/periods`, scheduler, {
    body: { name: periodName, ...window },
  });
  expect(period.statusCode, period.raw).toBe(200);
  const periodId = (period.body as { period: { id: string } }).period.id;

  const version = await call('POST', `${schedulePath()}/periods/${periodId}/versions`, scheduler, {
    body: {},
  });
  expect(version.statusCode, version.raw).toBe(200);
  const versionId = (version.body as { version: { id: string } }).version.id;

  const shiftTypeId = multi().catalogue?.alpha?.shiftTypeIds[0];
  if (shiftTypeId === undefined) throw new Error('the catalogue seed produced no shift type');

  const assignees = options.assignees ?? [multi().alpha.users.member.membershipId];
  for (const membershipId of assignees) {
    const grid = await call('GET', `${schedulePath()}/versions/${versionId}/grid`, scheduler);
    expect(grid.statusCode, grid.raw).toBe(200);
    const body = grid.body as {
      emptyCellRevision: string;
      cells: { date: string; shiftTypeId: string; revision: string }[];
    };
    const revision =
      body.cells.find((cell) => cell.date === window.startDate && cell.shiftTypeId === shiftTypeId)
        ?.revision ?? body.emptyCellRevision;

    const added = await call('POST', `${schedulePath()}/versions/${versionId}/assignments`, scheduler, {
      body: {
        date: window.startDate,
        shiftTypeId,
        membershipId,
        expectedCellRevision: revision,
      },
    });
    expect(added.statusCode, added.raw).toBe(200);
  }

  return { periodId, periodName, versionId, startDate: window.startDate, shiftTypeId };
}

/** Sign a version off to `approved` through the real route. */
async function approve(versionId: string, userId = schedulerId()): Promise<void> {
  for (const to of ['in_review', 'approved'] as const) {
    const moved = await call('POST', `${schedulePath()}/versions/${versionId}/state`, userId, {
      body: { to },
    });
    expect(moved.statusCode, moved.raw).toBe(200);
  }
}

interface ReviewBody {
  version: { id: string; state: string };
  period: { id: string; name: string };
  currentVersion: { id: string } | null;
  expectedPriorCurrentVersionId: string | null;
  reviewDigest: string;
  difference: {
    changes: { assignmentIdentityId: string; kind: string; toMembershipId: string | null }[];
    affectedMembershipIds: string[];
    affectedMembers: { membershipId: string; added: number }[];
  };
  blockers: { code: string }[];
  warnings: { code: string }[];
  canPublish: boolean;
  canRevert: boolean;
  frictionTier: string;
  confirmationPhrase: string;
}

async function readReview(versionId: string, userId = schedulerId()): Promise<ReviewBody> {
  const reply = await call(
    'GET',
    `${schedulePath()}/versions/${versionId}/publication-review`,
    userId,
  );
  expect(reply.statusCode, reply.raw).toBe(200);
  return reply.body as ReviewBody;
}

let keyCounter = 0;
function freshKey(label: string): string {
  keyCounter += 1;
  return `${label}-${String(keyCounter)}-${String(Date.now())}`.slice(0, 64);
}

function publishBody(review: ReviewBody, key: string, overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: key,
    expectedPriorCurrentVersionId: review.expectedPriorCurrentVersionId,
    expectedReviewDigest: review.reviewDigest,
    acknowledged: true,
    ...(review.frictionTier === 'type-to-confirm'
      ? { confirmationPhrase: review.confirmationPhrase }
      : {}),
    ...overrides,
  };
}

async function versionRow(versionId: string): Promise<{
  state: string;
  is_current: boolean;
  version_number: number | null;
}> {
  const result = await admin.query<{
    state: string;
    is_current: boolean;
    version_number: number | null;
  }>('select state, is_current, version_number from schedule_versions where id = $1', [versionId]);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no such version ${versionId}`);
  return row;
}

async function publicationRecordCount(periodId: string): Promise<number> {
  const result = await admin.query<{ count: string }>(
    'select count(*)::text as count from publication_records where period_id = $1',
    [periodId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function auditCount(versionId: string, eventName: string): Promise<number> {
  const result = await admin.query<{ count: string }>(
    'select count(*)::text as count from audit_events where subject_id = $1 and event_name = $2',
    [versionId, eventName],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function outboxCount(versionId: string): Promise<number> {
  const result = await admin.query<{ count: string }>(
    `select count(*)::text as count from outbox_events
      where payload ->> 'version' = $1 and kind = 'schedule.version.published'`,
    [versionId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/* ════════════════════════════════════════════════════════════════════════════
 * The review
 * ════════════════════════════════════════════════════════════════════════════ */

describe('publication review', () => {
  it('ALLOW: a scheduler reads the review of an approved draft and sees the difference', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);
    const review = await readReview(draft.versionId);

    expect(review.version.state).toBe('approved');
    expect(review.period.name).toBe(draft.periodName);
    expect(review.blockers).toEqual([]);
    // One assignment, on a period nothing has been published for: one `added`.
    expect(review.difference.changes).toHaveLength(1);
    expect(review.difference.changes[0]?.kind).toBe('added');
    expect(review.difference.affectedMembershipIds).toEqual([
      multi().alpha.users.member.membershipId,
    ]);
    expect(review.canPublish).toBe(true);
  });

  it('the confirmation phrase is the PERIOD NAME and the tier graduates on impact', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);
    const review = await readReview(draft.versionId);

    // Somebody IS affected, so the friction graduates even on a first publication.
    expect(review.frictionTier).toBe('type-to-confirm');
    expect(review.confirmationPhrase).toBe(draft.periodName);
  });

  it('an EMPTY first publication earns the lower tier — the graduation is real', async () => {
    const draft = await createDraft({ assignees: [] });
    await approve(draft.versionId);
    const review = await readReview(draft.versionId);

    expect(review.difference.affectedMembershipIds).toEqual([]);
    expect(review.frictionTier).toBe('acknowledge');
    expect(review.warnings.map((warning) => warning.code)).toContain('NO_ACTIVE_ASSIGNMENTS');
  });

  it('a version that is not approved is BLOCKED, naming the state', async () => {
    const draft = await createDraft();
    const review = await readReview(draft.versionId);
    expect(review.blockers.map((blocker) => blocker.code)).toEqual(['VERSION_NOT_APPROVED']);
  });

  it('DENY-STATE: a scheduler with no publish grant reads the review and is told so', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);

    // The ALLOW control: the same read, by the granted scheduler, is 200/true.
    expect((await readReview(draft.versionId)).canPublish).toBe(true);

    const denied = await readReview(draft.versionId, ungrantedSchedulerId());
    expect(denied.canPublish).toBe(false);
    expect(denied.canRevert).toBe(false);
    // …and they can still READ it: reviewing is `schedule.version.edit`, which
    // the role carries. A surface that 403'd here would hide the diff from the
    // person who authored it.
    expect(denied.difference.changes).toHaveLength(1);
  });

  it('cross-group: a version in another group is NOT FOUND, byte-identically to a made-up id', async () => {
    const sibling = multi().schedule?.sibling;
    if (sibling === undefined) throw new Error('the schedule seed did not run');

    const real = await call(
      'GET',
      `${schedulePath()}/versions/${sibling.currentVersionId}/publication-review`,
      schedulerId(),
    );
    const invented = await call(
      'GET',
      `${schedulePath()}/versions/00000000-0000-4000-8000-000000000000/publication-review`,
      schedulerId(),
    );

    expect(real.statusCode).toBe(404);
    expect(invented.statusCode).toBe(404);
    const strip = (raw: string): string => raw.replace(/"correlationId":"[^"]+"/, '"correlationId":"X"');
    expect(strip(real.raw)).toBe(strip(invented.raw));
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * Publishing
 * ════════════════════════════════════════════════════════════════════════════ */

describe('publication (schedule.publish — grant-only)', () => {
  it('ALLOW: the granted scheduler publishes, and the version becomes current', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);
    const review = await readReview(draft.versionId);

    const published = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/publication`,
      schedulerId(),
      { body: publishBody(review, freshKey('allow')) },
    );

    expect(published.statusCode, published.raw).toBe(200);
    expect(published.body).toMatchObject({
      replay: false,
      versionId: draft.versionId,
      versionNumber: 1,
      priorCurrentVersionId: null,
      affectedMembershipCount: 1,
      changeCount: 1,
    });
    expect(await versionRow(draft.versionId)).toMatchObject({
      state: 'published',
      is_current: true,
      version_number: 1,
    });
  });

  it('DENY: the same request from a scheduler WITHOUT the grant is refused and writes nothing', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);
    const review = await readReview(draft.versionId);
    const body = publishBody(review, freshKey('deny'));

    const denied = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/publication`,
      ungrantedSchedulerId(),
      { body },
    );
    expect(denied.statusCode, denied.raw).toBe(403);
    expect(await versionRow(draft.versionId)).toMatchObject({ state: 'approved', is_current: false });
    expect(await publicationRecordCount(draft.periodId)).toBe(0);

    // The ALLOW control, on the SAME body shape and the SAME route: the refusal
    // above can therefore only be the capability gate.
    const allowed = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/publication`,
      schedulerId(),
      { body },
    );
    expect(allowed.statusCode, allowed.raw).toBe(200);
  });

  it('the typed confirmation is enforced by the SERVER, not only by the browser', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);
    const review = await readReview(draft.versionId);
    expect(review.frictionTier).toBe('type-to-confirm');

    const omitted = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/publication`,
      schedulerId(),
      { body: publishBody(review, freshKey('friction'), { confirmationPhrase: undefined }) },
    );
    expect(omitted.statusCode, omitted.raw).toBe(422);
    expect(
      (omitted.body as { error: { problems: { field: string }[] } }).error.problems.map(
        (problem) => problem.field,
      ),
    ).toContain('confirmationPhrase');
    expect(await versionRow(draft.versionId)).toMatchObject({ state: 'approved' });

    const wrong = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/publication`,
      schedulerId(),
      { body: publishBody(review, freshKey('friction'), { confirmationPhrase: 'publish' }) },
    );
    expect(wrong.statusCode, wrong.raw).toBe(422);

    // The ALLOW control: the correct phrase, everything else identical.
    const right = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/publication`,
      schedulerId(),
      { body: publishBody(review, freshKey('friction')) },
    );
    expect(right.statusCode, right.raw).toBe(200);
  });

  it('a stale REVIEW is refused with the current digest, and nothing is published', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);
    const review = await readReview(draft.versionId);

    const stale = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/publication`,
      schedulerId(),
      {
        body: publishBody(review, freshKey('stale'), { expectedReviewDigest: 'f'.repeat(64) }),
      },
    );

    expect(stale.statusCode, stale.raw).toBe(409);
    expect(stale.body).toMatchObject({
      error: { code: 'STALE_REVIEW', currentReviewDigest: review.reviewDigest },
    });
    expect(await versionRow(draft.versionId)).toMatchObject({ state: 'approved', is_current: false });
    expect(await publicationRecordCount(draft.periodId)).toBe(0);
  });

  it('the compare-and-set loser is told which version is current, and nothing is published', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);
    const review = await readReview(draft.versionId);

    const moved = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/publication`,
      schedulerId(),
      {
        body: publishBody(review, freshKey('cas'), {
          // The caller believes something else is current. Nothing is.
          expectedPriorCurrentVersionId: multi().schedule?.groupOne.currentVersionId ?? null,
        }),
      },
    );

    expect(moved.statusCode, moved.raw).toBe(409);
    expect(moved.body).toMatchObject({
      // Both fields: the id the client compares on, and the NUMBER the surface
      // shows a human (review N3). Nothing is current here, so both are null.
      error: { code: 'CURRENT_VERSION_MOVED', currentVersionId: null, currentVersionNumber: null },
    });
    expect(await versionRow(draft.versionId)).toMatchObject({ state: 'approved', is_current: false });
    expect(await publicationRecordCount(draft.periodId)).toBe(0);
  });

  it('the CAS loser is named by NUMBER as well as by id when a version IS current', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);
    const first = await readReview(draft.versionId);
    expect(
      (
        await call('POST', `${schedulePath()}/versions/${draft.versionId}/publication`, schedulerId(), {
          body: publishBody(first, freshKey('n3v1')),
        })
      ).statusCode,
    ).toBe(200);

    // A second version in the same period, reviewed BEFORE the first published —
    // so its retained compare-and-set token is now stale, which is the race.
    const second = await call('POST', `${schedulePath()}/periods/${draft.periodId}/versions`, schedulerId(), {
      body: {},
    });
    const secondId = (second.body as { version: { id: string } }).version.id;
    await approve(secondId);
    const stale = await readReview(secondId);

    const moved = await call(
      'POST',
      `${schedulePath()}/versions/${secondId}/publication`,
      schedulerId(),
      {
        body: publishBody(stale, freshKey('n3v2'), { expectedPriorCurrentVersionId: null }),
      },
    );
    expect(moved.statusCode, moved.raw).toBe(409);
    expect(moved.body).toMatchObject({
      error: {
        code: 'CURRENT_VERSION_MOVED',
        currentVersionId: draft.versionId,
        // The readable half. Without it the panel can only print a uuid.
        currentVersionNumber: 1,
      },
    });
    expect(await versionRow(secondId)).toMatchObject({ state: 'approved', is_current: false });
  });

  it('PUBLISH ONCE: the same key twice replays — one record, one audit row, one outbox event', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);
    const review = await readReview(draft.versionId);
    const key = freshKey('replay');
    const body = publishBody(review, key);

    const first = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/publication`,
      schedulerId(),
      { body },
    );
    expect(first.statusCode, first.raw).toBe(200);
    expect(first.body).toMatchObject({ replay: false, versionNumber: 1 });

    // The RETRY. Identical body, including the compare-and-set the first
    // publication has now invalidated — which is exactly why the replay path has
    // to be read before the CAS.
    const second = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/publication`,
      schedulerId(),
      { body },
    );
    expect(second.statusCode, second.raw).toBe(200);
    expect(second.body).toMatchObject({
      replay: true,
      versionId: draft.versionId,
      versionNumber: 1,
      // Answered from the RECORD, not fabricated: the affected list was stored.
      affectedMembershipCount: 1,
    });

    expect(await publicationRecordCount(draft.periodId)).toBe(1);
    expect(await auditCount(draft.versionId, 'schedule.version.published')).toBe(1);
    expect(await outboxCount(draft.versionId)).toBe(1);
  });

  it('a FRESH key does not republish a published version — it is refused', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);
    const review = await readReview(draft.versionId);

    const first = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/publication`,
      schedulerId(),
      { body: publishBody(review, freshKey('fresh')) },
    );
    expect(first.statusCode, first.raw).toBe(200);

    // This is what a client that MINTED A NEW KEY per attempt would send. It is
    // refused rather than publishing a second time — the server-side half of the
    // property the client-side red case covers.
    const again = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/publication`,
      schedulerId(),
      { body: publishBody(review, freshKey('fresh')) },
    );
    expect(again.statusCode, again.raw).toBe(409);
    expect(await publicationRecordCount(draft.periodId)).toBe(1);
    expect(await auditCount(draft.versionId, 'schedule.version.published')).toBe(1);
  });

  it('ROLLBACK: a prerequisite that fails AFTER step 04 leaves the version approved, not publishing', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);
    const review = await readReview(draft.versionId);

    /* The state SPEC-05 §6 step 05 exists for: a hard breach that appears
     * BETWEEN approval and publication ("the world can change between clicking
     * publish and the transaction committing").
     *
     * It is inserted with the administrator client rather than through
     * `recordConflict`, and that is not a shortcut around a control: the service
     * is draft-only, and `transitionVersion` refuses to approve a version that
     * already has an open hard breach — so no code path that exists today can
     * produce "approved WITH an open hard breach". The recorder that will is
     * OPUS-M3-008's publication-time rule validation. Constructing the row
     * directly is the only way to exercise a refusal the publication transaction
     * genuinely performs.
     *
     * What this test is really about is the ROLLBACK. Step 04 writes
     * `state = 'publishing'` BEFORE step 05 checks this, so if the route mapped
     * the refusal inside its unit of work the runner would COMMIT the
     * `publishing` write and strand the version. Measured: with the period lock
     * removed so the frozen service's own compare-and-set could fire, the loser
     * of a race was left `publishing`. */
    await admin.query(
      `insert into schedule_conflicts
         (id, organization_id, group_id, version_id, severity, state, explanation)
       select gen_random_uuid(), organization_id, group_id, id, 'hard-breach', 'open',
              'constructed post-approval breach'
         from schedule_versions where id = $1`,
      [draft.versionId],
    );

    const blocked = await readReview(draft.versionId);
    expect(blocked.blockers.map((blocker) => blocker.code)).toEqual(['OPEN_HARD_BREACH']);

    const refused = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/publication`,
      schedulerId(),
      { body: publishBody(review, freshKey('breach')) },
    );
    expect(refused.statusCode, refused.raw).toBe(409);

    // The whole point: NOT `publishing`. A committed `publishing` row can only be
    // cleared by the reconciler and blocks every later attempt.
    expect(await versionRow(draft.versionId)).toMatchObject({
      state: 'approved',
      is_current: false,
      version_number: null,
    });
    expect(await publicationRecordCount(draft.periodId)).toBe(0);
    expect(await auditCount(draft.versionId, 'schedule.version.published')).toBe(0);
  });

  it('publishing twice in a period supersedes, and the superseded version is FROZEN', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);
    const firstReview = await readReview(draft.versionId);
    const first = await call(
      'POST',
      `${schedulePath()}/versions/${draft.versionId}/publication`,
      schedulerId(),
      { body: publishBody(firstReview, freshKey('v1')) },
    );
    expect(first.statusCode, first.raw).toBe(200);

    const cloned = await call('POST', `${schedulePath()}/versions/clone`, schedulerId(), {
      body: { sourceVersionId: draft.versionId },
    });
    expect(cloned.statusCode, cloned.raw).toBe(200);
    const secondId = (cloned.body as { version: { id: string } }).version.id;
    await approve(secondId);

    const secondReview = await readReview(secondId);
    expect(secondReview.expectedPriorCurrentVersionId).toBe(draft.versionId);

    const second = await call(
      'POST',
      `${schedulePath()}/versions/${secondId}/publication`,
      schedulerId(),
      { body: publishBody(secondReview, freshKey('v2')) },
    );
    expect(second.statusCode, second.raw).toBe(200);
    expect(second.body).toMatchObject({ versionNumber: 2, priorCurrentVersionId: draft.versionId });

    expect(await versionRow(draft.versionId)).toMatchObject({
      state: 'superseded',
      is_current: false,
    });

    // I-18 at the composed surface: the authoring route cannot edit either frozen
    // version. Both refusals are the service's `VERSION_NOT_EDITABLE`, mapped 409.
    for (const frozen of [draft.versionId, secondId]) {
      const grid = await call('GET', `${schedulePath()}/versions/${frozen}/grid`, schedulerId());
      expect(grid.statusCode, grid.raw).toBe(200);
      expect((grid.body as { version: { isEditable: boolean } }).version.isEditable).toBe(false);

      const edit = await call('POST', `${schedulePath()}/versions/${frozen}/assignments`, schedulerId(), {
        body: {
          date: draft.startDate,
          shiftTypeId: draft.shiftTypeId,
          membershipId: multi().alpha.users.scheduler.membershipId,
          expectedCellRevision: (grid.body as { cells: { revision: string }[]; emptyCellRevision: string })
            .emptyCellRevision,
        },
      });
      expect(edit.statusCode, edit.raw).toBe(409);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * Revert — by publishing FORWARD
 * ════════════════════════════════════════════════════════════════════════════ */

describe('revert (schedule.revert — grant-only, distinct from publish)', () => {
  it('DENY then ALLOW: revert needs its own grant, and reverting publishes forward', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);
    const v1Review = await readReview(draft.versionId);
    expect(
      (
        await call('POST', `${schedulePath()}/versions/${draft.versionId}/publication`, schedulerId(), {
          body: publishBody(v1Review, freshKey('rv1')),
        })
      ).statusCode,
    ).toBe(200);

    // V2: clone, remove the assignment, publish. Now V1 is superseded.
    const cloned = await call('POST', `${schedulePath()}/versions/clone`, schedulerId(), {
      body: { sourceVersionId: draft.versionId },
    });
    const v2 = (cloned.body as { version: { id: string } }).version.id;
    const grid = await call('GET', `${schedulePath()}/versions/${v2}/grid`, schedulerId());
    const cell = (grid.body as {
      cells: { date: string; shiftTypeId: string; revision: string; assignments: { assignmentIdentityId: string }[] }[];
    }).cells.find((row) => row.date === draft.startDate && row.shiftTypeId === draft.shiftTypeId);
    const identityId = cell?.assignments[0]?.assignmentIdentityId;
    if (identityId === undefined || cell === undefined) throw new Error('the clone lost its assignment');

    const removed = await call(
      'POST',
      `${schedulePath()}/versions/${v2}/assignments/${identityId}/removal`,
      schedulerId(),
      { body: { reason: 'removed so the revert has something to restore', expectedCellRevision: cell.revision } },
    );
    expect(removed.statusCode, removed.raw).toBe(200);
    await approve(v2);
    const v2Review = await readReview(v2);
    expect(
      (
        await call('POST', `${schedulePath()}/versions/${v2}/publication`, schedulerId(), {
          body: publishBody(v2Review, freshKey('rv2')),
        })
      ).statusCode,
    ).toBe(200);

    const revertBody = {
      revertToVersionId: draft.versionId,
      idempotencyKey: freshKey('revert'),
      expectedPriorCurrentVersionId: v2,
      acknowledged: true,
      confirmationPhrase: `revert ${draft.periodName}`,
    };

    // DENY first: the granted scheduler holds `schedule.publish` but NOT
    // `schedule.revert`, which is the whole point of them being distinct keys.
    const denied = await call('POST', `${schedulePath()}/periods/${draft.periodId}/revert`, schedulerId(), {
      body: revertBody,
    });
    expect(denied.statusCode, denied.raw).toBe(403);
    expect(await versionRow(v2)).toMatchObject({ state: 'published', is_current: true });

    // ALLOW: the same body, after the grant is written the way production writes it.
    await grantScheduleCapabilities(runtime.runner, multi(), {
      organizationId: multi().alpha.organizationId,
      groupId: multi().alpha.groupOne.id,
      membershipId: multi().alpha.users.scheduler.membershipId,
      capabilities: ['schedule.revert'],
    });

    const reverted = await call(
      'POST',
      `${schedulePath()}/periods/${draft.periodId}/revert`,
      schedulerId(),
      { body: revertBody },
    );
    expect(reverted.statusCode, reverted.raw).toBe(200);
    expect(reverted.body).toMatchObject({ replay: false, versionNumber: 3, priorCurrentVersionId: v2 });

    // Nothing was deleted: V1 and V2 are both still there, both frozen.
    expect(await versionRow(draft.versionId)).toMatchObject({ state: 'superseded' });
    expect(await versionRow(v2)).toMatchObject({ state: 'superseded', is_current: false });

    // The revert RESTORED the content: the new current version has the
    // assignment V2 removed, under the SAME assignment identity.
    const history = await call('GET', `${schedulePath()}/periods/${draft.periodId}/history`, schedulerId());
    const currentId = (history.body as { currentVersionId: string }).currentVersionId;
    const restored = await call('GET', `${schedulePath()}/versions/${currentId}/grid`, schedulerId());
    const restoredCell = (restored.body as {
      cells: { date: string; assignments: { assignmentIdentityId: string }[] }[];
    }).cells.find((row) => row.date === draft.startDate);
    expect(restoredCell?.assignments.map((a) => a.assignmentIdentityId)).toEqual([identityId]);

    // The RETRY does not clone a second draft and does not publish again.
    const versionsBefore = await admin.query<{ count: string }>(
      'select count(*)::text as count from schedule_versions where period_id = $1',
      [draft.periodId],
    );
    const replayed = await call(
      'POST',
      `${schedulePath()}/periods/${draft.periodId}/revert`,
      schedulerId(),
      { body: revertBody },
    );
    expect(replayed.statusCode, replayed.raw).toBe(200);
    expect(replayed.body).toMatchObject({ replay: true, versionNumber: 3 });
    const versionsAfter = await admin.query<{ count: string }>(
      'select count(*)::text as count from schedule_versions where period_id = $1',
      [draft.periodId],
    );
    expect(versionsAfter.rows[0]?.count).toBe(versionsBefore.rows[0]?.count);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * The reads
 * ════════════════════════════════════════════════════════════════════════════ */

describe('history, comparison, published schedule and publication records', () => {
  it('history marks published and superseded rows immutable and drafts not', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);
    const review = await readReview(draft.versionId);
    await call('POST', `${schedulePath()}/versions/${draft.versionId}/publication`, schedulerId(), {
      body: publishBody(review, freshKey('hist')),
    });
    const extra = await call('POST', `${schedulePath()}/periods/${draft.periodId}/versions`, schedulerId(), {
      body: {},
    });
    expect(extra.statusCode, extra.raw).toBe(200);

    const history = await call('GET', `${schedulePath()}/periods/${draft.periodId}/history`, schedulerId());
    expect(history.statusCode, history.raw).toBe(200);
    const body = history.body as {
      versions: { id: string; state: string; isImmutable: boolean; publishedByDisplayName: string | null }[];
      currentVersionId: string;
      canPublish: boolean;
    };

    expect(body.currentVersionId).toBe(draft.versionId);
    expect(body.canPublish).toBe(true);
    const published = body.versions.find((version) => version.id === draft.versionId);
    expect(published).toMatchObject({ state: 'published', isImmutable: true });
    expect(published?.publishedByDisplayName).toBe('Alpha Scheduler (synthetic)');
    const stillDraft = body.versions.find(
      (version) => version.id === (extra.body as { version: { id: string } }).version.id,
    );
    expect(stillDraft).toMatchObject({ state: 'draft', isImmutable: false });
  });

  it('the published schedule reads the CURRENT version and nothing else', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);
    const review = await readReview(draft.versionId);
    await call('POST', `${schedulePath()}/versions/${draft.versionId}/publication`, schedulerId(), {
      body: publishBody(review, freshKey('pub')),
    });

    const published = await call('GET', `${schedulePath()}/periods/${draft.periodId}/published`, schedulerId());
    expect(published.statusCode, published.raw).toBe(200);
    const body = published.body as {
      version: { id: string; versionNumber: number } | null;
      assignments: { membershipId: string; displayName: string | null; date: string }[];
    };
    expect(body.version).toMatchObject({ id: draft.versionId, versionNumber: 1 });
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0]).toMatchObject({
      membershipId: multi().alpha.users.member.membershipId,
      displayName: 'Alpha Member (synthetic)',
      date: draft.startDate,
    });
  });

  it('an unpublished period reads as EMPTY, not as an error', async () => {
    const draft = await createDraft();
    const published = await call('GET', `${schedulePath()}/periods/${draft.periodId}/published`, schedulerId());
    expect(published.statusCode, published.raw).toBe(200);
    expect((published.body as { version: unknown }).version).toBeNull();
    expect((published.body as { assignments: unknown[] }).assignments).toEqual([]);

    const records = await call(
      'GET',
      `${schedulePath()}/periods/${draft.periodId}/publication-records`,
      schedulerId(),
    );
    expect(records.statusCode, records.raw).toBe(200);
    expect((records.body as { records: unknown[] }).records).toEqual([]);
  });

  it('the publication record names who published, when, and how many were affected', async () => {
    const draft = await createDraft();
    await approve(draft.versionId);
    const review = await readReview(draft.versionId);
    await call('POST', `${schedulePath()}/versions/${draft.versionId}/publication`, schedulerId(), {
      body: publishBody(review, freshKey('rec')),
    });

    const records = await call(
      'GET',
      `${schedulePath()}/periods/${draft.periodId}/publication-records`,
      schedulerId(),
    );
    expect(records.statusCode, records.raw).toBe(200);
    const rows = (records.body as {
      records: {
        versionId: string;
        versionNumber: number | null;
        outcome: string;
        actorDisplayName: string | null;
        affectedCount: number | null;
      }[];
    }).records;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      versionId: draft.versionId,
      versionNumber: 1,
      outcome: 'published',
      actorDisplayName: 'Alpha Scheduler (synthetic)',
      affectedCount: 1,
    });
    // The idempotency key is deliberately NOT on the wire.
    expect(records.raw).not.toContain('idempotencyKey');
  });

  it('comparison defaults to the version this one SUPERSEDED, and affected-staff agrees with it', async () => {
    const seeded = multi().schedule?.groupOne;
    if (seeded === undefined) throw new Error('the schedule seed did not run');

    const comparison = await call(
      'GET',
      `${schedulePath()}/versions/${seeded.currentVersionId}/comparison`,
      schedulerId(),
    );
    expect(comparison.statusCode, comparison.raw).toBe(200);
    const body = comparison.body as {
      fromVersion: { id: string } | null;
      toVersion: { id: string };
      difference: { changes: { kind: string }[]; affectedMembers: { membershipId: string }[] };
    };
    expect(body.fromVersion?.id).toBe(seeded.firstVersionId);
    expect(body.toVersion.id).toBe(seeded.currentVersionId);
    // The seed reassigns one identity between V1 and V2.
    expect(body.difference.changes.map((change) => change.kind)).toEqual(['reassigned']);

    const affected = await call(
      'GET',
      `${schedulePath()}/versions/${seeded.currentVersionId}/affected-staff`,
      schedulerId(),
    );
    expect(affected.statusCode, affected.raw).toBe(200);
    const affectedBody = affected.body as {
      fromVersionId: string;
      changeCount: number;
      affectedMembers: { membershipId: string; reassignedAway: number; reassignedTo: number }[];
    };
    expect(affectedBody.fromVersionId).toBe(seeded.firstVersionId);
    expect(affectedBody.changeCount).toBe(1);
    // BOTH sides of the move are affected — the union, not the after-side.
    expect(affectedBody.affectedMembers).toHaveLength(2);
    expect(affectedBody.affectedMembers.map((member) => member.membershipId).sort()).toEqual(
      body.difference.affectedMembers.map((member) => member.membershipId).sort(),
    );
  });

  it('an explicit comparison against a version in ANOTHER period is not found', async () => {
    const seeded = multi().schedule?.groupOne;
    const other = await createDraft();
    if (seeded === undefined) throw new Error('the schedule seed did not run');

    const reply = await call(
      'GET',
      `${schedulePath()}/versions/${seeded.currentVersionId}/comparison?againstVersionId=${other.versionId}`,
      schedulerId(),
    );
    expect(reply.statusCode, reply.raw).toBe(404);
  });
});
