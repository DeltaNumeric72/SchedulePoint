import {
  conflictBodySchema,
  isUuid,
  ruleAmendSchema,
  ruleListSchema,
  ruleResultSchema,
  ruleRevisionListSchema,
  ruleSetAmendSchema,
  ruleSetListSchema,
  ruleSetResultSchema,
  ruleSetWriteSchema,
  ruleStateRequestSchema,
  ruleWriteSchema,
  staleRuleBodySchema,
  validationProblemBodySchema,
  type ConflictBody,
} from '@schedulepoint/contracts';
import type { AuditEventName, AuditPayload, Decision, RuleProblem } from '@schedulepoint/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { recordAuditEvent } from '../../audit/recorder.js';
import { evaluateInTransaction, respondToDenial } from '../../authz/authorize-request.js';
import { PG_ERRORS, isPostgresError } from '../../db/pg-errors.js';
import { RULES_AUDIT_EVENTS, RULE_CONFIG, RULE_SET_CONFIG } from '../../rules/policies.js';
import * as rules from '../../rules/service.js';
import type { RuleOutcome } from '../../rules/service.js';
import { requireTenantContext } from '../context/middleware.js';
import { sendNotFound } from '../context/responses.js';

/**
 * The typed rule model's HTTP surface (OPUS-M3-002; CAP-015, CAP-045, CAR-006).
 *
 * ## The shape every mutating route has, and why it never varies
 *
 * ```
 * runtime.run(command, async (uow) => {
 *   const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
 *   if (!decision.allowed) return denied(decision);   // nothing written
 *   … the mutation …
 *   await recordAuditEvent(uow, { eventName, subjectType, subjectId });
 * })
 * ```
 *
 * FAD-12's ordering — **evaluate → deny → mutate → audit, in ONE unit of work**
 * — identical to `catalogue.route.ts`, deliberately: the two slices having the
 * same shape is what makes a deviation visible in review. The evaluation is
 * first so a denial writes neither the change nor an audit row claiming one; the
 * audit write is last and inside the same transaction, so the two commit or roll
 * back together; and the verdict is against current state inside the transaction
 * that writes (I-19).
 *
 * ## Body parsing happens INSIDE the unit of work, after the verdict
 *
 * The SBX-001 disclosure finding, applied here from the start rather than
 * rediscovered: parsing first lets an actor who holds nothing in this group send
 * `{}` and receive a `400` describing the body, while a genuinely absent route
 * answers `404`. Those two must be indistinguishable (SPEC-01 §2.4, SPEC-06 P-3).
 *
 * ## `path` on the domain problem, `field` on the wire
 *
 * `RuleProblem.path` is a dotted address into the AST (`predicate.segments.0.
 * shiftType`) because a rule is a tree and a flat field name cannot address one.
 * The existing `validationProblemBodySchema` calls it `field`, and it is reused
 * rather than forked — one validation envelope for the whole product, with the
 * dotted path as its value. The authoring form links its `role="alert"` summary
 * to the control by that path.
 */

type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'denied'; readonly decision: Decision }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'invalid'; readonly problems: readonly RuleProblem[] }
  /**
   * OPUS-M4-000C (doc 34 §4-D). The author's `expectedVersion` is not the row's
   * current one, so somebody else amended the rule between the load and the
   * save. `409 STALE_RULE`, carrying the CURRENT version so the editor can
   * re-fetch and show what moved.
   *
   * Deliberately NOT folded into `conflict`: the generic 409 says "the request
   * could not be completed" and carries nothing, which leaves an author with no
   * way to recover and no way to tell a stale edit from a duplicate key.
   */
  | { readonly kind: 'stale'; readonly currentVersion: number };

/**
 * The wire contract caps a problem message at 300 characters
 * (`fieldProblemSchema`), and one zod issue blows straight through it: an
 * unknown predicate `kind` produces a message that enumerates all **thirty**
 * discriminator options, around 700 characters. Passing it through made the
 * response body fail its own schema and the route answer **500** — for the one
 * request shape this slice most needs to answer cleanly, the escape-hatch
 * attempt.
 *
 * So the discriminator issue gets a short, product-shaped sentence and every
 * other message is clamped. Both are improvements rather than workarounds: the
 * closed node set is documented, not something to recite into a 422, and a
 * validation message is for a person reading a form.
 */
