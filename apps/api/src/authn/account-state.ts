/**
 * STM-018 (doc 10, machine 16) — the user-account lifecycle:
 *
 *     invited -> active -> deactivated -> archived
 *
 * ## Why this is derived rather than stored
 *
 * 0001 gave `users.status` the domain `active | deactivated` and that migration
 * is applied and immutable. Widening its CHECK is not the additive change it
 * looks like: every existing row was written against the old shape, and a second
 * status column would be a second source of truth that drifts from the first.
 *
 * So the state is a **function of two columns** — `status` and `activated_at` —
 * computed in exactly one place. The pair is total over the states this
 * milestone can reach, and the one it cannot is said out loud below rather than
 * quietly folded into `deactivated`.
 *
 * ## `archived` is NOT representable and is NOT claimed
 *
 * 14 §7: "Account deletion is deactivation and archival, never hard deletion."
 * Archival is a retention action with its own surface, its own capability and its
 * own audit event, none of which is in this packet. Returning `archived` from
 * here would be a claim that the transition exists.
 */

export type AccountState = 'invited' | 'active' | 'deactivated';

export interface AccountStateInput {
  readonly status: 'active' | 'deactivated';
  readonly activatedAt: Date | null;
}

export function accountStateOf(user: AccountStateInput): AccountState {
  // Deactivation wins over everything: an invited account that is deactivated
  // before it activates is deactivated, not still pending.
  if (user.status === 'deactivated') return 'deactivated';
  return user.activatedAt === null ? 'invited' : 'active';
}

/** Only an `active` account may present a credential. */
export function canAuthenticate(user: AccountStateInput): boolean {
  return accountStateOf(user) === 'active';
}

/**
 * The transitions this milestone implements, as data.
 *
 * Doc 10's universal rules require invalid transitions to be "rejected with
 * typed errors", and a table is what makes "invalid" answerable without reading
 * every handler. `active -> active` is absent deliberately: re-activating an
 * activated account is the invitation-replay case, and it must be refused rather
 * than treated as idempotent — the second activation would set a password the
 * first activator did not choose.
 */
export const ACCOUNT_TRANSITIONS: readonly { from: AccountState; to: AccountState }[] = [
  { from: 'invited', to: 'active' },
  { from: 'invited', to: 'deactivated' },
  { from: 'active', to: 'deactivated' },
];

export function transitionIsLegal(from: AccountState, to: AccountState): boolean {
  return ACCOUNT_TRANSITIONS.some((t) => t.from === from && t.to === to);
}
