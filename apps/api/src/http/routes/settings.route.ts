import {
  conflictBodySchema,
  createLocationRequestSchema,
  groupSettingsSchema,
  isUuid,
  locationListSchema,
  locationResultSchema,
  setPicklistAccessRequestSchema,
  setRequestUntilRequestSchema,
  setTimezoneRequestSchema,
  updateLocationRequestSchema,
  validationProblemBodySchema,
  type ConflictBody,
} from '@schedulepoint/contracts';
import type { AuditEventName, AuditPayload, Decision, FieldProblem } from '@schedulepoint/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { recordAuditEvent } from '../../audit/recorder.js';
import { evaluateInTransaction, respondToDenial } from '../../authz/authorize-request.js';
import { PG_ERRORS, isPostgresError } from '../../db/pg-errors.js';
import {
  LOCATION_CONFIG,
  PICKLIST_ACCESS_CONFIG,
  REQUEST_UNTIL_CONFIG,
  SETTINGS_AUDIT_EVENTS,
  SETTINGS_READ_CONFIG,
  TIMEZONE_CONFIG,
} from '../../settings/policies.js';
import * as settings from '../../settings/service.js';
import type { SettingsOutcome } from '../../settings/service.js';
import { requireTenantContext } from '../context/middleware.js';
import { sendNotFound } from '../context/responses.js';

/**
 * Group settings and locations over HTTP (OPUS-M3-007; carried M2 items 4-7).
 *
 * ## The shape every mutating route has, and why it never varies
 *
 * ```
 * runtime.run(command, async (uow) => {
 *   const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
 *   if (!decision.allowed) return denied(decision);   // nothing written
 *   … the mutation …
 *   await recordAuditEvent(uow, { eventName, subjectType, subjectId, payload });
 * })
 * ```
 *
 * FAD-12's ordering — **evaluate → deny → mutate → audit, in ONE unit of work**.
 * `withSettingsCommand` below is that shape, once, as a function.
 *
 * ## Body parsing happens INSIDE the unit of work, after the verdict
 *
 * A disclosure control rather than a style choice, and it is the fix SBX-001's
 * role × route matrix forced on the catalogue: parsing first let an actor who
 * holds nothing in this group send `{}` and receive a `400` describing the body
 * the route expects, while a genuinely absent route answers `404`. The two must
 * be indistinguishable to that actor (SPEC-01 §2.4, SPEC-06 P-3).
 *
 * ## There is no site route, and there is no site resource
 *
 * PO-DEC-01 is pending with the working default "defer a first-class Site"
 * (doc 06 §3.2a), so **no endpoint below is scoped by, filtered by, grouped by
 * or named after a site.** `siteLabel` is a field on a location and nothing
 * else. Building a site-scoped API would select the pending decision's
 * non-default branch by stealth — non-bypass rule 12.
 */

type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'denied'; readonly decision: Decision }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'invalid'; readonly problems: readonly FieldProblem[] };

/**
 * Parses a request body into the settings outcome shape.
 *
 * A schema failure is a **422**, not a 400: the body was well-formed JSON and
 * specific fields were wrong, which is the fact an authoring form can act on.
 * The field name is the FULL path joined by `.` rather than only its head,
 * because this slice's bodies nest one level (`policy.untilDate`) and a summary
 * that said "policy" could not link to the control that is wrong.
 */
function parseBody<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  body: unknown,
): SettingsOutcome<T> {
  const parsed = schema.safeParse(body);
  if (parsed.success && parsed.data !== undefined) return { kind: 'ok', value: parsed.data };

  const issues =
    (parsed.error as { issues?: { path: (string | number)[]; message: string }[] } | undefined)
      ?.issues ?? [];
  const problems = issues.slice(0, 40).map((issue) => ({
    field: issue.path.length > 0 ? issue.path.map(String).join('.') : 'body',
    message: issue.message,
  }));
  return {
    kind: 'invalid',
    problems:
      problems.length > 0
        ? problems
        : [{ field: 'body', message: 'The request body is not valid.' }],
  };
}

