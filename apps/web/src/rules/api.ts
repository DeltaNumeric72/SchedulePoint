import {
  ruleResultSchema,
  ruleWriteSchema,
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
 * The `PUT` route it calls has existed since OPUS-M3-002; nothing on the server
 * changes for this.
 */

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
): Promise<RuleResult> {
  // Parsed on the way OUT, so a contract failure is reported in the same shape
  // the server's 422 produces and the summary looks identical either way.
  const parsed = ruleWriteSchema.safeParse(body);
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
    return asValidationError(error);
  }
}
