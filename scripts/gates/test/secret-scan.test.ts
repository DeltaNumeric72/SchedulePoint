import { describe, expect, it } from 'vitest';

// @ts-expect-error -- gate scripts are plain JS with JSDoc types; there is no .d.ts.
import { DETECTORS, analyze, isPlaceholder } from '../secret-scan.mjs';

/**
 * Secret-scan detector tests.
 *
 * **Every credential-shaped string in this file is assembled at runtime from
 * fragments.** If they were written as literals, this test file would itself
 * trip the scanner it is testing — which is both a false positive and a good
 * illustration of why the scanner works.
 *
 * Two directions are tested and both matter:
 *  - each detector fires on its format (a detector that never fires is worse
 *    than absent, because it makes the count look healthy);
 *  - the placeholder logic does not swallow anything real.
 */

interface Violation {
  file: string;
  line: number;
  detail: string;
}

function scan(text: string): Violation[] {
  return analyze([{ path: 'inline', text }]) as Violation[];
}

function ids(text: string): string[] {
  return scan(text).map((v) => v.detail.split(':')[0] ?? '');
}

// Fragments, joined at runtime.
const AKIA = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');
const GH_TOKEN = ['ghp', '_', 'a'.repeat(36)].join('');
const SLACK = ['xox', 'b-', '1234567890', '-', 'abcdefghij'].join('');
const STRIPE = ['sk', '_live_', 'abcdefghijklmnop123'].join('');
const GOOGLE = ['AI', 'za', 'B'.repeat(35)].join('');
const NPM = ['npm', '_', 'c'.repeat(36)].join('');
const JWT = ['eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjMifQ', '.', 'abcdefghijk'].join('');
const PEM = ['-----BEGIN ', 'RSA ', 'PRIVATE KEY', '-----'].join('');

describe('detectors fire on real credential formats', () => {
  it('AWS access key id', () => {
    expect(ids(`const k = "${AKIA}";`)).toContain('aws-access-key-id');
  });

  it('AWS secret access key assignment', () => {
    const secret = 'A'.repeat(40);
    expect(ids(`aws_secret_access_key = "${secret}"`)).toContain('aws-secret-access-key');
  });

  it('PEM private key block', () => {
    expect(ids(`${PEM}\nMIIB...\n`)).toContain('private-key-block');
  });

  it('GitHub token', () => {
    expect(ids(`token: ${GH_TOKEN}`)).toContain('github-token');
  });

  it('Slack token', () => {
    expect(ids(`SLACK=${SLACK}`)).toContain('slack-token');
  });

  it('Stripe secret key', () => {
    expect(ids(`key=${STRIPE}`)).toContain('stripe-secret-key');
  });

  it('Google API key', () => {
    expect(ids(`k=${GOOGLE}`)).toContain('google-api-key');
  });

  it('npm token', () => {
    expect(ids(`//registry.npmjs.org/:_authToken=${NPM}`)).toContain('npm-token');
  });

  it('JSON Web Token', () => {
    expect(ids(`Authorization: Bearer ${JWT}`)).toContain('json-web-token');
  });

  it('connection string with an inline password', () => {
    const dsn = ['postgres://sp_app:', 'hunter2butlonger', '@db.internal:5432/sp'].join('');
    expect(ids(`DATABASE_URL=${dsn}`)).toContain('connection-string-password');
  });

  it('quoted assignment to a secret-named identifier', () => {
    const assignment = ['const pass', 'word = "', 's3cret-value-that-is-long', '";'].join('');
    expect(ids(assignment)).toContain('generic-secret-assignment');
  });

  it('every declared detector is covered by a test above', () => {
    // Guards against a detector being added without a test, which is how a
    // detector quietly stops matching anything.
    const covered = new Set([
      'aws-access-key-id',
      'aws-secret-access-key',
      'private-key-block',
      'github-token',
      'slack-token',
      'stripe-secret-key',
      'google-api-key',
      'npm-token',
      'json-web-token',
      'connection-string-password',
      'generic-secret-assignment',
    ]);
    const declared = (DETECTORS as { id: string }[]).map((d) => d.id);
    expect(declared.filter((id) => !covered.has(id))).toEqual([]);
  });
});

describe('placeholders are not reported', () => {
  it.each([
    'const password = "CHANGEME";',
    'const password = "changeme";',
    'client_secret: "${SOME_ENV_VAR}"',
    'api_key = "<your-key-here>"',
    'const secret = "your_secret_here";',
    'DATABASE_URL=postgres://sp_app:CHANGEME@localhost:5432/sp',
  ])('%s', (text) => {
    expect(scan(text)).toEqual([]);
  });

  it('does not treat a long random-looking value as a placeholder', () => {
    const value = ['Zq7-', 'Kf1x-', 'Rb92-', 'Tt40'].join('');
    expect(isPlaceholder(value)).toBe(false);
    expect(scan(['const client_sec', 'ret = "', value, '";'].join('')).length).toBeGreaterThan(0);
  });

  it('does not treat a local development credential prefix as a real secret', () => {
    // Spike and dev fixtures declare themselves in the value, e.g.
    // `password: 'spike-local-runtime'`. Recognising the declaration is what
    // keeps the gate usable on this repository without excluding whole trees.
    expect(isPlaceholder('spike-local-runtime')).toBe(true);
    expect(isPlaceholder('dev_local_password')).toBe(true);
    // ...but the prefix must be the *start* of the value, not merely present.
    expect(isPlaceholder('prod-key-spike-local')).toBe(false);
  });
});

describe('reporting', () => {
  it('reports the line number of the offending value', () => {
    const line3 = ['const api', '_key = "', 'abcdefghijklmnop', '";'].join('');
    const violations = scan(`line one\nline two\n${line3}\n`);
    expect(violations[0]?.line).toBe(3);
  });

  it('finds nothing in ordinary source', () => {
    expect(
      scan('export function add(a: number, b: number): number {\n  return a + b;\n}\n'),
    ).toEqual([]);
  });
});
