/**
 * SPEC-08 §4's fifth row — the COMMENT vocabulary and its two channels, under
 * **FAD-58** (OPUS-M5-00C, doc 42 §5g).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## This file states VOCABULARY and RULES. It enforces nothing
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `packages/domain` imports NOTHING — no clock, no database handle, no
 * configuration — so every function here is a pure question about values. The
 * enforcement of the same rules lives in migration 0026's CHECK constraints and
 * in `apps/api/src/requests/comments.ts`, and the agreement between the layers
 * is asserted by test rather than assumed, exactly as `./decisions.ts` and
 * `approvals_reason_mandatory_where_stated` are.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## Two channels, and why they are not symmetrical
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * FAD-58 ruled the question OPUS-M5-002 escalated. Its first two points, which
 * are the whole shape of this module:
 *
 *  1. **The requester-side channel is a CONTROLLED VOCABULARY, permanently.**
 *     I-07's sentence is not patient-scoped — *"no patient-identifying
 *     information **or clinical free text** enters the system"* — and in this
 *     product the honest answer to "why that Friday?" is frequently a medical
 *     one. A length bound bounds SIZE, not KIND. So the requester attaches at
 *     most one reason CODE per turn (I-16: one turn, one accepted code, one
 *     transaction) and there is **no "other, specify" field**: `other` is a
 *     TERMINAL code, because such a field would be the free-text channel under
 *     another name.
 *  2. **The scheduler-side channel joins the existing administrative
 *     bounded-text class** — `schedule_versions.change_summary`,
 *     `vacation_selections.override_reason`, `approvals.reason`. Bounded free
 *     text, author and instant recorded, on the request aggregate.
 *
 * The asymmetry is the ruling, not an accident of implementation. A single
 * "comment text" field with a code beside it would be the requester channel
 * wearing the scheduler channel's clothes.
 *
 * ## What a comment is NOT
 *
 * **It is not a lifecycle operation.** `./lifecycle.ts`'s `REQUEST_OPERATIONS`
 * are the verbs that MOVE a row, and every one of them answers with the status
 * it moves to. A comment moves nothing: appending one leaves `requests.status`
 * and `requests.version` byte-identical. So `comment` is deliberately not a
 * member of that list — adding it would mean inventing a target status for an
 * operation that has none, and the R-01 cross-product would then assert
 * something false about every (subtype × status) pair. The both-layers
 * obligation is discharged where it genuinely bites instead: the channel rule
 * below and migration 0026's CHECKs enforce the same thing independently, and
 * either one alone is provably load-bearing.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * The two channels
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Who authored a comment, and therefore which content it may carry.
 *
 * A closed set with exactly two members, because FAD-58 rules exactly two
 * channels. It is a property of the ROW rather than a lookup on the author: a
 * scheduler who is also the requester of the request they are commenting on
 * writes on the `requester` channel for their own request, and that is the
 * correct answer — the channel says what KIND of statement this is, not who
 * happened to type it.
 */
export const COMMENT_CHANNELS = ['requester', 'scheduler'] as const;

export type CommentChannel = (typeof COMMENT_CHANNELS)[number];

/* ────────────────────────────────────────────────────────────────────────────
 * FAD-58.1's controlled vocabulary
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **The requester's reason codes — a `SCHEDULEPOINT-REQUIREMENT`, extensible
 * only by a recorded decision.**
 *
 * These are not observed from any source product and are not inferred from one;
 * they are this product's own curated, non-clinical vocabulary, designed to give
 * a requester a real answer to "why that Friday?" that is not the medical one.
 * The curation reasoning lives beside the wire schema in
 * `packages/contracts/src/requests/index.ts`, because that is where a client
 * author meets the list; the two copies and migration 0026's CHECK domain are
 * held to each other as sets by the api suite.
 *
 * **The absence of a medical or sick code is the design.** See the contracts
 * docblock: a requester whose reason is medical selects `personal` or `other`
 * and discloses nothing, which is the entire purpose of FAD-58.1. A future
 * packet must not "helpfully" add one.
 *
 * `other` is TERMINAL — it carries no companion text field anywhere in the
 * stack, at any layer. That is the rule, and `commentContentIsWellFormed` below
 * is its shape as a predicate.
 */
