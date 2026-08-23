import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';
import { seedBuildFixture, type BuildFixture } from '../support/builds.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type DeclaredCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * REV-B PROBE — I-17 / non-bypass rule 9: "never log delivery material or
 * payload bodies. Not in logs, errors, traces, queues, audit payloads, or
 * backups."
 *
 * The repository proves this for AUTHN SECRET MATERIAL
 * (`apps/api/test/authn/secrecy.test.ts`) and it proves audit payloads are
 * closed (`apps/api/test/audit/payload-closedness.test.ts`). It does not, as far
 * as REV-B could find, prove it for an ORDINARY REQUEST BODY VALUE — the class
 * rule 9 names first. This probe drives a distinctive marker string through six
 * positions of the wire (body field, body id field, query string, path segment,
 * header, and a malformed body) and then reads every line the server's own
 * logger wrote.
 *
 * It is a MEASUREMENT, not a repair, and it carries its own falsifiability
 * control: the same hunt must FIND a needle deliberately written to the same
 * logger, or "not found" means nothing.
 *
 * This file is a REV-B probe. It is copied into `apps/api/test/` to run and
 * removed afterwards; the tree is restored byte-identically. Its permanent home
 * is `docs/evidence/EV-REVIEW-B/probes/`.
 */

const multi = ownedMulti('revb-privacy', {
  profile: 'full',
  seed: { catalogue: ['alpha'], schedule: true, scheduleCredentials: true },
});

const MARKER = `REVB-MARKER-${randomUUID().replace(/-/g, '')}`;

let harness: HttpHarness;
let runtime: Runtime;
let admin: pg.Client;
let fixture: BuildFixture;

beforeAll(async () => {
  harness = await buildHttpHarness();
  runtime = createRuntime('app_runtime', { max: 3 });
  admin = adminClient();
  await admin.connect();

  const alpha = multi().alpha;
  const shiftTypeId = multi.catalogue('alpha').shiftTypeIds[1];
  if (shiftTypeId === undefined) throw new Error('no shift type');

  fixture = await seedBuildFixture(runtime.runner, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    userId: alpha.users.scheduler.id,
    shiftTypeId,
    label: 'revb',
    startDate: '2047-04-01',
    endDate: '2047-04-07',
  });
}, 240_000);

afterAll(async () => {
  await harness?.close();
  await runtime?.destroy();
  await admin?.end();
});

function buildsPath(groupId?: string): string {
  const alpha = multi().alpha;
  return `/organizations/${alpha.organizationId}/groups/${groupId ?? alpha.groupOne.id}/builds`;
}

async function countersFor(userId: string): Promise<DeclaredCounters> {
  const alpha = multi().alpha;
  return currentCounters(admin, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    userId,
  });
}

interface Sent {
  readonly label: string;
  readonly statusCode: number;
  readonly raw: string;
}

const sent: Sent[] = [];

async function send(
  label: string,
  method: 'GET' | 'POST',
  url: string,
  options: { body?: unknown; extraHeaders?: Record<string, string> } = {},
): Promise<Sent> {
  const userId = multi().alpha.users.scheduler.id;
  const response = await harness.app.inject({
    method,
    url,
    headers: {
      ...contextHeaders(userId, await countersFor(userId)),
      'content-type': 'application/json',
      ...(options.extraHeaders ?? {}),
    },
    ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
  });
  const row = { label, statusCode: response.statusCode, raw: response.body };
  sent.push(row);
  return row;
}

describe('REV-B: an ordinary request-body value never reaches the log', () => {
  it('drives the marker through six wire positions and reads every log line', async () => {
    harness.clearLogs();

    // 1. An ACCEPTED write whose body carries the marker as a free-ish text field.
    await send('accepted-body-name', 'POST', `${buildsPath()}/configurations`, {
      body: { periodId: fixture.periodId, name: `${MARKER} accepted` },
    });
    // 2. A REFUSED write: the marker where a uuid belongs.
    await send('refused-body-id', 'POST', `${buildsPath()}/configurations`, {
      body: { periodId: MARKER, name: 'refused' },
    });
    // 3. A malformed body: the marker in an unknown key.
    await send('refused-unknown-key', 'POST', `${buildsPath()}/configurations`, {
      body: { periodId: fixture.periodId, name: 'x', [MARKER]: MARKER },
    });
    // 4. The marker in the QUERY STRING.
    await send('query-string', 'GET', `${buildsPath()}/runs?periodId=${MARKER}`);
    // 5. The marker in a PATH SEGMENT (a group id that is not a uuid).
    await send('path-segment', 'GET', `${buildsPath(MARKER)}/runs?periodId=${fixture.periodId}`);
    // 6. The marker in a request HEADER the server does not know.
    await send('unknown-header', 'GET', `${buildsPath()}/runs?periodId=${fixture.periodId}`, {
      extraHeaders: { 'x-revb-probe': MARKER },
    });

    const logText = harness.logs.map((line) => JSON.stringify(line)).join('\n');
    const hits = logText
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter((row) => row.line.includes(MARKER));

    const bodyHits = sent.filter((row) => row.raw.includes(MARKER));

    // eslint-disable-next-line no-console
    console.log(
      `\nREV-B PRIVACY PROBE\n  marker: ${MARKER}\n  requests: ` +
        sent.map((r) => `${r.label}=${String(r.statusCode)}`).join('  ') +
        `\n  log lines captured: ${String(harness.logs.length)}` +
        `\n  log lines containing the marker: ${String(hits.length)}` +
        `\n  response bodies echoing the marker: ${String(bodyHits.length)}` +
        (hits.length > 0 ? `\n  LEAKING LINES:\n    ${hits.map((h) => h.line).join('\n    ')}` : '') +
        (bodyHits.length > 0
          ? `\n  ECHOING BODIES:\n    ${bodyHits.map((b) => `${b.label} ${String(b.statusCode)} ${b.raw}`).join('\n    ')}`
          : '') +
        '\n',
    );

    expect(harness.logs.length, 'no log lines were captured — the probe is vacuous').toBeGreaterThan(
      0,
    );
    expect(hits.map((h) => h.line), 'THE MARKER REACHED THE LOG').toEqual([]);
  }, 240_000);

  it('FALSIFIABILITY — the same hunt FINDS a needle planted in the same logger', () => {
    const needle = 'revb-planted-needle-for-the-privacy-probe';
    harness.clearLogs();
    harness.app.log.info({ leak: needle }, 'deliberate leak');
    const found = harness.logs.some((line) => JSON.stringify(line).includes(needle));
    expect(found, 'the probe cannot find a needle in its own haystack').toBe(true);
    harness.clearLogs();
  });
});
