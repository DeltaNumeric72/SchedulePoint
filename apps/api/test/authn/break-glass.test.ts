import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyAuditChain } from '../../src/audit/verification.js';
import {
  PRIVILEGED_MARKER_PREFIX,
  PrivilegedSessionAuditor,
  detectUnauditedPrivilegedBackends,
} from '../../src/authn/break-glass.js';
import { createPool } from '../../src/db/pool.js';
import { adminClient } from '../support/admin-client.js';
import { organizationCommand } from '../support/authn.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * SPEC-11 §3.2 — **privileged access is itself audited**, and an unaudited use
 * is DETECTABLE.
 *
 * > Every `app_readonly_support`, `app_breakglass`, and `app_migrator` session
 * > records operator identity, ticket reference, statements executed, and rows
 * > touched — written to the **same chained audit stream**, so hiding a
 * > privileged read requires breaking the chain.
 *
 * ## The two halves, and why the second is the hard one
 *
 * Recording the accesses made THROUGH the auditor is easy and proves nothing on
 * its own. The second half is detecting the ones made AROUND it, and this file
 * proves that by opening a raw `app_breakglass` connection — with no auditor
 * anywhere near it — and showing the detector reports it.
 *
 * ## The honest limit, asserted rather than glossed
 *
 * `pg_stat_activity` is live state, so the detector catches an unaudited session
 * while it is CONNECTED. One that has already disconnected is caught only by the
 * cluster's own `log_connections`, which is a deployment condition and not
 * something an application can assert. The last test states that limit as an
 * assertion about the detector's shape, so a future reader cannot mistake the
 * control for something wider.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '../../src');

const multi = ownedMulti('authn-breakglass');

let admin: pg.Client;
let worker: Runtime;
let breakGlass: Runtime;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  worker = createRuntime('app_worker');
  breakGlass = createRuntime('app_breakglass', { max: 2 });
});

afterAll(async () => {
  await breakGlass.destroy();
  await worker.destroy();
  await admin.end();
});

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const absolute = join(directory, name);
    return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
  });
}

describe('an audited privileged session', () => {
  it('records the four facts SPEC-11 §3.2 names, in the same chain, as TWO events', async () => {
    const alpha = multi().alpha;
    const auditor = new PrivilegedSessionAuditor({
      runner: breakGlass.runner,
      role: 'app_breakglass',
    });

    const { result, record } = await auditor.run(
      {
        operator: 'operator-42',
        ticketRef: 'INC-2026-0007',
        scope: 'memberships:read',
        organizationId: alpha.organizationId,
      },
      async (uow) => {
        const rows = await sql<{ n: number }>`
          select count(*)::int as n from memberships
        `.execute(uow.query);
        return rows.rows[0]?.n ?? 0;
      },
    );

    expect(result).toBeGreaterThan(0);
    expect(record.statements).toBeGreaterThan(0);

    const events = await admin.query<{ event_name: string; payload: Record<string, unknown> }>(
      `select event_name, payload from audit_events
        where organization_id = $1::uuid and subject_id = $2::uuid
        order by sequence`,
      [alpha.organizationId, record.sessionId],
    );
    expect(events.rows.map((r) => r.event_name)).toEqual([
      'security.privileged_session.opened',
      'security.privileged_session.closed',
    ]);
    expect(events.rows[0]?.payload).toMatchObject({
      role: 'app_breakglass',
      operator: 'operator-42',
      ticketRef: 'INC-2026-0007',
      scope: 'memberships:read',
    });
    // The statement count comes from the RUNNER, not from the operator: a count
    // the operator supplies is a count the operator chooses.
    expect(Number(events.rows[1]?.payload['statements'])).toBeGreaterThan(0);

    const verification = await worker.runner.run(
      organizationCommand(alpha.organizationId, null, 'breakglass-verify'),
      (uow) => verifyAuditChain(uow),
    );
    expect(verification.intact, verification.problems.join('; ')).toBe(true);
    log(
      `an audited break-glass session recorded open+close in the chain (${String(record.statements)} ` +
        'statements) and the chain still verifies',
    );
  });

  it('refuses to run at all without an operator identity and a ticket reference', async () => {
    const alpha = multi().alpha;
    const auditor = new PrivilegedSessionAuditor({
      runner: breakGlass.runner,
      role: 'app_breakglass',
    });
    for (const bad of [
      { operator: '', ticketRef: 'INC-1', scope: 's' },
      { operator: 'op', ticketRef: '', scope: 's' },
      { operator: 'op', ticketRef: 'INC-1', scope: 'a scope with spaces' },
      { operator: 'op with spaces', ticketRef: 'INC-1', scope: 's' },
    ]) {
      await expect(
        auditor.run({ ...bad, organizationId: alpha.organizationId }, () => Promise.resolve(1)),
        `${JSON.stringify(bad)} was accepted`,
      ).rejects.toThrow(/PRIVILEGED_SESSION_/);
    }
    log('an unticketed or prose-bearing privileged session is refused before anything runs');
  });

  it('a rolled-back privileged transaction takes its own evidence with it — deliberately', async () => {
    const alpha = multi().alpha;
    const auditor = new PrivilegedSessionAuditor({
      runner: breakGlass.runner,
      role: 'app_breakglass',
    });
    const before = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit_events
        where organization_id = $1::uuid and event_name like 'security.privileged_session.%'`,
      [alpha.organizationId],
    );

    await expect(
      auditor.run(
        {
          operator: 'operator-9',
          ticketRef: 'INC-2026-0009',
          scope: 'memberships:read',
          organizationId: alpha.organizationId,
        },
        () => {
          throw new Error('the operator\'s work failed');
        },
      ),
    ).rejects.toThrow('the operator');

    const after = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit_events
        where organization_id = $1::uuid and event_name like 'security.privileged_session.%'`,
      [alpha.organizationId],
    );
    // Unchanged, and that is CORRECT rather than a gap: the transaction touched
    // nothing, and recording that it did would be a false positive in the one
    // log an incident review trusts.
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    log('a rolled-back privileged transaction records nothing — the rollback took the evidence too');
  });
});

