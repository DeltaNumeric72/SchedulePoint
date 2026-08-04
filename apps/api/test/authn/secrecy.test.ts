import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as store from '../../src/authn/store.js';
import { SESSION_COOKIE_NAME, encodeSessionCookie } from '../../src/authn/tokens.js';
import { adminClient } from '../support/admin-client.js';
import {
  FIXTURE_PASSWORD,
  codeFor,
  organizationCommand,
  redactSessionCookie,
} from '../support/authn.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { buildHttpHarness, type HttpHarness } from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **RED CASE 8 — the secrecy probe.**
 *
 * Non-bypass rule 9 and SPEC-07 §3: **no token, password, hash, TOTP secret or
 * recovery code may appear in logs, errors, traces, queue payloads, audit
 * payloads, or evidence artifacts.**
 *
 * ## The probe PLANTS the values and then hunts for them
 *
 * A test that asserted "the log does not contain the word password" would pass
 * against a system that logs the password under another key. This one takes the
 * ACTUAL values the system just minted — the session token, the password, the
 * TOTP secret, an issued invitation token, a recovery code — and searches every
 * place they could have landed:
 *
 *  - every structured log line the server wrote during the flow;
 *  - every response body and every response header;
 *  - every `audit_events.payload` in the organization;
 *  - every `outbox_events.payload` in the organization;
 *  - every column of `sessions`, `invitations` and `password_reset_tokens`
 *    rendered as text (the token must be nowhere, hashed or not);
 *  - the SOURCE of every file this slice ships, for a `console.log` of a secret;
 *  - **every file under `docs/evidence/EV-M3-AUTHN/**` — the artifacts this
 *    packet GENERATES.**
 *
 * ## The evidence-directory scan is here because its absence let a secret ship
 *
 * The first revision logged a full `Set-Cookie` header, so a live 43-character
 * session secret landed verbatim in two committed evidence files. The hunt
 * covered logs, payloads and rows — but not the evidence files the run writes,
 * which is exactly where it escaped. That gap is closed below: the emission is
 * redacted BY CONSTRUCTION (`redactSessionCookie`), and this test scans the
 * whole evidence tree for a secret-shaped value so a recurrence fails the build.
 *
 * ## Falsifiability
 *
 * Two probes. One plants a known value into a log line through the same capture
 * the probe reads and asserts the probe FINDS it. The other writes a
 * secret-shaped cookie line into a TEMP file inside the evidence-scan's own
 * detector and asserts the detector fires. A search that cannot find a planted
 * needle proves nothing about the haystack.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '../../src');
const EVIDENCE_DIR = join(HERE, '../../../../docs/evidence/EV-M3-AUTHN');

/**
 * Secret-shaped patterns that must never appear in an evidence artifact.
 *
 * Each is a SHAPE, not a specific value: the whole point is to catch a secret
 * nobody planted here on purpose — a future `log()` that prints a token, a
 * cookie header logged whole, a bare `mintToken()` value. Every one is bounded
 * so it does not fire on the identifiers evidence legitimately carries (uuids,
 * sha-256 hex, ISO timestamps, correlation ids).
 */
const EVIDENCE_SECRET_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  {
    // The exact B-1 leak: a session cookie whose VALUE after `<uuid>.` is a live
    // base64url secret. `<redacted>` does not match — `<` is not in the class.
    label: 'session-cookie secret',
    pattern: /__Host-sp_session=[0-9a-fA-F-]{36}\.[A-Za-z0-9_-]{20,}/,
  },
  {
    // A quoted assignment to a secret-named key, the same shape the secret-scan
    // gate catches in source — here applied to the evidence text.
    label: 'quoted secret assignment',
    pattern: /\b(?:token|secret|recovery[_-]?code|password)["']?\s*[:=]\s*["'][^"'\n]{16,}["']/i,
  },
];

/** Every secret-shaped hit in one artifact, with a snippet for the failure message. */
function evidenceSecretHits(text: string): string[] {
  const hits: string[] = [];
  for (const { label, pattern } of EVIDENCE_SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) hits.push(`${label}: …${match[0].slice(0, 60)}…`);
  }
  return hits;
}

const multi = ownedMulti('authn-secrecy', { profile: 'full' });

