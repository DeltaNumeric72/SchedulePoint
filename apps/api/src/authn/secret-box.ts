import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for the one authentication secret that cannot be hashed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## READ THIS BEFORE TREATING AN ENCRYPTED TOTP SECRET AS PROTECTED
 *
 * **The key is held in the application process.** `keyIsIsolated` returns
 * `false`, always, and it is not a configuration option — for exactly the reason
 * `LocalCheckpointSigner.keyIsIsolated` is not (FAD-7): a flag that could be set
 * would eventually be set by someone in a hurry.
 *
 * So this satisfies the MECHANISM — a database reader without the key recovers
 * nothing, a backup without the key is inert, a tampered ciphertext fails
 * authentication rather than decrypting to rubbish — and **none of the assurance
 * against an actor who can read the process's environment.** Real key custody
 * (KMS, TDG-15) is a named deployment condition, not a claim made here.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ## Why a TOTP secret is encrypted rather than hashed
 *
 * RFC 6238 verification recomputes `HMAC(secret, time_step)`. The verifier needs
 * the secret back. Hashing it would produce a column that verifies nothing, so
 * "hash everything" is not available here and pretending otherwise would be
 * worse than saying so. This is the SPEC-07 §3 pattern — delivery material that
 * must be recoverable is envelope-encrypted with a rotatable key version — applied
 * to a second class of secret.
 *
 * ## AES-256-GCM, with the three parts stored separately
 *
 * `ciphertext`, `nonce` and `tag` are three columns rather than one concatenated
 * blob. A truncated blob is a decode error somewhere inside the parser; three
 * columns with `octet_length` CHECKs are a constraint violation at the write.
 *
 * The **associated data** binds the ciphertext to the row it belongs to: the
 * organization id and user id are authenticated but not encrypted, so moving a
 * ciphertext to another user's row makes decryption fail rather than succeed
 * with somebody else's factor.
 */

export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly keyVersion: number;
}

export interface SecretBinding {
  readonly organizationId: string;
  readonly userId: string;
}

const NONCE_BYTES = 12;
const KEY_BYTES = 32;

function associatedData(binding: SecretBinding): Buffer {
  return Buffer.from(`sp.authn.mfa.v1\u0000${binding.organizationId}\u0000${binding.userId}`);
}

export class SecretBox {
  readonly #keys: ReadonlyMap<number, Buffer>;
  readonly #currentVersion: number;

  /** Always `false`. See the header. */
  readonly keyIsIsolated = false;

  constructor(keys: ReadonlyMap<number, Buffer>, currentVersion: number) {
    if (keys.size === 0) throw new Error('SecretBox requires at least one key');
    const current = keys.get(currentVersion);
    if (current === undefined) {
      throw new Error(`SecretBox has no key for the declared current version ${String(currentVersion)}`);
    }
    for (const [version, key] of keys) {
      if (key.length !== KEY_BYTES) {
        throw new Error(
          `SecretBox key version ${String(version)} is ${String(key.length)} bytes; AES-256-GCM needs ${String(KEY_BYTES)}`,
        );
      }
    }
    this.#keys = keys;
    this.#currentVersion = currentVersion;
  }

  get currentVersion(): number {
    return this.#currentVersion;
  }

  seal(plaintext: Buffer, binding: SecretBinding): SealedSecret {
    const key = this.#keys.get(this.#currentVersion);
    /* c8 ignore next */
    if (key === undefined) throw new Error('SecretBox lost its current key');
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(associatedData(binding));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext, nonce, tag: cipher.getAuthTag(), keyVersion: this.#currentVersion };
  }

  /**
   * `undefined` when authentication fails — a wrong key version, a tampered
   * ciphertext, a nonce from another row, or a binding that does not match.
   *
   * Deliberately not a throw. The caller's response to "this enrolment cannot be
   * read" is the same as to "there is no enrolment": the challenge fails. A
   * throw would put a decryption-failure stack somewhere a log could catch it,
   * and the message would name the row.
   */
  open(sealed: SealedSecret, binding: SecretBinding): Buffer | undefined {
    const key = this.#keys.get(sealed.keyVersion);
    if (key === undefined) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
      decipher.setAAD(associatedData(binding));
      decipher.setAuthTag(sealed.tag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
    } catch {
      return undefined;
    }
  }
}

/**
 * Builds the box this process should use.
 *
 * `SP_AUTHN_MFA_KEY_V<n>` holds a base64 32-byte key; `SP_AUTHN_MFA_KEY_VERSION`
 * names the version new secrets are sealed under. **No key is defaulted to a
 * constant**, for the reason `createCheckpointSigner` gives: a committed
 * development key is a key that eventually encrypts something in production.
 *
 * When no key is configured an ephemeral one is generated for the process. That
 * is honest rather than convenient: enrolments written under it are unreadable
 * after a restart, which is the correct outcome for a deployment that never
 * configured key custody, and it is exactly what a test wants.
 */
export function createSecretBox(env: NodeJS.ProcessEnv = process.env): SecretBox {
  const keys = new Map<number, Buffer>();
  for (const [name, value] of Object.entries(env)) {
    const match = /^SP_AUTHN_MFA_KEY_V(\d+)$/.exec(name);
    if (match === null || value === undefined || value === '') continue;
    const version = Number(match[1]);
    const key = Buffer.from(value, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `${name} decodes to ${String(key.length)} bytes; AES-256-GCM needs ${String(KEY_BYTES)}. ` +
          'The value must be base64 of exactly 32 random bytes.',
      );
    }
    keys.set(version, key);
  }

  if (keys.size === 0) {
    keys.set(1, randomBytes(KEY_BYTES));
    return new SecretBox(keys, 1);
  }

  const declared = env['SP_AUTHN_MFA_KEY_VERSION'];
  const version = declared === undefined || declared === '' ? Math.max(...keys.keys()) : Number(declared);
  if (!keys.has(version)) {
    throw new Error(
      `SP_AUTHN_MFA_KEY_VERSION is ${String(version)} but no SP_AUTHN_MFA_KEY_V${String(version)} is set`,
    );
  }
  return new SecretBox(keys, version);
}
