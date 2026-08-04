import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recordAuditEvent } from '../../src/audit/recorder.js';
import { CONTEXT_PROBE_TOUCH_JOB, defaultJobHandlers } from '../../src/jobs/handlers.js';
import { executeJob } from '../../src/jobs/worker.js';
import { adminClient } from '../support/admin-client.js';
import {
  WRITE_DETECTORS,
  scanForMutations,
  unauditedMutations,
} from '../support/audit-emission-scan.js';
import { groupContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { buildHttpHarness, contextHeaders, currentCounters, type HttpHarness } from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * FAD-15 Layer 2 — this file owns its tenant.
 *
 * It used to write to the shared MULTI baseline, which every other file also read.
 * NR-13 measured what that cost: six order-dependent tests across five files, and
 * eleven of twenty-four files modifying rows the shared seed created. The fixture
 * below has the same shape and fresh identifiers, and RLS — not agreement — is what
 * keeps it out of everybody else's queries.
 */
const multi = ownedMulti('audit-emission-coverage');


/**
 * **Emission coverage — every mutation that exists today writes an audit row,
 * and writes it in the same transaction as the change.**
 *
 * ## The two questions, and why the second is the hard one
 *
 * "Does the mutation emit?" is easy to test and easy to satisfy. "Does it emit
 * **atomically**?" is the one that matters, because an audit write in its own
 * transaction produces a log that is *usually* right — right until the moment
 * something goes wrong, which is the only moment anybody reads it. FAD-12 makes
 * the atomicity normative; the third test below is the proof, and it works by
 * making the mutation fail *after* the audit call and asserting that **neither**
 * survives.
 *
 * ## Coverage is enumerated from the CODE, not from a list
 *
 * The tests below walk the mutating surfaces this milestone ships and assert
 * each one emitted: the HTTP context-probe touch and its job twin here,
 * OPUS-M1-002's three authorization mutations in
 * `apps/api/test/authz/http-authorization.test.ts` (they joined at OPUS-M1-004,
 * FAD-13 item 2).
 *
 * **A list of surfaces is only as good as somebody's memory of it**, so the last
 * describe block does not use one: it scans every route module and job handler
 * for a write and asserts that each module that writes also records. A fourth
 * mutation added without an audit call fails there, not at review.
 */

/** Lazy: the owned fixture does not exist until `beforeAll` has run. */
const alpha = () => multi().alpha;
let http: HttpHarness;
let worker: Runtime;
let admin: pg.Client;

const groupOnePath = () => `/organizations/${alpha().organizationId}/groups/${alpha().groupOne.id}/context-probe/touch`;

beforeAll(async () => {
  http = await buildHttpHarness();
  worker = createRuntime('app_worker');
  admin = adminClient();
  await admin.connect();
});

afterAll(async () => {
  await http.close();
  await worker.destroy();
  await admin.end();
});

/** Audit rows for a correlation id, read from ground truth. */
async function auditRowsFor(correlationId: string) {
  const { rows } = await admin.query<{
    event_name: string;
    actor_kind: string;
    actor_membership_id: string | null;
    group_id: string | null;
    subject_type: string;
    subject_id: string;
    sequence: string;
  }>(
    // `order by audit_events.sequence`, QUALIFIED, and that is the whole point:
    // PostgreSQL resolves an unqualified `ORDER BY` to the OUTPUT column when one
    // carries that name, so `order by sequence` would have sorted the bigint as
    // the `::text` alias — `'9'` above `'14'`, correct for the first nine events
    // of a chain and wrong from the tenth. Found by rotating seed 531651
    // (OPUS-M2-003; `docs/evidence/EV-M2-PROFILES/INDEX.md` §4.4), fixed as a
    // class here. A qualified reference cannot resolve to an output column.
    `select event_name, actor_kind, actor_membership_id::text as actor_membership_id,
            group_id::text as group_id, subject_type, subject_id::text as subject_id,
            sequence::text as sequence
       from audit_events where correlation_id = $1 order by audit_events.sequence`,
    [correlationId],
  );
  return rows;
}

describe('every existing mutation emits an audit event', () => {
  it('the HTTP mutation emits one, attributed to the acting membership and the declared group', async () => {
    const correlationId = 'emit-http-1';
    const counters = await currentCounters(admin, {
      organizationId: alpha().organizationId,
      groupId: alpha().groupOne.id,
      userId: alpha().users.scheduler.id,
    });

    const response = await http.app.inject({
      method: 'POST',
      url: groupOnePath(),
      headers: contextHeaders(alpha().users.scheduler.id, counters, correlationId),
    });
    expect(response.statusCode).toBe(200);

    const rows = await auditRowsFor(correlationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_name).toBe('membership.activity_touched');
    expect(rows[0]?.actor_kind).toBe('membership');
    expect(rows[0]?.actor_membership_id).toBe(alpha().users.scheduler.membershipId);
    expect(rows[0]?.group_id, 'attributed to the DECLARED group').toBe(alpha().groupOne.id);
    expect(rows[0]?.subject_id).toBe(alpha().users.scheduler.membershipId);
    log(
      `HTTP touch → audit sequence ${String(rows[0]?.sequence)}, ` +
        `${String(rows[0]?.event_name)}, actor ${String(rows[0]?.actor_membership_id)}`,
    );
  });

  it('the JOB surface emits the SAME event against the SAME subject (SPEC-06 §7)', async () => {
    const correlationId = 'emit-job-1';
    const outcome = await executeJob(
      worker.runner,
      {
        id: 'aaaaaaaa-0000-4000-8000-00000000job1',
        kind: CONTEXT_PROBE_TOUCH_JOB,
        context: {
          actionScope: 'group',
          expectedOrganizationId: alpha().organizationId,
          expectedGroupId: alpha().groupOne.id,
          membershipId: alpha().users.scheduler.membershipId,
          principalUserId: alpha().users.scheduler.id,
          systemActor: false,
          correlationId,
          authorizationVersionAtEnqueue: 'irrelevant-here',
        },
        args: {},
        enqueuedAt: new Date().toISOString(),
      },
      defaultJobHandlers(),
    );
    expect(outcome.status).toBe('completed');

    const rows = await auditRowsFor(correlationId);
    expect(rows).toHaveLength(1);
    // The identical assertion set as the HTTP case above. If the two surfaces
    // ever diverge in what they audit, one of these two tests fails.
    expect(rows[0]?.event_name).toBe('membership.activity_touched');
    expect(rows[0]?.actor_kind).toBe('membership');
    expect(rows[0]?.actor_membership_id).toBe(alpha().users.scheduler.membershipId);
    expect(rows[0]?.group_id).toBe(alpha().groupOne.id);
    expect(rows[0]?.subject_id).toBe(alpha().users.scheduler.membershipId);
    log('job touch → the same event name, actor, group and subject as the HTTP surface');
  });

  it('a mutation that FAILS emits nothing — the audit write is in the same transaction (FAD-12)', async () => {
    const correlationId = 'emit-rollback-1';
    const runtime = createRuntime('app_runtime');
    try {
      await expect(
        runtime.runner.run(
          groupContext(
            alpha().organizationId,
            alpha().groupOne.id,
            alpha().users.scheduler.membershipId,
            correlationId,
          ),
          async (uow) => {
            // The shape of a real mutation: write, audit, and then discover the
            // change was invalid. The order matters — the audit call has already
            // succeeded and its row already exists on this connection.
            await sql`
              update memberships set last_active_at = now()
               where id = ${alpha().users.scheduler.membershipId}::uuid
            `.execute(uow.query);

            const recorded = await recordAuditEvent(uow, {
              eventName: 'membership.activity_touched',
              subjectType: 'membership',
              subjectId: alpha().users.scheduler.membershipId,
            });
            expect(recorded.sequence, 'the audit row exists inside the transaction').toMatch(
              /^\d+$/,
            );

            // Self-visible: the row is really there, on this connection, now.
            const visible = await sql<{ n: string }>`
              select count(*)::text as n from audit_events where correlation_id = ${correlationId}
            `.execute(uow.query);
            expect(Number(visible.rows[0]?.n)).toBe(1);

            throw new Error('the mutation turned out to be invalid (synthetic)');
          },
        ),
      ).rejects.toThrow('synthetic');
    } finally {
      await runtime.destroy();
    }

    expect(
      await auditRowsFor(correlationId),
      'a rolled-back mutation leaves NO audit row',
    ).toEqual([]);
    log('a failed mutation leaves 0 audit rows: the audit write shares its transaction');
  });

  it('the chain does not skip a sequence when a transaction rolls back', async () => {
    // A rolled-back append still advanced `audit_chain_heads` inside its
    // transaction — and the rollback took that with it. If the head were
    // maintained outside the transaction (a sequence, an advisory counter, an
    // application-side cache), the chain would develop a permanent gap every
    // time a mutation failed, and chain verification would alarm on ordinary
    // application errors. Asserting it directly, because the failure mode is
    // silent until the first rollback in production.
    const before = await admin.query<{ n: string }>(
      'select coalesce(max(sequence), 0)::text as n from audit_events where organization_id = $1::uuid',
      [alpha().organizationId],
    );

    const runtime = createRuntime('app_runtime');
    try {
      await expect(
        runtime.runner.run(
          groupContext(
            alpha().organizationId,
            alpha().groupOne.id,
            alpha().users.scheduler.membershipId,
            'emit-rollback-2',
          ),
          async (uow) => {
            await recordAuditEvent(uow, {
              eventName: 'membership.activity_touched',
              subjectType: 'membership',
              subjectId: alpha().users.scheduler.membershipId,
            });
            throw new Error('rolled back (synthetic)');
          },
        ),
      ).rejects.toThrow('synthetic');

      const after = await runtime.runner.run(
        groupContext(
          alpha().organizationId,
          alpha().groupOne.id,
          alpha().users.scheduler.membershipId,
          'emit-rollback-3',
        ),
        (uow) =>
          recordAuditEvent(uow, {
            eventName: 'membership.activity_touched',
            subjectType: 'membership',
            subjectId: alpha().users.scheduler.membershipId,
          }),
      );
      expect(
        Number(after.sequence),
        'the next successful append takes the sequence the rolled-back one released',
      ).toBe(Number(before.rows[0]?.n) + 1);
    } finally {
      await runtime.destroy();
    }
    log('a rolled-back append leaves no gap: the chain head is transactional too');
  });

  it('an actor-less draft is REFUSED rather than attributed to nobody', async () => {
    const runtime = createRuntime('app_runtime');
    try {
      await expect(
        runtime.runner.run(
          // A context with no acting membership, and a draft that did not say
          // it was a system action.
          groupContext(alpha().organizationId, alpha().groupOne.id, null, 'emit-no-actor'),
          (uow) =>
            recordAuditEvent(uow, {
              eventName: 'membership.activity_touched',
              subjectType: 'membership',
              subjectId: alpha().users.scheduler.membershipId,
            }),
        ),
      ).rejects.toThrow('AUDIT_ACTOR_UNRESOLVED');
    } finally {
      await runtime.destroy();
    }
    log('"nobody was acting" and "we failed to resolve the actor" are kept distinguishable');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The coverage gate itself
 * ──────────────────────────────────────────────────────────────────────────── */

describe('OPUS-M1-004 — every module that WRITES also records', () => {
  /**
   * `profiles` joins the scanned roots at OPUS-M2-003.
   *
   * Its routes are thin: the writes live in `src/profiles/*.ts` services, which
   * the route handlers call inside the caller's unit of work. Without the prefix
   * the scan would look at `http/routes/profiles.route.ts`, see no
   * `insertInto`, find nothing to check, and report full coverage for a surface
   * whose every mutation it never examined — the exact vacuous-pass shape this
   * gate exists to prevent, arriving through a refactor rather than through a
   * missing call.
   *
   * The prefix-liveness assertion further down requires each root to contain at
   * least one mutating module, so a `profiles` directory that stopped writing
   * would fail here rather than silently widen the scan for nothing.
   */
  const MUTATING_ROOTS = ['http/routes', 'jobs', 'profiles'] as const;
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

  it('no route module or job handler writes without calling recordAuditEvent', () => {
    const modules = scanForMutations(SRC, { subdirectories: MUTATING_ROOTS });

    // A vacuous pass is the failure mode: if the scan matched nothing, it would
    // report success for a system that audits nothing at all.
    expect(modules.length, 'the write scan found no mutating module — it is broken').toBeGreaterThan(
      1,
    );

    const silent = unauditedMutations(modules).map((m) => `${m.file} (${m.writes.join(', ')})`);
    expect(silent, `these modules mutate and record nothing:\n${silent.join('\n')}`).toEqual([]);

    log(
      `${String(modules.length)} mutating modules scanned, ${String(modules.length)} record: ` +
        modules.map((m) => m.file).join(', '),
    );
  });

  /* ────────────────────────────────────────────────────────────────────────
   * T-01 — the red case the gate above did not have
   *
   * The second review's finding, and it is the same class as R-02 against
   * OPUS-M1-003: the detector was probed by hand and found correct, but nothing
   * in the suite proved it could FAIL. A scanner observed only passing is not
   * evidence — the failure modes (a typo in a pattern, a prefix matching no
   * directory, a walk over the wrong path) all report "0 unaudited" forever.
   *
   * So the scanner moved to `test/support/audit-emission-scan.ts`, exported,
   * and these cases run **it** — not a copy of its rules — against fixtures on
   * disk. Narrow a pattern and these go red.
   * ──────────────────────────────────────────────────────────────────────── */

  const scratchDirs: string[] = [];
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-emission-'));
    scratchDirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('RED: a module that mutates and records nothing is reported', () => {
    const dir = scratch();
    writeFileSync(
      join(dir, 'silent.route.ts'),
      [
        "import type { Kysely } from 'kysely';",
        '',
        'export async function touch(query: Kysely<never>, id: string) {',
        "  await query.updateTable('memberships').set({ last_active_at: new Date() })",
        "    .where('id', '=', id).execute();",
        '  // and nothing else. No audit row. This is the defect.',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const findings = unauditedMutations(scanForMutations(dir));
    expect(findings.map((f) => f.file), 'the scanner missed an unaudited mutation').toEqual([
      'silent.route.ts',
    ]);
    log(`red case: ${String(findings[0]?.writes.length)} write form(s), 0 audit calls — reported`);
  });

  it('GREEN: the same module with the one-line call is not reported', () => {
    // Both directions in one file. A scanner that always reported a finding
    // would satisfy the red case above and be equally useless.
    const dir = scratch();
    writeFileSync(
      join(dir, 'audited.route.ts'),
      [
        'export async function touch(uow: never, query: never, id: string) {',
        "  await query.updateTable('memberships').set({ x: 1 }).where('id', '=', id).execute();",
        "  await recordAuditEvent(uow, { eventName: 'membership.activity_touched',",
        "    subjectType: 'membership', subjectId: id });",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    expect(unauditedMutations(scanForMutations(dir))).toEqual([]);
  });

  it('RED: every write detector fires on its OWN fixture', () => {
    // Six fixtures rather than one. With a single combined fixture a broken
    // alternative is carried by the other five and the red case still passes —
    // which is precisely how a decorative check survives review.
    const cases: readonly { readonly id: string; readonly source: string }[] = [
      { id: 'kysely-insert', source: "export const f = (q) => q.insertInto('memberships');\n" },
      { id: 'kysely-update', source: "export const f = (q) => q.updateTable('memberships');\n" },
      { id: 'kysely-delete', source: "export const f = (q) => q.deleteFrom('memberships');\n" },
      { id: 'sql-insert', source: 'export const s = `insert into memberships (id) values (1)`;\n' },
      { id: 'sql-update', source: 'export const s = `update memberships set x = 1`;\n' },
      { id: 'sql-delete', source: 'export const s = `delete from memberships where id = 1`;\n' },
    ];
    expect(cases.length, 'a detector has no fixture').toBe(WRITE_DETECTORS.length);

    for (const testCase of cases) {
      const detector = WRITE_DETECTORS.find((d) => d.id === testCase.id);
      expect(detector, `${testCase.id} is not a declared detector`).toBeDefined();

      const dir = scratch();
      writeFileSync(join(dir, `${testCase.id}.ts`), testCase.source, 'utf8');
      const found = scanForMutations(dir);
      expect(found, `${testCase.id}: the detector did not fire at all`).toHaveLength(1);
      expect(found[0]?.writes, `${testCase.id}: fired as the wrong detector`).toEqual([
        detector?.label,
      ]);
      expect(unauditedMutations(found), `${testCase.id}: fired but was not reported`).toHaveLength(
        1,
      );
    }
    log(`all ${String(WRITE_DETECTORS.length)} write detectors fire independently`);
  });

  it('GREEN: a read-only module is not a mutation, and a comment about one is not either', () => {
    const dir = scratch();
    writeFileSync(
      join(dir, 'reader.ts'),
      [
        '/**',
        ' * This module could updateTable(\'memberships\') and insert into audit_events,',
        ' * but it is a docblock and the scan is about code.',
        ' */',
        "// await query.deleteFrom('memberships').execute();",
        "export const f = (q) => q.selectFrom('memberships').selectAll();",
        '',
      ].join('\n'),
      'utf8',
    );
    expect(scanForMutations(dir), 'a comment or a SELECT was read as a write').toEqual([]);
  });

  it('the subdirectory filter is not silently matching nothing', () => {
    // The quietest failure available: a prefix that matches no directory makes
    // the production check scan zero files and pass. Asserted directly, because
    // the non-vacuity floor above would also catch it only by accident.
    for (const prefix of MUTATING_ROOTS) {
      expect(
        scanForMutations(SRC, { subdirectories: [prefix] }).length,
        `no mutating module found under src/${prefix} — the prefix matches nothing`,
      ).toBeGreaterThan(0);
    }
    expect(scanForMutations(SRC, { subdirectories: ['no/such/dir'] })).toEqual([]);
  });

  it('every audit event name the routes export is in the closed vocabulary', async () => {
    const { AUDIT_EVENTS } = await import('../../src/http/routes/authorization.route.js');
    const { AUDIT_EVENT_NAMES } = await import('@schedulepoint/domain');
    for (const name of Object.values(AUDIT_EVENTS)) {
      expect(AUDIT_EVENT_NAMES as readonly string[]).toContain(name);
    }
    // Rule 13 in the direction that matters: the list only grows. The three
    // OPUS-M1-002 names are in it, and the nine that were there before still are.
    expect(AUDIT_EVENT_NAMES.length).toBeGreaterThanOrEqual(12);
  });
});