export const REQUEST_REASON_CODES = [
  /** A personal commitment the requester does not further describe. */
  'personal',
  /** A family commitment. */
  'family',
  /** Care for a child or dependant. */
  'childcare',
  /** A death and the arrangements around it. */
  'bereavement',
  /** Travel, or being away from the area. */
  'travel',
  /** A course, a conference, an examination. */
  'education',
  /** A religious observance. */
  'religious-observance',
  /** A professional or administrative commitment elsewhere. */
  'professional-obligation',
  /** No further statement. **TERMINAL** — there is no "specify" field. */
  'other',
] as const;

export type RequestReasonCode = (typeof REQUEST_REASON_CODES)[number];

const REASON_CODES: ReadonlySet<string> = new Set(REQUEST_REASON_CODES);

/** Whether a value is one of the nine codes. The only way in. */
export function isRequestReasonCode(value: string): value is RequestReasonCode {
  return REASON_CODES.has(value);
}

/* ────────────────────────────────────────────────────────────────────────────
 * FAD-58.2's bounded administrative text
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The bound on a scheduler comment, matching migration 0026's CHECK and
 * `approvals.reason` / `vacation_selections.override_reason` /
 * `schedule_versions.change_summary` before it.
 *
 * The same number because it is the same class of text — scheduler-authored,
 * bounded, administrative, never clinical, never an ingestion path (non-bypass
 * rule 8). A bound is what keeps "an administrative note" from becoming a
 * document store.
 */
export const COMMENT_BODY_MAX_LENGTH = 1000;