const MAX_PROBLEM_MESSAGE = 300;

function problemMessage(issue: { code?: string; message: string }): string {
  if (issue.code === 'invalid_union_discriminator') {
    return 'A recognised rule node is required.';
  }
  return issue.message.length > MAX_PROBLEM_MESSAGE
    ? `${issue.message.slice(0, MAX_PROBLEM_MESSAGE - 1)}…`
    : issue.message;
}

/** Parses a body into the rule outcome shape. Called after the verdict. */
function parseBody<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  body: unknown,
): RuleOutcome<T> {
  const parsed = schema.safeParse(body);
  if (parsed.success && parsed.data !== undefined) return { kind: 'ok', value: parsed.data };

  const issues =
    (
      parsed.error as
        | { issues?: { path: (string | number)[]; message: string; code?: string }[] }
        | undefined
    )?.issues ?? [];
  const problems = issues.slice(0, 40).map((issue) => ({
    // The FULL dotted path, not just its head: a rule is a tree, and
    // `predicate` alone does not tell an author which segment is wrong. Clamped
    // to the contract's 64-character field limit for the same reason the message
    // is clamped — a deeply nested array index must not fail the response schema.
    path: (issue.path.length > 0 ? issue.path.join('.') : 'body').slice(0, 64),
    message: problemMessage(issue),
  }));
  return {
    kind: 'invalid',
    problems:
      problems.length > 0
        ? problems
        : [{ path: 'body', message: 'The request body is not valid.' }],
  };
}

/** SQLSTATE 23505 — a row with this tenant-qualified key already exists. */
function isUniqueViolation(error: unknown): boolean {
  return isPostgresError(error) && error.code === PG_ERRORS.uniqueViolation;
}

/**
 * Runs one rule command under FAD-12's ordering.
 *
 * `audit` is called only when the command reports `ok`, and INSIDE the same unit
 * of work — so there is no path on which a mutation commits without its audit
 * row, and none on which an audit row survives a rolled-back mutation.
 */
async function withRuleCommand<T>(
  request: FastifyRequest,
  run: (
    uow: Parameters<Parameters<FastifyRequest['server']['tenancy']['runtime']['run']>[1]>[0],
  ) => Promise<RuleOutcome<T>>,
  audit: (value: T) => {
    eventName: AuditEventName;
    subjectType: string;
    subjectId: string;
    /** Identifiers, tokens and counts only. Never rule free text (I-07). */
    payload?: AuditPayload;
  } | null,
): Promise<Outcome<T>> {
  const { context, command, route } = requireTenantContext(request);

  return request.server.tenancy.runtime.run(command, async (uow): Promise<Outcome<T>> => {
    const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
    if (!decision.allowed) return { kind: 'denied', decision };

    let outcome: RuleOutcome<T>;
    try {
      outcome = await run(uow);
    } catch (error) {
      // A NON-database fault is re-thrown to `setErrorHandler`, which logs it
      // with its stack and answers 500 with the fixed message. Catching
      // everything would turn a bug in this process into a 404 carrying a log
      // line that asserted "refused by the database" about an unexamined cause
      // (catalogue review finding V-02, applied here from the start).
      if (!isPostgresError(error)) throw error;
      if (isUniqueViolation(error)) return { kind: 'conflict' };
      request.log.warn(
        { correlationId: request.correlationId, sqlstate: error.code },
        'rule statement refused by the database',
      );
      return { kind: 'not-found' };
    }

    if (outcome.kind !== 'ok') return outcome;

    const entry = audit(outcome.value);
    if (entry !== null) {
      await recordAuditEvent(uow, {
        eventName: entry.eventName,
        subjectType: entry.subjectType as never,
        subjectId: entry.subjectId,
        ...(entry.payload === undefined ? {} : { payload: entry.payload }),
      });
    }
    return { kind: 'ok', value: outcome.value };
  });
}