/**
 * Validates a uuid path parameter — **after the authorization decision**, for
 * the reason `parseBody` is called there. An unauthorized caller must not be
 * able to tell "that is not a uuid" from "you may not do this".
 */
function requireUuid(value: string | undefined): SettingsOutcome<never> | null {
  return value !== undefined && isUuid(value) ? null : { kind: 'not-found' };
}

/** SQLSTATE 23505 — a row with this tenant-qualified key already exists. */
function isUniqueViolation(error: unknown): boolean {
  return isPostgresError(error) && error.code === PG_ERRORS.uniqueViolation;
}

/**
 * Runs one settings command under FAD-12's ordering.
 *
 * `audit` is called only when the command reports `ok`, and it is called INSIDE
 * the same unit of work — so there is no path on which a mutation commits
 * without its audit row, and none on which an audit row survives a rolled-back
 * mutation.
 *
 * A NON-database fault is re-thrown rather than folded into a 404: catching
 * everything turns a bug in this process into a 404 carrying a log line that
 * asserts "refused by the database" about a cause it never checked (review
 * finding V-02, OPUS-M2-004).
 */
async function withSettingsCommand<T>(
  request: FastifyRequest,
  run: (
    uow: Parameters<Parameters<FastifyRequest['server']['tenancy']['runtime']['run']>[1]>[0],
  ) => Promise<SettingsOutcome<T>>,
  audit: (value: T) => {
    eventName: AuditEventName;
    subjectType: string;
    subjectId: string;
    /** Identifiers, tokens and counts only. Never free text (I-07). */
    payload?: AuditPayload;
  } | null,
): Promise<Outcome<T>> {
  const { context, command, route } = requireTenantContext(request);

  return request.server.tenancy.runtime.run(command, async (uow): Promise<Outcome<T>> => {
    const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
    if (!decision.allowed) return { kind: 'denied', decision };

    let outcome: SettingsOutcome<T>;
    try {
      outcome = await run(uow);
    } catch (error) {
      if (!isPostgresError(error)) throw error;
      if (isUniqueViolation(error)) return { kind: 'conflict' };
      request.log.warn(
        { correlationId: request.correlationId, sqlstate: error.code },
        'settings statement refused by the database',
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
async function withSettingsQuery<T>(
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
        'settings read refused by the database',
      );
      return { kind: 'not-found' };
    }
  });
}

/** Turns an outcome into a response. One place, so the shapes cannot drift. */
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
  if (outcome.kind === 'invalid') {
    return reply.code(422).send(
      validationProblemBodySchema.parse({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some of the details need attention.',
          correlationId: request.correlationId,
          problems: outcome.problems.map((problem) => ({
            field: problem.field,
            message: problem.message,
          })),
        },
      }),
    );
  }
  return body(outcome.value);
}

