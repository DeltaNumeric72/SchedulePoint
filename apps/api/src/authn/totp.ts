import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP, over RFC 4226 HOTP — 14 §2, "TOTP minimum; **required for
 * elevated roles**".
 *
 * ## Written here rather than taken from a package
 *
 * The whole algorithm is an HMAC, a dynamic truncation and a modulo. Node has
 * the HMAC. Adding a dependency for forty lines would mean a licence review and
 * a supply-chain surface (T-33) for code that is fully specified in a published
 * RFC and fully testable against that RFC's own vectors — which
 * `apps/api/test/authn/mfa.test.ts`'s "RFC 6238 appendix B" does, against the
 * published vectors for
 * SHA-1 and SHA-256.
 *
 * ## The time step is the unit of replay
 *
 * A code is valid for its whole step (30 s by default), so "the code was right"
 * is not sufficient — the same right code is right again a second later.
 * `verifyTotp` therefore returns the **time step** it matched, and the caller is
 * required to reject a step that has already been accepted. The database
 * enforces the same rule independently (`user_mfa_guard_step_monotonic`),
 * because the caller and a concurrent retry can both read the same row before
 * either writes it.
 *
 * ## The skew window is asymmetric-capable and deliberately small
 *
 * One step either side. A wider window multiplies the codes valid at any instant
 * — which is the number an online guessing attack divides by — and clock drift
 * beyond 30 seconds on an authenticator app is a device problem, not something
 * to absorb silently.
 */

export type TotpAlgorithm = 'SHA1' | 'SHA256';

export interface TotpParameters {
  readonly algorithm: TotpAlgorithm;
  readonly digits: number;
  readonly periodSeconds: number;
}

export const DEFAULT_TOTP_PARAMETERS: TotpParameters = {
  // SHA1 is RFC 6238's default and is what every authenticator app assumes when
  // the provisioning URI omits the algorithm. It is a HMAC construction, where
  // SHA-1's collision weakness does not apply; changing it would break scanning
  // in apps that ignore the `algorithm` parameter, which many do.
  algorithm: 'SHA1',
  digits: 6,
  periodSeconds: 30,
};

/** How many steps either side of the current one are accepted. */
export const TOTP_SKEW_STEPS = 1;

/** A 20-byte shared secret — RFC 4226 §4 R6's recommended length. */
export function mintTotpSecret(): Buffer {
  return randomBytes(20);
}

export function timeStepAt(instant: Date, periodSeconds: number): number {
  return Math.floor(instant.getTime() / 1000 / periodSeconds);
}

/** RFC 4226 §5.3 — HOTP over an 8-byte big-endian counter. */
export function hotp(secret: Buffer, counter: number, parameters: TotpParameters): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(parameters.algorithm === 'SHA1' ? 'sha1' : 'sha256', secret)
    .update(message)
    .digest();

  // Dynamic truncation: the low nibble of the last byte selects the offset.
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return String(binary % 10 ** parameters.digits).padStart(parameters.digits, '0');
}

export function totpAt(secret: Buffer, instant: Date, parameters: TotpParameters): string {
  return hotp(secret, timeStepAt(instant, parameters.periodSeconds), parameters);
}

export interface TotpVerification {
  /** The time step the presented code matched. The caller MUST reject a repeat. */
  readonly timeStep: number;
}

/**
 * `undefined` when no step in the window matches.
 *
 * Every candidate step is evaluated — the loop does not short-circuit on a match
 * — so the time taken does not reveal which step matched or whether an early one
 * did. The comparison itself is `timingSafeEqual` over equal-length buffers.
 */
export function verifyTotp(
  secret: Buffer,
  presented: string,
  instant: Date,
  parameters: TotpParameters,
  skewSteps: number = TOTP_SKEW_STEPS,
): TotpVerification | undefined {
  const trimmed = presented.trim();
  if (trimmed.length !== parameters.digits || !/^[0-9]+$/.test(trimmed)) return undefined;

  const current = timeStepAt(instant, parameters.periodSeconds);
  const presentedBytes = Buffer.from(trimmed, 'utf8');
  let matched: number | undefined;

  for (let offset = -skewSteps; offset <= skewSteps; offset += 1) {
    const step = current + offset;
    if (step <= 0) continue;
    const candidate = Buffer.from(hotp(secret, step, parameters), 'utf8');
    if (candidate.length === presentedBytes.length && timingSafeEqual(candidate, presentedBytes)) {
      matched = step;
    }
  }

  return matched === undefined ? undefined : { timeStep: matched };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Recovery codes
 * ──────────────────────────────────────────────────────────────────────────── */

/** How many are issued at enrolment. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * Crockford base32 minus the ambiguous characters, so a code read off a screen
 * and typed on a phone survives the trip. `0/O` and `1/I/L` are the pairs people
 * actually confuse.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/**
 * Ten codes, each 10 characters of the alphabet above (~49 bits).
 *
 * Rejection sampling rather than `% alphabet.length`: the modulo of a uniform
 * byte over 30 is not uniform, and a recovery code with a skewed distribution is
 * a recovery code with fewer bits than it looks like.
 */
export function mintRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  const limit = 256 - (256 % RECOVERY_ALPHABET.length);
  while (codes.length < count) {
    let code = '';
    while (code.length < 10) {
      for (const byte of randomBytes(32)) {
        if (byte >= limit) continue;
        code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
        if (code.length === 10) break;
      }
    }
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return codes;
}

/** Normalised before hashing, so case and the separator do not decide the outcome. */
export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replaceAll('-', '');
}

/**
 * The provisioning URI an authenticator app scans.
 *
 * **`label` and `issuer` must never carry a real person's or organization's
 * name** in this system's tests or fixtures — the clean-room boundary and the
 * synthetic-data rule both apply, and the value ends up in a QR code that gets
 * screenshotted.
 */
export function provisioningUri(options: {
  readonly secret: Buffer;
  readonly label: string;
  readonly issuer: string;
  readonly parameters: TotpParameters;
}): string {
  const secret = base32Encode(options.secret);
  const query = new URLSearchParams({
    secret,
    issuer: options.issuer,
    algorithm: options.parameters.algorithm,
    digits: String(options.parameters.digits),
    period: String(options.parameters.periodSeconds),
  });
  return `otpauth://totp/${encodeURIComponent(options.issuer)}:${encodeURIComponent(
    options.label,
  )}?${query.toString()}`;
}

/** RFC 4648 base32, which is the only encoding authenticator apps accept. */
export function base32Encode(input: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