/** A read: authorize inside the unit of work, then read. No audit row for a read. */
async function withRuleQuery<T>(
  request: FastifyRequest,
  run: (
    uow: Parameters<Parameters<FastifyRequest['server']['tenancy']['runtime']['run']>[1]>[0],
  ) => Promise<T>,
): Promise<Outcome<T>> {
  const { context, command, route } = requireTenantContext(request);

  return request.server.tenancy.runtime.run(command, async (uow): Promise<Outcome<T>> => {
    const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
    if (!decision.allowed) return { kind: 'denied', decision };
    try {
      return { kind: 'ok', value: await run(uow) };
    } catch (error) {
      if (!isPostgresError(error)) throw error;
      request.log.warn(
        { correlationId: request.correlationId, sqlstate: error.code },
        'rule read refused by the database',
      );
      return { kind: 'not-found' };
    }
  });
}

function respond<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  outcome: Outcome<T>,
  body: (value: T) => unknown,
): FastifyReply | unknown {
  if (outcome.kind === 'denied') return respondToDenial(request, reply, outcome.decision);
  if (outcome.kind === 'not-found') return sendNotFound(request, reply);
  if (outcome.kind === 'conflict') {
    return reply.code(409).send(
      conflictBodySchema.parse({
        error: {
          code: 'CONFLICT',
          message: 'The request could not be completed.',
          correlationId: request.correlationId,
        },
      } satisfies ConflictBody),
    );
  }
  if (outcome.kind === 'stale') {
    return reply.code(409).send(
      staleRuleBodySchema.parse({
        error: {
          code: 'STALE_RULE',
          message:
            'This rule changed while you were editing it. Reload it and apply your change again.',
          currentVersion: outcome.currentVersion,
        },
        correlationId: request.correlationId,
      }),
    );
  }
  if (outcome.kind === 'invalid') {
    return reply.code(422).send(
      validationProblemBodySchema.parse({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some of the details need attention.',
          correlationId: request.correlationId,
          // `path` → `field`: one validation envelope for the product, carrying
          // the dotted AST address as its value. See this file's header.
          problems: outcome.problems.map((problem) => ({
            field: problem.path,
            message: problem.message,
          })),
        },
      }),
    );
  }
  return body(outcome.value);
}

/** The audit event a lifecycle move is filed under. One name per transition. */
function stateEvent(state: 'active' | 'disabled' | 'archived'): AuditEventName {
  if (state === 'disabled') return RULES_AUDIT_EVENTS.ruleDisabled;
  if (state === 'archived') return RULES_AUDIT_EVENTS.ruleArchived;
  return RULES_AUDIT_EVENTS.ruleEnabled;
}

