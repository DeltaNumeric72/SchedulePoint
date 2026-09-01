import {
  approveVacationSelectionSchema,
  commitVacationRoundResultSchema,
  commitVacationRoundSchema,
  denyVacationSelectionSchema,
  reverseVacationCommitResultSchema,
  reverseVacationCommitSchema,
  submitRequestSchema,
  vacationDecisionResultSchema,
  vacationRoundListSchema,
  vacationRoundSchema,
  vacationSelectionResultSchema,
  withdrawVacationSelectionSchema,
  type CommitVacationRoundResultWire,
  type RequestWire,
  type ReverseVacationCommitResultWire,
  type VacationDecisionResultWire,
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

/* ────────────────────────────────────────────────────────────────────────────
 * The SCHEDULER's half — OPUS-M5-005
 *
 * Four writes that were already shipped (M5-002's approve/deny, M5-004's
 * commit/reverse) and ONE read that was not: until this packet no route exposed
 * `readVacationRound`'s `'period'` scope, so a scheduler could obtain neither a
 * `selectionId` nor an `expectedSelectionVersion` for anybody else's week and
 * the four writes had no caller-side way to name their subject. The read is the
 * only route this packet adds, and it rides `requests.read_any` — the same key
 * the queue and the request detail already ride, and the same key migration
 * 0023's `vacation_selections_group_read_any` predicate names.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ONE round, EVERY member's selections — the scheduler's read.
 *
 * The answer is `vacationRoundSchema`, the SAME body the member's read returns,
 * over a wider row set. That is narrower than a bespoke shape rather than lazier:
 * the projection is the one M5-003 narrowed, so `overrideReason` is absent for
 * this more privileged reader too, and reason codes and comments stay behind
 * their own reads. Everything an approval or a reversal must NAME is in it.
 */
export async function fetchRoundSelections(
  scope: GroupScope,
  periodId: string,
): Promise<VacationRoundWire> {
  return vacationRoundSchema.parse(
    await apiRequest(`${base(scope)}/vacation/rounds/${periodId}/selections`),
  );
}

/**
 * §5.4's approval.
 *
 * Four fields, each an amendment's fix: `approvalIdempotencyKey` is D-26's
 * (without it a retry consumed a second quota unit), `expectedSelectionVersion`
 * is V-29's (the version §5.4 originally checked was the GRANT's),
 * `grantId`/`expectedGrantVersion` are optional per §5.4's own signature —
 * absent in open mode, where there are no grants at all (V-30) — and
 * `overrideReason` is §5.5's mandatory reason when the approval exceeds the
 * bound.
 *
 * **Supplying `overrideReason` authorises nothing.** The override capability is
 * evaluated server-side inside the transaction, and without it the approval is
 * refused (R-06) whatever this body says. The surface states that rather than
 * implying that filling the box grants the power.
 */
export async function approveSelection(
  scope: GroupScope,
  selectionId: string,
  input: {
    readonly approvalIdempotencyKey: string;
    readonly expectedSelectionVersion: number;
    readonly overrideReason?: string;
  },
): Promise<VacationDecisionResultWire> {
  const body = approveVacationSelectionSchema.parse({
    approvalIdempotencyKey: input.approvalIdempotencyKey,
    expectedSelectionVersion: input.expectedSelectionVersion,
    ...(input.overrideReason === undefined ? {} : { overrideReason: input.overrideReason }),
  });
  try {
    return vacationDecisionResultSchema.parse(
      await apiRequest(`${base(scope)}/vacation/selections/${selectionId}/approve`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }),
    );
  } catch (error) {
    rethrow(error);
  }
}

/** §5.4's denial. A denial consumes nothing, and carries a MANDATORY reason. */
export async function denySelection(
  scope: GroupScope,
  selectionId: string,
  input: {
    readonly approvalIdempotencyKey: string;
    readonly expectedSelectionVersion: number;
    readonly reason: string;
  },
): Promise<VacationDecisionResultWire> {
  const body = denyVacationSelectionSchema.parse(input);
  try {
    return vacationDecisionResultSchema.parse(
      await apiRequest(`${base(scope)}/vacation/selections/${selectionId}/deny`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }),
    );
  } catch (error) {
    rethrow(error);
  }
}

/**
 * §5.6's COMMIT — an act on the ROUND, never on a subset.
 *
 * There is no `selectionIds` field, deliberately: a commit takes every
 * `approved` selection in the period, because a commit that took a subset would
 * make "was this round committed?" a question with a list for an answer. The
 * idempotency key is FAD-59's and it is the only thing that makes a retry safe —
 * the same key twice commits once (R-12), and the answer says `replayed`.
 */
export async function commitRound(
  scope: GroupScope,
  periodId: string,
  input: { readonly targetVersionId: string; readonly idempotencyKey: string },
): Promise<CommitVacationRoundResultWire> {
  const body = commitVacationRoundSchema.parse(input);
  try {
    return commitVacationRoundResultSchema.parse(
      await apiRequest(`${base(scope)}/vacation/rounds/${periodId}/commit`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }),
    );
  } catch (error) {
    rethrow(error);
  }
}

/**
 * §5.6's REVERSAL of one committed week — the reason is MANDATORY.
 *
 * The answer's `revisionRequested` is a literal `true`: §5.6 always raises one,
 * because the published version is NOT edited. That is the consequence the
 * surface has to name before it lets anybody do this, and it is why the
 * confirmation is two steps rather than a button.
 */
export async function reverseCommittedWeek(
  scope: GroupScope,
  selectionId: string,
  reason: string,
): Promise<ReverseVacationCommitResultWire> {
  const body = reverseVacationCommitSchema.parse({ reason });
  try {
    return reverseVacationCommitResultSchema.parse(
      await apiRequest(`${base(scope)}/vacation/selections/${selectionId}/reverse`, {
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