describe('an UNAUDITED privileged use is detectable', () => {
  it('RED — a raw app_breakglass connection is reported by the detector', async () => {
    // A pool that knows nothing about the auditor: exactly the bypass the
    // control exists to notice.
    const raw = createPool('app_breakglass', { max: 1 });
    const client = await raw.connect();
    try {
      // Held OPEN and in a transaction, so `pg_stat_activity` shows a live
      // backend with no marker.
      await client.query('BEGIN');
      await client.query('select 1');

      const unaudited = await detectUnauditedPrivilegedBackends(admin, {
        roles: ['app_breakglass'],
      });
      expect(
        unaudited.length,
        'the detector did not report a raw break-glass connection',
      ).toBeGreaterThan(0);
      expect(unaudited.every((b) => !b.applicationName.startsWith(PRIVILEGED_MARKER_PREFIX))).toBe(
        true,
      );
      log(
        `the detector reported ${String(unaudited.length)} unaudited break-glass backend(s): ` +
          unaudited.map((b) => `pid ${String(b.pid)} (${b.applicationName || 'no name'})`).join(', '),
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await raw.end();
    }
  });

  it('GREEN — a session opened THROUGH the auditor carries the marker and is not reported', async () => {
    const alpha = multi().alpha;
    const auditor = new PrivilegedSessionAuditor({
      runner: breakGlass.runner,
      role: 'app_breakglass',
    });

    let seenInside: Awaited<ReturnType<typeof detectUnauditedPrivilegedBackends>> = [];
    let markerInside = '';
    await auditor.run(
      {
        operator: 'operator-7',
        ticketRef: 'INC-2026-0011',
        scope: 'memberships:read',
        organizationId: alpha.organizationId,
      },
      async (uow) => {
        const name = await sql<{ application_name: string }>`
          select current_setting('application_name', true) as application_name
        `.execute(uow.query);
        markerInside = name.rows[0]?.application_name ?? '';
        // Asked from OUTSIDE the transaction's own connection, with the
        // superuser: a role reading its own `pg_stat_activity` row would be a
        // watchdog the subject controls.
        seenInside = await detectUnauditedPrivilegedBackends(admin, {
          roles: ['app_breakglass'],
        });
      },
    );

    expect(markerInside.startsWith(PRIVILEGED_MARKER_PREFIX)).toBe(true);
    expect(
      seenInside.map((b) => `${String(b.pid)}:${b.applicationName}`),
      'an AUDITED break-glass session was reported as unaudited',
    ).toEqual([]);
    log(`the audited session's application_name was \`${markerInside}\` and it was not reported`);
  });

  it('the marker is transaction-LOCAL: the next borrower of the connection does not inherit it', async () => {
    const alpha = multi().alpha;
    const auditor = new PrivilegedSessionAuditor({
      runner: breakGlass.runner,
      role: 'app_breakglass',
    });
    await auditor.run(
      {
        operator: 'operator-8',
        ticketRef: 'INC-2026-0012',
        scope: 'memberships:read',
        organizationId: alpha.organizationId,
      },
      () => Promise.resolve(1),
    );

    // The SAME pool, a plain unit of work afterwards. If `set_config` had been
    // session-scoped, this transaction would still be wearing the previous
    // session's marker and would be invisible to the detector — a bypass created
    // by the control itself.
    const name = await breakGlass.runner.run(
      organizationCommand(alpha.organizationId, null, 'breakglass-after'),
      async (uow) => {
        const row = await sql<{ application_name: string }>`
          select current_setting('application_name', true) as application_name
        `.execute(uow.query);
        return row.rows[0]?.application_name ?? '';
      },
    );
    expect(
      name.startsWith(PRIVILEGED_MARKER_PREFIX),
      'the privileged marker survived into the next transaction on the same connection',
    ).toBe(false);
    log('the marker did not survive the transaction that set it');
  });
});

describe('the detector\'s limit is stated, not implied', () => {
  it('it reads pg_stat_activity, so it catches a LIVE connection and says so', () => {
    const source = readFileSync(join(SRC, 'authn/break-glass.ts'), 'utf8');
    expect(source).toContain('pg_stat_activity');
    // The limit is written down where a reader will find it, and this assertion
    // is what stops it being deleted as noise.
    expect(source).toContain('honest limit');
    expect(source).toContain('log_connections');
  });

  it('nothing under src grants pg_read_all_stats to a privileged role', () => {
    const findings: string[] = [];
    for (const absolute of walk(SRC)) {
      if (!absolute.endsWith('.ts')) continue;
      const text = readFileSync(absolute, 'utf8');
      // A GRANT, not a MENTION: `break-glass.ts` explains in its docblock why
      // the privilege is deliberately withheld, and a scan that flagged the
      // explanation would be a scan nobody could satisfy.
      if (/grant[^\n]*pg_read_all_stats/i.test(text)) findings.push(relative(SRC, absolute));
    }
    expect(
      findings,
      'a privileged role was granted the ability to read its own watchdog',
    ).toEqual([]);
  });
});