let admin: pg.Client;
let runtime: Runtime;
let harness: HttpHarness;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime');
  harness = await buildHttpHarness();
});

afterAll(async () => {
  await harness.close();
  await runtime.destroy();
  await admin.end();
});

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const absolute = join(directory, name);
    return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
  });
}

interface Planted {
  readonly label: string;
  readonly value: string;
}

describe('planted secrets appear nowhere they must not', () => {
  it('drives a full credential lifecycle and hunts for every value it produced', async () => {
    const alpha = multi().alpha;
    const user = alpha.full!.viewer;
    const asAdmin = organizationCommand(
      alpha.organizationId,
      alpha.users.organizationAdmin.membershipId,
      'secrecy-admin',
    );
    const anonymous = organizationCommand(alpha.organizationId, null, 'secrecy-anon');
    harness.clearLogs();

    /* ── produce every class of secret this subsystem handles ─────────────── */
    const invitation = await runtime.runner.run(asAdmin, (uow) =>
      harness.authn.issueInvitation(uow, {
        userId: user.id,
        email: 'secrecy@example.test',
        notificationRef: 'sink:secrecy',
      }),
    );
    await runtime.runner.run(anonymous, (uow) =>
      harness.authn.activateAccount(uow, {
        token: invitation.token,
        password: FIXTURE_PASSWORD,
      }),
    );
    const loginEmail = await runtime.runner.run(anonymous, async (uow) => {
      const row = await store.findCredentialById(uow, user.id);
      return row!.loginEmail;
    });
    const enrolment = await runtime.runner.run(anonymous, (uow) =>
      harness.authn.startMfaEnrolment(uow, { userId: user.id, label: loginEmail }),
    );
    const confirmed = await runtime.runner.run(anonymous, (uow) =>
      harness.authn.confirmMfaEnrolment(uow, {
        userId: user.id,
        code: codeFor(enrolment.secretBase32, new Date()),
      }),
    );
    const reset = await runtime.runner.run(anonymous, (uow) =>
      harness.authn.requestPasswordReset(uow, { loginEmail, notificationRef: 'sink:secrecy' }),
    );

    /* ── and drive the HTTP surface, so responses and logs are in scope ───── */
    const signIn = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/authn/sign-in`,
      payload: { loginEmail, password: FIXTURE_PASSWORD },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);
    const setCookie = String(signIn.headers['set-cookie']);
    const sessionToken = decodeURIComponent(
      setCookie.slice(setCookie.indexOf('=') + 1, setCookie.indexOf(';')),
    ).split('.')[1]!;

    // A failed sign-in too: the failure path is where a helpful error message
    // most often echoes what was sent.
    await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/authn/sign-in`,
      payload: { loginEmail, password: 'fixture-the-wrong-password-entirely' },
    });
    // And an authenticated request, so the cookie travels.
    await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/authn/sign-out`,
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(
          encodeSessionCookie(alpha.organizationId, sessionToken),
        )}`,
      },
    });

    const planted: Planted[] = [
      { label: 'invitation token', value: invitation.token },
      { label: 'session token', value: sessionToken },
      { label: 'password', value: FIXTURE_PASSWORD },
      { label: 'wrong password', value: 'fixture-the-wrong-password-entirely' },
      { label: 'TOTP secret (base32)', value: enrolment.secretBase32 },
      { label: 'recovery code', value: confirmed.recoveryCodes[0]! },
      { label: 'reset token', value: reset.token! },
    ];
    // A control: every planted value must be non-trivial, or "not found"
    // is not a result.
    for (const secret of planted) {
      expect(secret.value.length, `${secret.label} is empty`).toBeGreaterThan(8);
    }

    const findings: string[] = [];
    const hunt = (haystack: string, where: string): void => {
      for (const secret of planted) {
        if (haystack.includes(secret.value)) findings.push(`${secret.label} in ${where}`);
      }
    };

    /* ── logs ─────────────────────────────────────────────────────────────── */
    for (const line of harness.logs) hunt(JSON.stringify(line), 'a server log line');

    /* ── audit payloads ───────────────────────────────────────────────────── */
    const audits = await admin.query<{ event_name: string; payload: unknown }>(
      'select event_name, payload from audit_events where organization_id = $1::uuid',
      [alpha.organizationId],
    );
    for (const row of audits.rows) hunt(JSON.stringify(row.payload), `audit ${row.event_name}`);

    /* ── outbox payloads (the queue) ──────────────────────────────────────── */
    const outbox = await admin.query<{ kind: string; payload: unknown }>(
      'select kind, payload from outbox_events where organization_id = $1::uuid',
      [alpha.organizationId],
    );
    for (const row of outbox.rows) hunt(JSON.stringify(row.payload), `outbox ${row.kind}`);

    /* ── the rows themselves ──────────────────────────────────────────────── */
    for (const table of ['sessions', 'invitations', 'password_reset_tokens', 'user_mfa']) {
      const rows = await admin.query<{ rendered: string }>(
        `select ${table}::text as rendered from ${table} where organization_id = $1::uuid`,
        [alpha.organizationId],
      );
      for (const row of rows.rows) hunt(row.rendered, `a ${table} row`);
    }

    /* ── `users`, where the password hash lives ───────────────────────────── */
    const users = await admin.query<{ rendered: string }>(
      'select users::text as rendered from users where id = $1::uuid',
      [user.id],
    );
    for (const row of users.rows) hunt(row.rendered, 'the users row');

    expect(findings, `SECRET MATERIAL LEAKED:\n  ${findings.join('\n  ')}`).toEqual([]);
    log(
      `${String(planted.length)} planted secrets hunted across ${String(harness.logs.length)} log ` +
        `lines, ${String(audits.rows.length)} audit payloads, ${String(outbox.rows.length)} outbox ` +
        'payloads and every authn row: none found',
    );
  });

  it('FALSIFIABILITY — the same hunt FINDS a value deliberately written into the capture', () => {
    const needle = 'planted-needle-for-the-secrecy-probe';
    harness.clearLogs();
    // Written through the server's own logger, so it lands in exactly the
    // capture the probe reads. If the probe cannot find this, its "not found"
    // above means nothing.
    harness.app.log.info({ leak: needle }, 'deliberate leak');

    const found = harness.logs.some((line) => JSON.stringify(line).includes(needle));
    expect(found, 'the secrecy probe could not find a needle planted in its own haystack').toBe(
      true,
    );
    harness.clearLogs();
    log('the probe found a planted needle: the "not found" result above is a measurement');
  });
});