/** Whether a body is a shape migration 0026 will accept. Trimmed, bounded, non-empty. */
export function commentBodyIsWellFormed(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.length >= 1 && trimmed.length <= COMMENT_BODY_MAX_LENGTH;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The exactly-one-of rule — the domain half of R-01's double enforcement
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What one comment carries. A discriminated union on the channel, so the two
 * illegal shapes are not expressible.
 *
 * **The type is the boundary.** There is no member on the `requester` arm that
 * could hold text and no member on the `scheduler` arm that could hold a code,
 * so a caller cannot construct the mixed shapes at all — and a reader auditing
 * "can a requester put prose into this system" reads one declaration rather than
 * four call sites. `commentContentIsWellFormed` is for the values that arrive
 * from outside the type system, where a database row or a wire body has to be
 * checked rather than trusted.
 */
export type CommentContent =
  | { readonly channel: 'requester'; readonly reasonCode: RequestReasonCode }
  | { readonly channel: 'scheduler'; readonly body: string };

/** Why a comment's content was refused — a closed vocabulary, so a caller can branch. */
export const COMMENT_REFUSAL_REASONS = [
  /** The channel is not one of the two FAD-58 rules. */
  'channel-not-in-domain',
  /** A requester comment named a code the vocabulary does not contain. */
  'reason-code-not-in-vocabulary',
  /** A scheduler comment's body is empty, whitespace, or over the bound. */
  'body-not-well-formed',
  /**
   * A requester row carried a body, or a scheduler row carried a code.
   *
   * The refusal FAD-58.1 exists for. Migration 0026's
   * `request_comments_requester_channel_is_a_code` and
   * `request_comments_scheduler_channel_is_text` refuse the same two shapes,
   * independently, in the database.
   */
  'channel-content-mismatch',
] as const;

export type CommentRefusalReason = (typeof COMMENT_REFUSAL_REASONS)[number];

export type CommentContentVerdict =
  | { readonly ok: true; readonly content: CommentContent }
  | { readonly ok: false; readonly reason: CommentRefusalReason };

/**
 * **The exactly-one-of rule, in both directions**, over values that have not
 * been through the type system.
 *
 * A requester comment carries a code and NO body; a scheduler comment carries a
 * body and NO code. Migration 0026 says the same thing as two CHECKs written in
 * both directions, and the api suite proves each layer refuses on its own — kill
 * either copy and the other still holds, which is what makes this two layers
 * rather than one layer and a comment.
 *
 * The both-directions half is the part worth defending. A rule that only forbade
 * a body on a requester row would still admit a scheduler row carrying a CODE —
 * a decider attributing a circumstance to the person whose request it is, which
 * is the specific outcome FAD-58.1 exists to prevent.
 *
 * **Nothing here decides WHO may comment.** That is SPEC-06's, evaluated against
 * current state inside the unit of work (I-19), and the route's declared action
 * key is where it lives. This function decides whether a comment is
 * well-formed — a question about the VALUES.
 */
export function commentContentIsWellFormed(candidate: {
  readonly channel: string;
  readonly reasonCode?: string | null;
  readonly body?: string | null;
}): CommentContentVerdict {
  const { channel } = candidate;
  const reasonCode = candidate.reasonCode ?? null;
  const body = candidate.body ?? null;

  if (channel !== 'requester' && channel !== 'scheduler') {
    return { ok: false, reason: 'channel-not-in-domain' };
  }

  if (channel === 'requester') {
    /* Checked BEFORE the code's membership, deliberately: a requester row
     * carrying prose is the FAD-58 violation, and reporting it as an unknown
     * code would name the wrong defect to whoever reads the refusal. */
    if (body !== null) return { ok: false, reason: 'channel-content-mismatch' };
    if (reasonCode === null) return { ok: false, reason: 'channel-content-mismatch' };
    if (!isRequestReasonCode(reasonCode)) {
      return { ok: false, reason: 'reason-code-not-in-vocabulary' };
    }
    return { ok: true, content: { channel: 'requester', reasonCode } };
  }

  if (reasonCode !== null) return { ok: false, reason: 'channel-content-mismatch' };
  if (body === null) return { ok: false, reason: 'channel-content-mismatch' };
  if (!commentBodyIsWellFormed(body)) return { ok: false, reason: 'body-not-well-formed' };
  return { ok: true, content: { channel: 'scheduler', body } };
}

/* ────────────────────────────────────────────────────────────────────────────
 * What a comment PUBLISHES — the closed set (I-07, FAD-58.5)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Everything a comment puts into an audit payload.
 *
 * **The type is the boundary**, exactly as `DecisionAuditFacts` is. There is no
 * `body` member, no `reasonCode` member and no index signature, so a caller
 * cannot widen it without editing this declaration — and a reader auditing "what
 * does a comment disclose" reads one type rather than a call site.
 *
 * The two absences are NOT the same strength, and the difference is the reason
 * this type exists rather than being obvious:
 *
 *  * **`body` could not be here anyway.** `auditPayloadViolations` rejects any
 *    payload string containing a space or over 64 characters, and
 *    `app_audit_payload_is_closed` rejects the same in SQL. Prose contains
 *    spaces. The control is mechanical and holds for a writer nobody has written.
 *  * **`reasonCode` COULD be here and deliberately is not.** A code is a token —
 *    `childcare` has no space and is well under 64 characters — so the validator
 *    would admit it. Its absence is a ruled CHOICE: the audit chain is immutable
 *    and has its own reader population behind `audit.export`, so a code in a
 *    payload would put a fact about the requester's circumstances somewhere the
 *    comment table's own RLS does not reach. Narrower-never-wider. **The chain
 *    records THAT a code was attached, by whom and when — never WHICH.**
 *
 * There is no outbox counterpart, because FAD-58.5 enqueues nothing on this
 * surface at all (I-11's posture untouched; an outbound surface is a later
 * packet against SPEC-07).
 */
export interface CommentAuditFacts {
  readonly requestId: string;
  readonly commentId: string;
  readonly channel: CommentChannel;
}
