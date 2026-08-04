/**
 * OPUS-M3-003 — the publication spine's wire shapes (SPEC-05).
 *
 * The module ships no HTTP surface this packet (the scheduler-facing routes are
 * OPUS-M3-004/005/006), so what lives here is the part that must be true
 * regardless of transport: the idempotency-key domain and the publication
 * request's required compare-and-set, both ratified by FAD-22.
 */
export {
  PUBLICATION_IDEMPOTENCY_KEY_PATTERN,
  publicationIdempotencyKeySchema,
  publishVersionRequestSchema,
  type PublicationIdempotencyKey,
  type PublishVersionRequest,
} from './publication.js';