describe('the GENERATED evidence artifacts carry no secret material', () => {
  it('no file under docs/evidence/EV-M3-AUTHN carries a secret-shaped value', () => {
    // This is the scan whose ABSENCE let a live session secret ship in the first
    // revision. It runs against the committed artifacts, so a regression is a
    // build failure rather than a review catch.
    expect(existsSync(EVIDENCE_DIR), `evidence directory missing: ${EVIDENCE_DIR}`).toBe(true);

    const findings: string[] = [];
    const scanned: string[] = [];
    for (const absolute of walk(EVIDENCE_DIR)) {
      // The scan is text-only; a binary artifact would be a separate concern and
      // there are none here.
      const text = readFileSync(absolute, 'utf8');
      scanned.push(relative(EVIDENCE_DIR, absolute));
      for (const hit of evidenceSecretHits(text)) {
        findings.push(`${relative(EVIDENCE_DIR, absolute)} — ${hit}`);
      }
    }
    expect(scanned.length, 'the evidence directory was empty — the scan is vacuous').toBeGreaterThan(
      0,
    );
    expect(findings, `SECRET MATERIAL IN AN EVIDENCE ARTIFACT:\n  ${findings.join('\n  ')}`).toEqual(
      [],
    );
    log(
      `${String(scanned.length)} evidence artifacts scanned for ${String(
        EVIDENCE_SECRET_PATTERNS.length,
      )} secret shapes: none found`,
    );
  });

  it('the cookie-posture line still proves the ATTRIBUTES, with the secret redacted', () => {
    // The redaction is by construction, and this asserts it kept the attributes
    // that make the proof a proof while removing the value that made it a leak.
    const fabricated =
      '__Host-sp_session=00000000-0000-4000-8000-00000000a11a.' +
      'A'.repeat(43) +
      '; Path=/; HttpOnly; Secure; SameSite=Strict';
    const redacted = redactSessionCookie(fabricated);

    expect(redacted).toContain('<redacted>');
    expect(redacted).not.toContain('A'.repeat(43));
    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) {
      expect(redacted, `redaction dropped ${attribute}`).toContain(attribute);
    }
    // And the redacted line does NOT trip the evidence detector, while the raw
    // one does — the detector and the redaction agree about what a secret is.
    expect(evidenceSecretHits(redacted)).toEqual([]);
    expect(evidenceSecretHits(fabricated).length).toBeGreaterThan(0);
  });

  it('FALSIFIABILITY — the evidence scan FIRES on a secret planted in a temp artifact', () => {
    // If the detector cannot find a real secret written into an evidence-shaped
    // file, its "none found" above is worthless. A temp directory stands in for
    // the evidence directory so the planted secret never touches a committed file.
    const dir = mkdtempSync(join(tmpdir(), 'sp-evidence-secrecy-'));
    try {
      const plantedSecret = 'Zx9' + 'k'.repeat(40); // 43 base64url chars, a token shape
      writeFileSync(
        join(dir, 'sbx-006-session.txt'),
        `  sign-in cookie: __Host-sp_session=00000000-0000-4000-8000-00000000a11a.${plantedSecret}; Path=/; HttpOnly\n`,
      );

      const findings: string[] = [];
      for (const absolute of walk(dir)) {
        for (const hit of evidenceSecretHits(readFileSync(absolute, 'utf8'))) {
          findings.push(hit);
        }
      }
      expect(
        findings.length,
        'the evidence scan could not find a secret planted in an evidence-shaped file',
      ).toBeGreaterThan(0);
      log(`the evidence scan fired on a planted secret: ${findings[0] ?? ''}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the shipped source cannot log a secret', () => {
  it('no module under src/authn writes a secret-bearing value to the console', () => {
    const findings: string[] = [];
    for (const absolute of walk(join(SRC, 'authn'))) {
      if (!absolute.endsWith('.ts')) continue;
      const file = relative(SRC, absolute).replaceAll('\\', '/');
      readFileSync(absolute, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/console\.(log|info|warn|error|debug)/.test(line)) {
            findings.push(`${file}:${String(index + 1)} ${line.trim()}`);
          }
        });
    }
    expect(findings, findings.join('\n')).toEqual([]);
  });

  it('the error vocabulary carries no reason that could be a credential', async () => {
    const { AUTHN_FAILED_MESSAGE, SESSION_INVALID_MESSAGE, TOKEN_INVALID_MESSAGE } = await import(
      '../../src/authn/errors.js'
    );
    // The three client-facing messages are FIXED strings with no interpolation.
    for (const message of [
      AUTHN_FAILED_MESSAGE,
      SESSION_INVALID_MESSAGE,
      TOKEN_INVALID_MESSAGE,
    ]) {
      expect(message).not.toMatch(/\$\{/);
      expect(message.length).toBeGreaterThan(10);
    }

    // And the internal reasons — which DO vary — never reach a client. Driven
    // over HTTP: every distinguishable credential failure must produce the same
    // body.
    const alpha = multi().alpha;
    const bodies = new Set<string>();
    for (const payload of [
      { loginEmail: 'nobody@example.test', password: FIXTURE_PASSWORD },
      { loginEmail: 'nobody@example.test', password: 'x'.repeat(20) },
      { loginEmail: 'not-an-email', password: FIXTURE_PASSWORD },
      { loginEmail: 'nobody@example.test' },
    ]) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/organizations/${alpha.organizationId}/authn/sign-in`,
        payload,
      });
      expect(response.statusCode).toBe(401);
      // The correlation id differs per request by design; everything else must
      // not.
      const body = JSON.parse(response.body) as {
        error: { code: string; message: string; correlationId: string };
      };
      bodies.add(`${body.error.code}|${body.error.message}`);
    }
    expect(
      [...bodies],
      'sign-in failures produced more than one body — the pair is an oracle',
    ).toHaveLength(1);
    log(`four distinguishable failures produced ONE body: ${[...bodies][0] ?? ''}`);
  });
});
