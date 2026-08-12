import {
  ruleAmendSchema,
  ruleResultSchema,
  staleRuleBodySchema,
  validationProblemBodySchema,
  type RuleResult,
  type RuleWriteRequest,
} from '@schedulepoint/contracts';

import { ApiError, apiRequest } from '../api/client.js';
import { ValidationError } from '../api/catalogue.js';

/**
 * The rule-authoring client's EDIT half (OPUS-M3-004).
 *
 * `apps/web/src/api/rules.ts` (OPUS-M3-002) already carries `fetchRules`,
 * `createRule` and `setRuleState`; the update path is what the round trip needs
 * and it lives here because this packet's allowed globs are
 * `apps/web/src/rules/**` and `apps/web/src/schedule/**`. `apiRequest` and
 * `ValidationError` are IMPORTED rather than reimplemented, so there is still
 * exactly one error-envelope parser and exactly one `ValidationError` the shared
 * summary recognises by `instanceof` — the trap `api/rules.ts` records about a
 * second class with the same name is not reintroduced here.
 *
 * ## OPUS-M4-000C — every amendment carries the version it was editing
 *
 * `expectedVersion` is REQUIRED on both writes below, and required for the same
 * reason FAD-22(2) made `expectedPriorCurrentVersionId` required on publication:
 * an optional compare-and-set is indistinguishable from a caller that never
 * thought about concurrency. A `409 STALE_RULE` surfaces as {@link StaleRuleError}
 * carrying the CURRENT version, so the page can tell the author to reload rather
 * than silently overwriting somebody's edit.
 *
 * `setRuleState` lives here too, beside the other CAS-carrying write, rather
 * than in `apps/web/src/api/rules.ts`: a lifecycle move is a mutation like any
 * other and archiving is TERMINAL, so it needs the same token. Two clients for
 * one operation would be two answers to "did I carry the version".
 */

/** `409 STALE_RULE` — the rule moved between the load and the save. */
export class StaleRuleError extends Error {
  constructor(readonly currentVersion: number) {
    super('This rule changed while you were editing it. Reload it and try again.');
    this.name = 'StaleRuleError';
  }
}

/** Turns the server's `409 STALE_RULE` body into {@link StaleRuleError}. */
function asStaleRule(error: unknown): void {
  if (!(error instanceof ApiError)) return;
  const parsed = staleRuleBodySchema.safeParse(error.body);
  if (parsed.success) throw new StaleRuleError(parsed.data.error.currentVersion);
}

function base(scope: { organizationId: string; groupId: string }): string {
  return `/organizations/${scope.organizationId}/groups/${scope.groupId}/rules`;
}

/**
 * Keyed on the BODY, never on `error.code`.
 *
 * `errorEnvelopeSchema` is `.strict()`, so a 422 carrying `problems` never
 * parses as an envelope and arrives with the code `UNEXPECTED_RESPONSE`. Keying
 * on `VALIDATION_FAILED` would miss every server validation failure while
 * looking entirely correct — the form would simply show no problems.
 */
function asValidationError(error: unknown): never {
  if (error instanceof ApiError) {
    const parsed = validationProblemBodySchema.safeParse(error.body);
    if (parsed.success) {
      throw new ValidationError(
        parsed.data.error.message,
        parsed.data.error.problems,
        parsed.data.error.correlationId,
      );
    }
  }
  throw error;
}

export async function updateRule(
  scope: { organizationId: string; groupId: string },
  ruleKey: string,
  body: RuleWriteRequest,
  expectedVersion: number,
): Promise<RuleResult> {
  // Parsed on the way OUT, so a contract failure is reported in the same shape
  // the server's 422 produces and the summary looks identical either way.
  const parsed = ruleAmendSchema.safeParse({ ...body, expectedVersion });
  if (!parsed.success) {
    throw new ValidationError(
      'Some of the details need attention.',
      parsed.error.issues.slice(0, 40).map((issue) => ({
        field: (issue.path.length > 0 ? issue.path.join('.') : 'body').slice(0, 64),
        message:
          issue.code === 'invalid_union_discriminator'
            ? 'A recognised rule node is required.'
            : issue.message.slice(0, 300),
      })),
    );
  }

  try {
    return ruleResultSchema.parse(
      await apiRequest(`${base(scope)}/${encodeURIComponent(ruleKey)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
      }),
    );
  } catch (error) {
    asStaleRule(error);
    return asValidationError(error);
  }
}

/**
 * A lifecycle move, carrying the same compare-and-set token.
 *
 * Archiving is terminal, so archiving a rule somebody has just rewritten —
 * without either of them being told — is the most consequential last-write-wins
 * on this surface. That is why the token is required here and not only on an
 * amendment.
 */
export async function setRuleState(
  scope: { organizationId: string; groupId: string },
  ruleKey: string,
  state: 'active' | 'disabled' | 'archived',
  expectedVersion: number,
): Promise<RuleResult> {
  try {
    return ruleResultSchema.parse(
      await apiRequest(`${base(scope)}/${encodeURIComponent(ruleKey)}/state`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, expectedVersion }),
      }),
    );
  } catch (error) {
    asStaleRule(error);
    return asValidationError(error);
  }
}
