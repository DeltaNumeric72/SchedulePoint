import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing — 14 §2 "modern memory-hard hashing".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## FAD PROPOSAL: scrypt, not argon2id, and the reason is a dependency rule
 *
 * The packet says "argon2id preferred; the selected library and parameters are
 * recorded for FAD ratification at acceptance". argon2id is not available: every
 * argon2 binding for Node is a native addon, and this packet's allowed-file list
 * permits root/workspace config changes "only for script entries" — adding a
 * dependency (and a native one, with a licence review and a build-toolchain
 * requirement) is outside it.
 *
 * `crypto.scrypt` is in Node's standard library, is memory-hard by construction,
 * and is the alternative OWASP names when argon2id is unavailable. What it does
 * NOT give, stated rather than glossed: argon2id's side-channel hardening and
 * its separate time/memory parameters. That is a real difference and it is the
 * thing the FAD is being asked to accept.
 *
 * **Parameters, for ratification:** `N = 2^15` (32768), `r = 8`, `p = 1`,
 * 32-byte salt, 32-byte digest, `maxmem` raised to admit N=2^15 (Node's default
 * 32 MiB is below the ~64 MiB this needs and the failure is an opaque throw).
 * That is ~64 MiB and roughly 100 ms per verification on this machine — measured
 * in `apps/api/test/authn/password-hashing.test.ts`, not asserted here.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ## The stored form is self-describing
 *
 * `scrypt$N$r$p$<salt-b64>$<digest-b64>`. Parameters travel WITH the hash, so
 * raising them does not invalidate every existing credential: a verification
 * reads the parameters from the row it is checking. A bare digest plus
 * parameters in application configuration cannot be re-parameterised at all
 * without a forced reset, and the parameters will be raised.
 *
 * The database checks the prefix too (`users_password_hash_encoded`), so a bare
 * digest written by a maintenance script is refused at the write rather than
 * discovered at the next sign-in.
 *
 * ## Nothing here logs, throws with, or returns the password
 *
 * `verifyPassword` returns a boolean. Its failure mode is `false`, never an
 * error carrying the input, and it compares with `timingSafeEqual` on equal-
 * length buffers.
 */

export interface ScryptParameters {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** The parameters new hashes are written with. Existing hashes carry their own. */
export const CURRENT_SCRYPT_PARAMETERS: ScryptParameters = { N: 32768, r: 8, p: 1 };

const SALT_BYTES = 32;
const DIGEST_BYTES = 32;

/**
 * `maxmem` must exceed roughly `128 * N * r` bytes or Node refuses the call.
 * With N=32768 and r=8 that is 32 MiB of working memory, and Node's default
 * `maxmem` is exactly 32 MiB — close enough that a parameter bump would fail
 * with an opaque error. The headroom is deliberate and is not a memory budget.
 */
function maxmemFor(parameters: ScryptParameters): number {
  return 256 * parameters.N * parameters.r;
}

/** The minimum a password may be. 14 §2 sets no number; this one is stated, not hidden. */
export const MINIMUM_PASSWORD_LENGTH = 12;

export function passwordPolicyProblem(password: string): string | undefined {
  // Length in code points, not UTF-16 units: a passphrase of emoji is not half
  // as long as it looks.
  if ([...password].length < MINIMUM_PASSWORD_LENGTH) {
    return `a password must be at least ${String(MINIMUM_PASSWORD_LENGTH)} characters`;
  }
  if (password.length > 1024) {
    // An upper bound exists because scrypt's cost is paid by the SERVER, and an
    // unbounded input is a cheap way to buy expensive work.
    return 'a password must be at most 1024 characters';
  }
  return undefined;
}

export async function hashPassword(
  password: string,
  parameters: ScryptParameters = CURRENT_SCRYPT_PARAMETERS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const digest = await scrypt(password.normalize('NFKC'), salt, DIGEST_BYTES, {
    ...parameters,
    maxmem: maxmemFor(parameters),
  });
  return [
    'scrypt',
    String(parameters.N),
    String(parameters.r),
    String(parameters.p),
    salt.toString('base64'),
    digest.toString('base64'),
  ].join('$');
}

/**
 * `false` for a wrong password AND for a malformed stored value.
 *
 * A malformed hash is a defect, but the response to it must be the same as a
 * wrong password: throwing would make a corrupted row distinguishable from a
 * bad credential by the shape of the failure, which is a disclosure oracle.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A stored value naming an absurd N would otherwise let one row dictate the
  // server's memory use.
  if (N < 1024 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64');
    expected = Buffer.from(parts[5] ?? '', 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor({ N, r, p }),
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