export default function settingsRoutes(app: FastifyInstance): void {
  const base = '/organizations/:organizationId/groups/:groupId/settings';

  /* ── the settings read ──────────────────────────────────────── CAP-021 ── */

  app.get(base, { config: SETTINGS_READ_CONFIG }, async (request, reply) => {
    const outcome = await withSettingsQuery(request, (uow) => settings.readGroupSettings(uow));
    // A group invisible to this context (RLS) and a group that does not exist
    // are one answer, and `null` is it.
    if (outcome.kind === 'ok' && outcome.value === null) {
      return sendNotFound(request, reply);
    }
    return respond(request, reply, outcome, (value) =>
      groupSettingsSchema.parse({ ...value, correlationId: request.correlationId }),
    );
  });

  /* ── the request-until policy ───────────────────────────────── CAP-021 ──
   *
   * STORED AND AUTHORED ONLY. Enforcement is M5 (SPEC-08 §5: `expires_at`
   * computed server-side from this policy at submission). Nothing reads it here.
   */

  app.put(`${base}/request-until`, { config: REQUEST_UNTIL_CONFIG }, async (request, reply) => {
    const outcome = await withSettingsCommand(
      request,
      async (uow) => {
        const parsed = parseBody(setRequestUntilRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        return settings.setRequestUntil(uow, parsed.value.policy, parsed.value.expectedVersion);
      },
      // NO-OP EMITS NOTHING. `settings.request_until.changed` asserts a change;
      // when the stored policy already equalled the requested one, no change
      // occurred and the database's own guard did not move `settings_version`.
      // See `SettingsWriteResult` for why this is silence rather than a second
      // "unchanged" event name.
      (result) => !result.changed ? null : ({
        eventName: SETTINGS_AUDIT_EVENTS.requestUntilChanged,
        subjectType: 'group',
        subjectId: (request.params as { groupId: string }).groupId,
        // Scalars only (I-07). The mode is a closed token; the one populated
        // field travels beside it so "what did the window become" is answerable
        // from the audit row without re-reading the group.
        payload: {
          mode: result.policy.mode,
          ...(result.policy.mode === 'fixed_date' ? { untilDate: result.policy.untilDate } : {}),
          ...(result.policy.mode === 'days_before_period_start'
            ? { leadDays: result.policy.leadDays }
            : {}),
        },
      }),
    );
    return respond(request, reply, outcome, () => readBack(request, reply));
  });

  /* ── the picklist-access mode ───────────────────────────────── CAP-030 ──
   *
   * STORED AND AUTHORED ONLY. Enforcement is M9 (SPEC-02's turn transaction),
   * where it applies as an additional AND after the four authorization layers —
   * it narrows, it never grants.
   */

  app.put(`${base}/picklist-access`, { config: PICKLIST_ACCESS_CONFIG }, async (request, reply) => {
    const outcome = await withSettingsCommand(
      request,
      async (uow) => {
        const parsed = parseBody(setPicklistAccessRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        return settings.setPicklistAccess(uow, parsed.value.mode, parsed.value.expectedVersion);
      },
      // NO-OP EMITS NOTHING — see the request-until route above.
      (result) => !result.changed ? null : ({
        eventName: SETTINGS_AUDIT_EVENTS.picklistAccessChanged,
        subjectType: 'group',
        subjectId: (request.params as { groupId: string }).groupId,
        payload: { mode: result.mode },
      }),
    );
    return respond(request, reply, outcome, () => readBack(request, reply));
  });

  /* ── timezone administration ────────────────────────────────── CAP-021 ──
   *
   * Permitted while published schedules exist (packet 32 §10c), and gated on an
   * explicit acknowledgement when they do. **The server decides when the
   * acknowledgement is required**, from a count it reads inside the same
   * transaction as the write — a client that could decide when the warning
   * applies is a client that can decide it never applies.
   */

  app.put(`${base}/timezone`, { config: TIMEZONE_CONFIG }, async (request, reply) => {
    const outcome = await withSettingsCommand(
      request,
      async (uow) => {
        const parsed = parseBody(setTimezoneRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;

        const current = await settings.readGroupSettings(uow);
        if (current === null) return { kind: 'not-found' as const };

        if (current.publishedVersionCount > 0 && !parsed.value.acknowledgePublishedImpact) {
          return {
            kind: 'invalid' as const,
            problems: [
              {
                field: 'acknowledgePublishedImpact',
                message:
                  'This group has published schedules. Confirm that you have read what changing ' +
                  'the time zone means for them before saving.',
              },
            ],
          };
        }

        return settings.setTimezone(
          uow,
          parsed.value.timezone,
          parsed.value.expectedVersion,
          // The CLIENT'S field, carried through to the audit payload. Deriving
          // it from the published count would assert a human act the payload
          // never read (NB-2).
          parsed.value.acknowledgePublishedImpact,
        );
      },
      // NO-OP EMITS NOTHING — see the request-until route above. `UTC -> UTC`
      // is the reviewer's exact probe.
      (change) => !change.changed ? null : ({
        eventName: SETTINGS_AUDIT_EVENTS.timezoneChanged,
        subjectType: 'group',
        subjectId: (request.params as { groupId: string }).groupId,
        // The warning, recorded. `publishedVersionCount` is read inside the
        // writing transaction, so the number in the audit row is the number that
        // was true at the instant the change committed. Zone names are printable
        // ASCII with no space, which the closed-payload rules require.
        payload: {
          fromTimezone: change.from,
          toTimezone: change.to,
          publishedVersionCount: change.publishedVersionCount,
          // What the caller SENT, not what the count implies.
          publishedImpactAcknowledged: change.acknowledged,
        },
      }),
    );
    return respond(request, reply, outcome, () => readBack(request, reply));
  });

  /* ── locations ──────────────────────────────────────────────── CAP-004 ── */

  app.get(`${base}/locations`, { config: LOCATION_CONFIG }, async (request, reply) => {
    const outcome = await withSettingsQuery(request, (uow) => settings.listLocations(uow));
    return respond(request, reply, outcome, (locations) =>
      locationListSchema.parse({ locations, correlationId: request.correlationId }),
    );
  });

  app.post(`${base}/locations`, { config: LOCATION_CONFIG }, async (request, reply) => {
    const outcome = await withSettingsCommand(
      request,
      async (uow) => {
        const parsed = parseBody(createLocationRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        return settings.createLocation(uow, parsed.value);
      },
      (location) => ({
        eventName: SETTINGS_AUDIT_EVENTS.locationCreated,
        subjectType: 'location',
        subjectId: location.locationId,
        // Whether a site label was set, never the label itself: the payload
        // admits no space and 64 characters, and a place name is free text a
        // person typed. The boolean is the fact an audit query needs.
        payload: { hasSiteLabel: location.siteLabel !== null },
      }),
    );
    return respond(request, reply, outcome, (location) =>
      locationResultSchema.parse({ location, correlationId: request.correlationId }),
    );
  });

  app.patch(
    `${base}/locations/:locationId`,
    { config: LOCATION_CONFIG },
    async (request, reply) => {
      const locationId = (request.params as { locationId?: string }).locationId;

      const outcome = await withSettingsCommand(
        request,
        async (uow) => {
          const malformed = requireUuid(locationId);
          if (malformed !== null) return malformed;
          const parsed = parseBody(updateLocationRequestSchema, request.body);
          if (parsed.kind !== 'ok') return parsed;
          return settings.updateLocation(uow, locationId as string, parsed.value);
        },
        // Archiving gets its OWN event name, for the reason
        // `catalogue.shift_type.archived` does: "when did this place stop being
        // used" must be answerable from a filtered audit query rather than by
        // scanning every update for a status field.
        // NO-OP EMITS NOTHING. A PATCH carrying only `expectedVersion` moves
        // `locations.version` — the catalogue counter bumps unconditionally, by
        // design — and moves no field a person would recognise. The audit
        // stream records the second fact, not the first.
        (result) => !result.changed ? null : ({
          eventName: result.archived
            ? SETTINGS_AUDIT_EVENTS.locationArchived
            : SETTINGS_AUDIT_EVENTS.locationUpdated,
          subjectType: 'location',
          subjectId: result.location.locationId,
          payload: { hasSiteLabel: result.location.siteLabel !== null },
        }),
      );

      return respond(request, reply, outcome, (result) =>
        locationResultSchema.parse({
          location: result.location,
          correlationId: request.correlationId,
        }),
      );
    },
  );
}

/**
 * A settings write answers `204`, and the client re-reads.
 *
 * The three group-settings writes each move one facet of a row whose other
 * facets — and whose `version` — the form also holds. Returning a partial body
 * would invite the client to patch its own cache from it and render a view no
 * server ever produced; PO-DEC-18's server-authoritative posture is the reason
 * the catalogue's accepted-save budget is two requests rather than one, and this
 * is the same trade made explicitly. `204` says "nothing to read here" rather
 * than shipping half a settings object.
 */
function readBack(_request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(204).send();
}
