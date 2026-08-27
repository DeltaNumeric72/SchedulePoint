import {
  submitRequestSchema,
  vacationRoundListSchema,
  vacationRoundSchema,
  vacationSelectionResultSchema,
  withdrawVacationSelectionSchema,
  type RequestWire,
  type VacationRoundList,
  type VacationRoundWire,
  type VacationSelectionResultWire,
} from '@schedulepoint/contracts';
import { requestSchema } from '@schedulepoint/contracts';

import { ApiError, apiRequest } from '../api/client.js';

/**
 * The vacation round client (OPUS-M5-003, doc 42 §5f Part B).
 *
 * The three rules every client in this app states apply here unchanged:
 *
 *  1. **every URL is same-origin and relative** — CAP-068 / T-23, and the
 *     client-host allowlist is empty. There is no third-party host anywhere in
 *     this module, and none in the surface it serves.
 *  2. **every response is parsed through the shared zod contract** — an unparsed
 *     response is an untyped response whatever the TypeScript signature claims.
 *  3. **requests are parsed on the way OUT too**, so the server receives the body
 *     the contract describes rather than whatever fields a form happened to fill.
 *
 * ## A selection is submitted through the REQUEST route
 *
 * `POST …/requests` with a `vacation-selection` record — the same endpoint the
 * other five subtypes use, answering the same `requestSchema`. That is doc 42
 * §5f's "the creation union and route gain the vacation subtype; the 422 refusal
 * retires", and from this side it means one submit function rather than two that
 * differ only in which table the server ends up in.
 */

/** A `409` naming a refusal code the surface can explain. */
export class VacationRefusal extends ApiError {
  constructor(code: string, message: string, correlationId?: string) {
    super(code, message, correlationId);
    this.name = 'VacationRefusal';
  }
}

export interface GroupScope {
  readonly organizationId: string;
  readonly groupId: string;
}

const base = (scope: GroupScope): string =>
  `/organizations/${scope.organizationId}/groups/${scope.groupId}`;

const jsonHeaders = { 'content-type': 'application/json' } as const;

/**
 * Re-throws a server refusal with its CODE intact.
 *
 * The surface distinguishes "this round is not open" from "you already hold that
 * week" from "somebody decided it while you were looking", because the three have
 * different remedies. Matched on the body's `error.code` rather than on the HTTP
 * status, which is the same for all three.
 */
function rethrow(error: unknown): never {
  if (error instanceof ApiError) {
    const body = error.body as { error?: { code?: unknown; message?: unknown } } | undefined;
    const code = body?.error?.code;
    const message = body?.error?.message;
    if (typeof code === 'string' && typeof message === 'string') {
      throw new VacationRefusal(code, message);
    }
  }
  throw error;
}

export async function fetchRounds(scope: GroupScope): Promise<VacationRoundList> {
  return vacationRoundListSchema.parse(await apiRequest(`${base(scope)}/vacation/rounds`));
}

/**
 * ONE round, in ONE request: the period, this member's selections, and §5.5's
 * variance rows.
 *
 * I-10 from the client side. A surface that fetched the period, then the
 * selections, then the grants would be three requests for one action, and the
 * request-budget gate counts exactly that.
 */
export async function fetchRound(scope: GroupScope, periodId: string): Promise<VacationRoundWire> {
  return vacationRoundSchema.parse(
    await apiRequest(`${base(scope)}/vacation/rounds/${periodId}`),
  );
}

/** Select a week — `POST …/requests`, the same door the other five subtypes use. */
export async function selectWeek(
  scope: GroupScope,
  input: { readonly vacationPeriodId: string; readonly weekStart: string; readonly idempotencyKey: string },
): Promise<RequestWire> {
  const body = submitRequestSchema.parse({
    idempotencyKey: input.idempotencyKey,
    record: {
      subtype: 'vacation-selection',
      vacationPeriodId: input.vacationPeriodId,
      weekStart: input.weekStart,
    },
  });
  try {
    return requestSchema.parse(
      await apiRequest(`${base(scope)}/requests`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }),
    );
  } catch (error) {
    rethrow(error);
  }
}

/** Take a week back — the SELECTION's version, never the root's (V-29). */
export async function withdrawSelection(
  scope: GroupScope,
  selectionId: string,
  expectedSelectionVersion: number,
): Promise<VacationSelectionResultWire> {
  const body = withdrawVacationSelectionSchema.parse({ expectedSelectionVersion });
  try {
    return vacationSelectionResultSchema.parse(
      await apiRequest(`${base(scope)}/vacation/selections/${selectionId}/withdraw`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }),
    );
  } catch (error) {
    rethrow(error);
  }
}
