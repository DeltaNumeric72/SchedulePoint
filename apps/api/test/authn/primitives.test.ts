import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ControllableClock } from '../../src/authn/clock.js';
import {
  CURRENT_SCRYPT_PARAMETERS,
  MINIMUM_PASSWORD_LENGTH,
  hashPassword,
  passwordPolicyProblem,
  verifyPassword,
} from '../../src/authn/passwords.js';
import { SecretBox } from '../../src/authn/secret-box.js';
import { decodeSessionCookie, encodeSessionCookie, hashToken, mintToken } from '../../src/authn/tokens.js';
import { mintRecoveryCodes, normalizeRecoveryCode } from '../../src/authn/totp.js';
import { log } from '../support/harness.js';

/**
 * The authentication primitives, and the two seams that must not exist in
 * production.
 *
 * ## The clock seam is asserted by SCANNING THE SHIPPED SOURCE
 *
 * The whole design of `apps/api/src/authn/clock.ts` is that the clock is a
 * constructor parameter and there is no other way in. A docblock saying so is
 * worth nothing; this file checks it. A module-level mutable, an environment
 * read, or a `setClock` would all be caught here, and each of them is exactly
 * how a test seam becomes a production hazard.
 *
 * ## The scrypt PARAMETERS are measured, not asserted
 *
 * The FAD proposal records `N = 2^15, r = 8, p = 1`. This file measures what
 * that costs on the machine the suite runs on and prints the number, rather than
 * asserting a threshold that would be flaky on slower hardware and meaningless
 * on faster.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '../../src');

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const absolute = join(directory, name);
    return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
  });
}

describe('the clock seam cannot be reached from a production path', () => {
  it('nothing under src assigns a clock, reads one from the environment, or offers a setter', () => {
    const findings: string[] = [];
    for (const absolute of walk(SRC)) {
      if (!absolute.endsWith('.ts')) continue;
      const file = relative(SRC, absolute).replaceAll('\\', '/');
      readFileSync(absolute, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const at = `${file}:${String(index + 1)}`;
          // A settable module-level clock, in any of the shapes it takes.
          if (/^\s*(?:export\s+)?let\s+\w*[Cc]lock\b/.test(line)) findings.push(`${at} mutable clock binding`);
          if (/\bset(?:Clock|Now|Time)\s*\(/.test(line)) findings.push(`${at} clock setter`);
          if (/process\.env\[[^\]]*(?:CLOCK|NOW|TIME|FAKE)[^\]]*\]/i.test(line)) {
            findings.push(`${at} clock selected from the environment`);
          }
        });
    }
    expect(findings, findings.join('\n')).toEqual([]);
  });

  it('`createAuthnService` passes the system clock and takes no argument that could change it', () => {
    const source = readFileSync(join(SRC, 'authn/service.ts'), 'utf8');
    const factory = source.slice(source.indexOf('export function createAuthnService'));
    expect(factory).toContain('systemClock');
    // No parameter at all: a factory that accepted options would be one
    // misconfiguration away from a production process with a frozen clock.
    expect(factory.slice(0, factory.indexOf(')'))).toMatch(/createAuthnService\(\s*$/);
  });

  it('RED: the scan catches each shape it exists to catch', () => {
    const offenders = [
      'let currentClock = systemClock;',
      'export let clock = systemClock;',
      'export function setClock(next: Clock) {}',
      "const c = process.env['SP_AUTHN_FAKE_CLOCK'];",
    ];
    const patterns = [
      /^\s*(?:export\s+)?let\s+\w*[Cc]lock\b/,
      /\bset(?:Clock|Now|Time)\s*\(/,
      /process\.env\[[^\]]*(?:CLOCK|NOW|TIME|FAKE)[^\]]*\]/i,
    ];
    for (const offender of offenders) {
      expect(
        patterns.some((pattern) => pattern.test(offender)),
        `no pattern matched: ${offender}`,
      ).toBe(true);
    }
  });

  it('the controllable clock refuses to run backwards', () => {
    const clock = new ControllableClock(new Date('2026-03-01T00:00:00.000Z'));
    const before = clock.now().getTime();
    clock.advance(1000);
    expect(clock.now().getTime()).toBe(before + 1000);
    expect(() => clock.advance(-1)).toThrow(/negative interval/);
    // And `now()` hands back a COPY: a caller mutating the returned Date must
    // not move the clock.
    const handed = clock.now();
    handed.setFullYear(1999);
    expect(clock.now().getFullYear()).toBe(2026);
  });
});

describe('password hashing', () => {
  it('a hash verifies, a wrong password does not, and two hashes of the same password differ', async () => {
    const password = 'fixture-a-perfectly-ordinary-passphrase';
    const first = await hashPassword(password, { N: 1024, r: 8, p: 1 });
    const second = await hashPassword(password, { N: 1024, r: 8, p: 1 });
    expect(first).not.toBe(second); // a per-hash salt, not a global one
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword(password, second)).toBe(true);
    expect(await verifyPassword('fixture-a-perfectly-ordinary-passphras', first)).toBe(false);
    expect(await verifyPassword('', first)).toBe(false);
  });

  it('the encoded form carries its own parameters, so raising them does not invalidate old hashes', async () => {
    const password = 'fixture-parameters-travel-with-the-hash';
    const cheap = await hashPassword(password, { N: 1024, r: 8, p: 1 });
    const dearer = await hashPassword(password, { N: 4096, r: 8, p: 1 });
    expect(cheap.startsWith('scrypt$1024$8$1$')).toBe(true);
    expect(dearer.startsWith('scrypt$4096$8$1$')).toBe(true);
    // Both verify, with no configuration telling the verifier which is which.
    expect(await verifyPassword(password, cheap)).toBe(true);
    expect(await verifyPassword(password, dearer)).toBe(true);
  });

  it('a malformed stored value returns FALSE rather than throwing', async () => {
    // A throw would make a corrupted row distinguishable from a wrong password
    // by the shape of the failure, which is a disclosure oracle.
    for (const stored of [
      '',
      'not-a-hash',
      'scrypt$$$$',
      'scrypt$1024$8$1$notbase64!!$alsonot',
      'argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA',
      // An absurd N: a stored value must not be able to dictate the server's
      // memory use.
      'scrypt$99999999$8$1$AAAA$AAAA',
    ]) {
      expect(await verifyPassword('anything', stored), `${stored} verified`).toBe(false);
    }
  });

  it('the policy states a minimum and an upper bound, and both are enforced', () => {
    expect(passwordPolicyProblem('x'.repeat(MINIMUM_PASSWORD_LENGTH - 1))).toMatch(/at least/);
    expect(passwordPolicyProblem('x'.repeat(MINIMUM_PASSWORD_LENGTH))).toBeUndefined();
    // An upper bound exists because scrypt's cost is paid by the SERVER.
    expect(passwordPolicyProblem('x'.repeat(1025))).toMatch(/at most/);
    // Length in CODE POINTS: a passphrase of emoji is not half as long as it
    // looks to `String.length`.
    expect(passwordPolicyProblem('🔐'.repeat(MINIMUM_PASSWORD_LENGTH))).toBeUndefined();
  });

  it('MEASURES the production parameters rather than asserting a threshold', async () => {
    const password = 'fixture-measurement-only-not-a-credential';
    const started = process.hrtime.bigint();
    const hash = await hashPassword(password, CURRENT_SCRYPT_PARAMETERS);
    const hashed = process.hrtime.bigint();
    expect(await verifyPassword(password, hash)).toBe(true);
    const verified = process.hrtime.bigint();

    const hashMs = Number(hashed - started) / 1e6;
    const verifyMs = Number(verified - hashed) / 1e6;
    log(
      `scrypt N=${String(CURRENT_SCRYPT_PARAMETERS.N)} r=${String(CURRENT_SCRYPT_PARAMETERS.r)} ` +
        `p=${String(CURRENT_SCRYPT_PARAMETERS.p)}: hash ${hashMs.toFixed(1)} ms, verify ` +
        `${verifyMs.toFixed(1)} ms, ~${String(
          Math.round((128 * CURRENT_SCRYPT_PARAMETERS.N * CURRENT_SCRYPT_PARAMETERS.r) / 1024 / 1024),
        )} MiB working memory (FAD proposal)`,
    );
    // The only assertion is that it is NOT free — a parameter set accidentally
    // reduced to nothing would pass a timing test with no lower bound.
    expect(hashMs).toBeGreaterThan(1);
  });
});

describe('tokens', () => {
  it('a token is 256 bits of base64url and two are never equal', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const token = mintToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(seen.has(token)).toBe(false);
      seen.add(token);
    }
  });

  it('the namespaces are domain-separated: the same token hashes differently in each', () => {
    const token = mintToken();
    const digests = new Set(
      (['session', 'invitation', 'password_reset'] as const).map((namespace) =>
        hashToken(namespace, token).toString('hex'),
      ),
    );
    expect(digests.size, 'two namespaces produced the same digest').toBe(3);
    for (const digest of digests) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the session cookie round-trips, and every malformed shape decodes to nothing', () => {
    const organizationId = '11111111-2222-4333-8444-555555555555';
    const token = mintToken();
    const encoded = encodeSessionCookie(organizationId, token);
    expect(decodeSessionCookie(encoded)).toEqual({ organizationId, secret: token });

    for (const malformed of [
      '',
      'no-separator',
      `.${token}`,
      `not-a-uuid.${token}`,
      `${organizationId}.short`,
      `${organizationId}.${'x'.repeat(200)}`,
      `${organizationId}.has spaces in it aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
      `${organizationId}.${'+'.repeat(43)}`,
    ]) {
      expect(decodeSessionCookie(malformed), `${malformed} decoded`).toBeUndefined();
    }
  });
});

describe('the secret box', () => {
  it('seals and opens, and is bound to (organization, user)', () => {
    const box = new SecretBox(new Map([[1, Buffer.alloc(32, 7)]]), 1);
    const secret = Buffer.from('a-twenty-byte-secret');
    const binding = { organizationId: 'org-1', userId: 'user-1' };
    const sealed = box.seal(secret, binding);

    expect(box.open(sealed, binding)?.equals(secret)).toBe(true);
    expect(box.open(sealed, { ...binding, userId: 'user-2' })).toBeUndefined();
    expect(box.open(sealed, { ...binding, organizationId: 'org-2' })).toBeUndefined();
    expect(box.open({ ...sealed, keyVersion: 2 }, binding)).toBeUndefined();
    expect(box.keyIsIsolated).toBe(false);
  });

  it('a key of the wrong length is refused at construction, not at first use', () => {
    expect(() => new SecretBox(new Map([[1, Buffer.alloc(16)]]), 1)).toThrow(/AES-256-GCM/);
    expect(() => new SecretBox(new Map([[1, Buffer.alloc(32)]]), 2)).toThrow(/current version/);
    expect(() => new SecretBox(new Map(), 1)).toThrow(/at least one key/);
  });
});

describe('recovery codes', () => {
  it('ten distinct codes, from an alphabet with no confusable characters', () => {
    const codes = mintRecoveryCodes();
    expect(codes.length).toBe(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{5}$/);
      // `0/O` and `1/I/L` are the pairs people actually confuse on a screen.
      expect(code).not.toMatch(/[01OIL]/);
    }
  });

  it('normalisation is case- and separator-insensitive and nothing more', () => {
    expect(normalizeRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('  ABCDE-FGHJK  ')).toBe('ABCDEFGHJK');
    // It does NOT strip other characters: a code with a typo must stay wrong.
    expect(normalizeRecoveryCode('ABCDE FGHJK')).toBe('ABCDE FGHJK');
  });
});
