import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';

import type { CheckpointSignature, CheckpointSigner } from '@schedulepoint/domain';

/**
 * The checkpoint signer — **a local development STUB**, per FAD-7.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## READ THIS BEFORE TREATING A SIGNED CHECKPOINT AS EVIDENCE
 *
 * SPEC-11 §2 requires checkpoints to be "signed with a key the application role
 * cannot read", and §6 puts that key in a **separate trust domain**, accessible
 * to a signing service and "never the application". TDG-15 selects KMS for it.
 *
 * **This implementation holds the private key in the application process.** It
 * therefore satisfies the *mechanism* and **none of the assurance**: an actor who
 * can rewrite `audit_events` in a deployment using this signer can also read the
 * key and re-sign the checkpoints, which is precisely the attack SPEC-11 §2 says
 * checkpoints defeat. `keyIsIsolated` returns **`false`**, and that flag exists
 * so a deployment check can refuse to start rather than a reader having to
 * remember this paragraph.
 *
 * **Real KMS is a named CI/deployment condition** (`docs/evidence/EV-M1-AUDIT/
 * INDEX.md` §5). Until it is met, a signed checkpoint in this system proves that
 * the signing path works, and nothing about who could have produced it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ## Why ed25519, and why the key is not in the repository
 *
 * ed25519 is TDG-15's local/dev choice: deterministic, small signatures, no
 * parameter choices to get wrong, and in Node's standard library so the stub
 * adds no dependency. The key is read from `SP_AUDIT_SIGNING_KEY_PEM` or
 * generated in memory for a test run — **never** written to disk and never
 * defaulted to a constant, because a committed development key is a key that
 * eventually signs something in production.
 */

export interface LocalCheckpointSignerOptions {
  /** PKCS#8 PEM. When absent, an ephemeral key is generated for this process. */
  readonly privateKeyPem?: string;
  /**
   * Names the key in the `audit_checkpoints.key_id` column so a rotated key does
   * not make old checkpoints unverifiable (SPEC-11 §6).
   */
  readonly keyId?: string;
}

export class LocalCheckpointSigner implements CheckpointSigner {
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  readonly keyId: string;

  /**
   * **`false`, always, and it is not a configuration option.**
   *
   * A stub that could be told it was isolated would eventually be told so by
   * someone in a hurry.
   */
  readonly keyIsIsolated = false;

  constructor(options: LocalCheckpointSignerOptions = {}) {
    if (options.privateKeyPem !== undefined && options.privateKeyPem !== '') {
      this.#privateKey = createPrivateKey(options.privateKeyPem);
    } else {
      this.#privateKey = generateKeyPairSync('ed25519').privateKey;
    }
    this.#publicKey = createPublicKey(this.#privateKey);
    this.keyId = options.keyId ?? 'local-dev-stub';
  }

  /** The verification half. Retained across rotation in a real deployment. */
  publicKeyPem(): string {
    return this.#publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  sign(message: Uint8Array): Promise<CheckpointSignature> {
    // ed25519 signs the message itself; the algorithm argument must be null.
    const signature = edSign(null, message, this.#privateKey);
    return Promise.resolve({
      keyId: this.keyId,
      algorithm: 'ed25519',
      signature: signature.toString('hex'),
    });
  }

  verify(message: Uint8Array, signature: CheckpointSignature): Promise<boolean> {
    if (signature.algorithm !== 'ed25519') return Promise.resolve(false);
    if (signature.keyId !== this.keyId) {
      // A checkpoint signed by a key this signer does not hold is not "invalid";
      // it is unverifiable BY THIS SIGNER. Returning `false` is the fail-closed
      // answer, and the key id is in the row so an operator can tell the two
      // apart. A real KMS-backed signer resolves the key id instead.
      return Promise.resolve(false);
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(signature.signature, 'hex');
    } catch {
      return Promise.resolve(false);
    }
    return Promise.resolve(edVerify(null, message, this.#publicKey, bytes));
  }
}

/**
 * Builds the signer this process should use.
 *
 * There is deliberately **no** branch here that returns a KMS-backed signer:
 * writing an untested code path for a service that does not exist yet is worse
 * than its absence (the same reasoning SP-A's report gives for not writing an
 * `SPIKE_PG_MODE=external` branch). When TDG-15's KMS lands it is a new class
 * implementing `CheckpointSigner` and a branch here, both under test.
 */
export function createCheckpointSigner(): LocalCheckpointSigner {
  const pem = process.env['SP_AUDIT_SIGNING_KEY_PEM'];
  const keyId = process.env['SP_AUDIT_SIGNING_KEY_ID'];
  return new LocalCheckpointSigner({
    ...(pem === undefined || pem === '' ? {} : { privateKeyPem: pem }),
    ...(keyId === undefined || keyId === '' ? {} : { keyId }),
  });
}
