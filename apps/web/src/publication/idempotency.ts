import { useCallback, useState } from 'react';

/**
 * The publication idempotency key: minted once per publication ATTEMPT-SET, and
 * retained across every retry of it (D-17, FAD-22(3)).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Why this is a module of its own
 *
 * It is the single point at which the client decides whether a retry is the same
 * publication or a new one, and getting that wrong is invisible in the interface
 * and catastrophic in the data:
 *
 *  - **Retained** (correct): the second request carries the same key, the server
 *    finds its own `publication_records` row, and returns the RECORDED result
 *    with `replay: true`. No second outbox event, no second audit row, no second
 *    supersession. The user sees "already published" and the truth.
 *  - **Regenerated** (the defect): the second request carries a fresh key, so
 *    D-17's unique constraint does not fire, the version is published a SECOND
 *    time, and the publication that had just happened is instantly superseded by
 *    an identical one. History gains a version nobody authored, and every staff
 *    member on the schedule is notified twice.
 *
 * The second behaviour is what a double-click or a retry-after-timeout produces
 * from a client that mints its key at request time, and it looks completely
 * normal from the browser. So the key generation is isolated here and the
 * retention is **red-cased**: `scripts/red-cases/run.mjs` case
 * `publish-idempotency-key-retained` replaces the retained key with a freshly
 * minted one and the e2e assertion that a retry carries the same key must fail.
 *
 * ## Why not `crypto.randomUUID()`
 *
 * `randomUUID` is only exposed in a secure context. `getRandomValues` is not, so
 * the key is available identically wherever the application runs, and the
 * alphabet below is exactly the domain `PUBLICATION_IDEMPOTENCY_KEY_PATTERN`
 * accepts (`[A-Za-z0-9_.-]{1,64}`) — no escaping, no colon, and no chance of
 * forging a field boundary in the composed outbox key
 * (`schedule-publish:<period>:<key>`).
 *
 * ## No third party, no storage that outlives the tab
 *
 * The key never leaves this process except in the request body it belongs to,
 * and it is held in component state rather than in `localStorage`: a key that
 * outlived the tab would make a publication attempted last week replay silently
 * today, which is a stale confirmation and not an idempotent retry.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A fresh key. 32 characters of the accepted alphabet — ~190 bits, far beyond
 * what a collision within one period would need, and comfortably inside the
 * 64-character domain.
 *
 * Rejection sampling rather than `byte % 62`, because the modulo bias would make
 * the first four letters measurably likelier than the rest. That does not matter
 * for collision resistance at this length; it is written correctly anyway
 * because "biased but probably fine" is not a property anyone should have to
 * re-derive when reading this.
 */
export function newPublicationIdempotencyKey(length = 32): string {
  const out: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);
  const buffer = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (out.length >= length) break;
      if (byte >= limit) continue;
      out.push(ALPHABET[byte % ALPHABET.length] as string);
    }
  }
  return out.join('');
}

export interface RetainedIdempotencyKey {
  /** The key every attempt of THIS publication carries, retries included. */
  readonly key: string;
  /**
   * Mint a new one, because this is a DIFFERENT publication.
   *
   * Called when the surface moves to another version — never on a retry, and
   * never on a refused attempt: a publication refused by the compare-and-set, by
   * the friction check or by a dropped connection may or may not have committed,
   * and re-using the key is exactly what makes the answer to that question safe.
   */
  readonly renew: () => void;
}

/**
 * Hold one key for as long as the surface is publishing one thing.
 *
 * `subject` is the version (or period) being published: when it changes, the key
 * is renewed, because publishing a different version with the previous version's
 * key would be refused by the server as
 * `IDEMPOTENCY_KEY_REUSED_FOR_DIFFERENT_VERSION` — correctly, but for a reason
 * the user could not act on.
 */
export function useRetainedIdempotencyKey(subject: string): RetainedIdempotencyKey {
  const [held, setHeld] = useState(() => ({ subject, key: newPublicationIdempotencyKey() }));

  /* Render-phase adjustment, React's documented pattern for state derived from a
   * prop that changed — and `current` is returned rather than `held`, so even
   * the render that triggers the update hands back the key that belongs to THIS
   * subject. An effect would leave one render in which the key belongs to the
   * previous version, and that render is exactly the one in which an impatient
   * user can click Publish. */
  let current = held;
  if (held.subject !== subject) {
    current = { subject, key: newPublicationIdempotencyKey() };
    setHeld(current);
  }

  const renew = useCallback(() => {
    setHeld({ subject, key: newPublicationIdempotencyKey() });
  }, [subject]);

  return { key: current.key, renew };
}
