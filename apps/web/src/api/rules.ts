import {
  ruleListSchema,
  ruleResultSchema,
  ruleWriteSchema,
  validationProblemBodySchema,
  type RuleList,
  type RuleResult,
  type RuleWriteRequest,
} from '@schedulepoint/contracts';

import { ApiError, apiRequest } from './client.js';
import { ValidationError } from './catalogue.js';

/**
 * The typed rule model's client (OPUS-M3-002).
 *
 * The three rules `api/catalogue.ts` states apply unchanged:
 *
 *  1. **every URL is same-origin and relative** — CAP-068 / T-23, allowlist empty;
 *  2. **every response is parsed through the shared zod contract**;
 *  3. **requests are parsed on the way OUT**, so the server receives the body the
 *     contract describes rather than whatever fields a form happened to fill in.
 *
 * `ValidationError` is imported from the catalogue client rather than redeclared:
 * a second class with the same name and shape is a second `instanceof` that the
 * shared `ValidationSummary` would not recognise, and the failure mode is a form
 * that silently shows no problems.
 */

function base(scope: { organizationId: string; groupId: string }): string {
  return `/organizations/${scope.organizationId}/groups/${scope.groupId}/rules`;
}

/**
 * Turns a `422` into the shape the shared validation summary renders.
 *
 * **Keyed on the BODY, never on `error.code`** — the trap `api/catalogue.ts`
 * records and this file walked straight into before its e2e caught it:
 * `errorEnvelopeSchema` is `.strict()`, so a 422 carrying `problems` never
 * parses as an envelope and reaches here with the code `UNEXPECTED_RESPONSE`.
 * Keying on `VALIDATION_FAILED` misses every server validation failure while
 * looking entirely correct — the form simply shows no problems.
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

export async function fetchRules(scope: {
  organizationId: string;
  groupId: string;
}): Promise<RuleList> {
  return ruleListSchema.parse(await apiRequest(base(scope)));
}

export async function createRule(
  scope: { organizationId: string; groupId: string },
  body: RuleWriteRequest,
): Promise<RuleResult> {
  // Parsed on the way out. A contract failure here is reported in the SAME shape
  // the server's 422 produces, so the summary looks identical whichever found it.
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
      await apiRequest(base(scope), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
      }),
    );
  } catch (error) {
    return asValidationError(error);
  }
}