export default function rulesRoutes(app: FastifyInstance): void {
  const base = '/organizations/:organizationId/groups/:groupId/rules';

  /* ── rules ──────────────────────────────────────────────────── CAP-015 ── */

  app.get(base, { config: RULE_CONFIG }, async (request, reply) => {
    const outcome = await withRuleQuery(request, (uow) => rules.listRules(uow));
    return respond(request, reply, outcome, (list) =>
      ruleListSchema.parse({ rules: list, correlationId: request.correlationId }),
    );
  });

  app.post(base, { config: RULE_CONFIG }, async (request, reply) => {
    const outcome = await withRuleCommand(
      request,
      async (uow) => {
        const parsed = parseBody(ruleWriteSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        return rules.createRule(uow, parsed.value);
      },
      (created) => ({
        eventName: RULES_AUDIT_EVENTS.ruleCreated,
        subjectType: 'rule',
        // `audit_events.subject_id` is a uuid column, so the subject is the row
        // id. The STABLE `rule_key` travels in the closed payload beside it —
        // identifiers only, never rule content (I-07) — so an investigation can
        // still ask "everything that happened to this rule_key" without the
        // audit module being changed (it is frozen to this packet).
        subjectId: created.id,
        payload: { ruleKey: created.ruleKey },
      }),
    );
    return respond(request, reply, outcome, (created) =>
      ruleResultSchema.parse({ rule: created.rule, correlationId: request.correlationId }),
    );
  });

  app.get(`${base}/:ruleKey`, { config: RULE_CONFIG }, async (request, reply) => {
    const { ruleKey } = request.params as { ruleKey?: string };
    const outcome = await withRuleQuery(request, async (uow) =>
      ruleKey === undefined ? { kind: 'not-found' as const } : rules.getRule(uow, ruleKey),
    );
    if (outcome.kind === 'ok' && outcome.value.kind !== 'ok') return sendNotFound(request, reply);
    return respond(request, reply, outcome, (result) =>
      result.kind === 'ok'
        ? ruleResultSchema.parse({ rule: result.value, correlationId: request.correlationId })
        : sendNotFound(request, reply),
    );
  });

  app.put(`${base}/:ruleKey`, { config: RULE_CONFIG }, async (request, reply) => {
    const { ruleKey } = request.params as { ruleKey?: string };
    const outcome = await withRuleCommand(
      request,
      async (uow) => {
        if (ruleKey === undefined) return { kind: 'not-found' as const };
        // `ruleAmendSchema`, not `ruleWriteSchema`: an amendment carries the
        // version the author was looking at, and it is REQUIRED (FAD-22(2)'s
        // reasoning applied to rules — an optional compare-and-set is
        // indistinguishable from a caller that never thought about concurrency).
        const parsed = parseBody(ruleAmendSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        const { expectedVersion, ...write } = parsed.value;
        return rules.updateRule(uow, ruleKey, write, expectedVersion);
      },
      (mutation) => ({
        eventName: RULES_AUDIT_EVENTS.ruleUpdated,
        subjectType: 'rule',
        subjectId: mutation.id,
        payload: { ruleKey: mutation.ruleKey },
      }),
    );
    return respond(request, reply, outcome, (mutation) =>
      ruleResultSchema.parse({ rule: mutation.rule, correlationId: request.correlationId }),
    );
  });

  app.put(`${base}/:ruleKey/state`, { config: RULE_CONFIG }, async (request, reply) => {
    const { ruleKey } = request.params as { ruleKey?: string };
    let requested: 'active' | 'disabled' | 'archived' = 'active';
    const outcome = await withRuleCommand(
      request,
      async (uow) => {
        if (ruleKey === undefined) return { kind: 'not-found' as const };
        const parsed = parseBody(ruleStateRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        requested = parsed.value.state;
        return rules.setRuleState(uow, ruleKey, parsed.value.state, parsed.value.expectedVersion);
      },
      (mutation) => ({
        eventName: stateEvent(requested),
        subjectType: 'rule',
        subjectId: mutation.id,
        payload: { ruleKey: mutation.ruleKey, state: requested },
      }),
    );
    return respond(request, reply, outcome, (mutation) =>
      ruleResultSchema.parse({ rule: mutation.rule, correlationId: request.correlationId }),
    );
  });

  /**
   * The rule's revision history (OPUS-M4-000C, doc 34 §4-D).
   *
   * A read, under the same `RULE_CONFIG` policy as reading the rule itself:
   * seeing what a rule USED to say is exactly as sensitive as seeing what it
   * says now, and a second, looser policy for history is how a permission
   * surface acquires a hole.
   *
   * The list carries metadata only — key, revision, name, classification,
   * weight, state, timestamp — and NOT the stored AST. A build that needs the
   * exact predicate of a historical revision reads it through
   * `loadRuleRevision` on the server; shipping every historical predicate to a
   * list view would be a payload nobody asked for on a screen that only needs to
   * say what changed and when.
   */
  app.get(`${base}/:ruleKey/revisions`, { config: RULE_CONFIG }, async (request, reply) => {
    const { ruleKey } = request.params as { ruleKey?: string };
    const outcome = await withRuleQuery(request, async (uow) =>
      ruleKey === undefined ? [] : rules.listRuleRevisions(uow, ruleKey),
    );
    return respond(request, reply, outcome, (revisions) =>
      ruleRevisionListSchema.parse({
        revisions: revisions.map((revision) => ({
          ...revision,
          recordedAt: revision.recordedAt.toISOString(),
        })),
        correlationId: request.correlationId,
      }),
    );
  });

  /* ── rule sets ──────────────────────────────────────────────── CAP-045 ── */

  app.get(`${base}-sets`, { config: RULE_SET_CONFIG }, async (request, reply) => {
    const outcome = await withRuleQuery(request, (uow) => rules.listRuleSets(uow));
    return respond(request, reply, outcome, (ruleSets) =>
      ruleSetListSchema.parse({ ruleSets, correlationId: request.correlationId }),
    );
  });

  app.post(`${base}-sets`, { config: RULE_SET_CONFIG }, async (request, reply) => {
    const outcome = await withRuleCommand(
      request,
      async (uow) => {
        const parsed = parseBody(ruleSetWriteSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        return rules.createRuleSet(uow, parsed.value);
      },
      (ruleSet) => ({
        eventName: RULES_AUDIT_EVENTS.ruleSetCreated,
        subjectType: 'rule_set',
        subjectId: ruleSet.id,
      }),
    );
    return respond(request, reply, outcome, (ruleSet) =>
      ruleSetResultSchema.parse({ ruleSet, correlationId: request.correlationId }),
    );
  });

  app.put(`${base}-sets/:ruleSetId`, { config: RULE_SET_CONFIG }, async (request, reply) => {
    const { ruleSetId } = request.params as { ruleSetId?: string };
    const outcome = await withRuleCommand(
      request,
      async (uow) => {
        // Shape first, inside the unit of work and after the verdict: a
        // malformed id is decidable before any statement runs, so the `22P02`
        // class never reaches the database (catalogue finding V-02).
        if (ruleSetId === undefined || !isUuid(ruleSetId)) return { kind: 'not-found' as const };
        const parsed = parseBody(ruleSetAmendSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        const { expectedVersion, ...write } = parsed.value;
        return rules.updateRuleSet(uow, ruleSetId, write, expectedVersion);
      },
      (ruleSet) => ({
        eventName: RULES_AUDIT_EVENTS.ruleSetUpdated,
        subjectType: 'rule_set',
        subjectId: ruleSet.id,
      }),
    );
    return respond(request, reply, outcome, (ruleSet) =>
      ruleSetResultSchema.parse({ ruleSet, correlationId: request.correlationId }),
    );
  });

  app.delete(`${base}-sets/:ruleSetId`, { config: RULE_SET_CONFIG }, async (request, reply) => {
    const { ruleSetId } = request.params as { ruleSetId?: string };
    const outcome = await withRuleCommand(
      request,
      async (uow) => {
        if (ruleSetId === undefined || !isUuid(ruleSetId)) return { kind: 'not-found' as const };
        /* The compare-and-set arrives as a QUERY parameter, because a DELETE
         * carrying a body is a shape proxies and clients disagree about. It is
         * a positive integer and nothing else — no personal or sensitive value
         * ever goes in a URL — and a missing or malformed one is refused rather
         * than defaulted, so the CAS cannot be skipped by omitting it. */
        const { expectedVersion } = request.query as { expectedVersion?: string };
        const expected = Number(expectedVersion);
        if (!Number.isInteger(expected) || expected <= 0) {
          return {
            kind: 'invalid' as const,
            problems: [
              {
                path: 'expectedVersion',
                message: 'The version of the rule set being archived is required.',
              },
            ],
          };
        }
        // ARCHIVE, not delete. The verb is DELETE because that is the HTTP verb
        // for "retire this resource"; nothing is removed from the database.
        return rules.archiveRuleSet(uow, ruleSetId, expected);
      },
      (ruleSet) => ({
        eventName: RULES_AUDIT_EVENTS.ruleSetArchived,
        subjectType: 'rule_set',
        subjectId: ruleSet.id,
      }),
    );
    return respond(request, reply, outcome, (ruleSet) =>
      ruleSetResultSchema.parse({ ruleSet, correlationId: request.correlationId }),
    );
  });
}
