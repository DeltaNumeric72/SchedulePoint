import { z } from 'zod';

/**
 * The wire shapes for the SPEC-06 administration surfaces OPUS-M1-002 ships.
 *
 * Three routes, and each exists because a residual or a test contract needs a
 * real path to run through rather than a hand-built transaction:
 *
 * | Route | Why it exists |
 * |---|---|
 * | create a membership | EV-M1-TENANCY residuals 1 and 2 — the capability gate on the INSERT |
 * | write a capability grant | residual 4 (self escalation), SPEC-06 A-12 (the exclusion constraint), and every grant-based allow/deny pair |
 * | change an entitlement's state | CAP-057, SPEC-06 A-05 and A-09 — revocation mid-session, and re-enable with data intact |
 *
 * **No response body carries a denial reason.** A denial is a `403` or a `404`
 * with the fixed envelope from `health.ts`; these schemas describe success only.
 * That is P-3 and SPEC-01 §2.4, and it is why there is no `reason` field
 * anywhere below to be tempted into filling in.
 */

const uuid = z.string().uuid();

/**
 * A capability key, as it appears on the wire.
 *
 * Deliberately a shape check and not an enum of the twenty catalogue keys: the
 * catalogue lives in `@schedulepoint/domain`, and `@schedulepoint/contracts`
 * imports zod and nothing else (the layering rule). A key that passes this
 * pattern but is not in the catalogue is denied by the evaluator's P-4 backstop,
 * so the narrow validation here loses nothing.
 */
const capabilityKey = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'a capability key is dotted lower_snake segments');

/**
 * **The caller does not choose the row id, and that is a security property.**
 *
 * SPEC-01 §4 amendment (b), from the executed spike's X-11: primary-key checks
 * bypass RLS, so a 23505 raised against an id that exists only in ANOTHER tenant
 * discloses that it exists. `memberships.id` is a primary key and cannot be
 * tenant-qualified, so the mitigation is the other half of the amendment — the
 * caller must not be able to choose the value. The server generates it and
 * returns it. A client-supplied `membershipId` would be a global-id existence
 * oracle over the UUIDv4 space: expensive rather than impossible, which is
 * exactly how EV-M1-TENANCY residual 2 described the one it replaced.
 */
export const createMembershipRequestSchema = z
  .object({
    userId: uuid,
    /** `null` creates an ORGANIZATION membership; a uuid creates a group membership. */
    groupId: uuid.nullable(),
    role: z.string().min(1).max(64),
  })
  .strict();

export type CreateMembershipRequest = z.infer<typeof createMembershipRequestSchema>;

export const createMembershipResultSchema = z
  .object({
    membershipId: uuid,
    organizationId: uuid,
    groupId: uuid.nullable(),
    kind: z.enum(['organization', 'group']),
    correlationId: z.string().min(1),
  })
  .strict();

export type CreateMembershipResult = z.infer<typeof createMembershipResultSchema>;

/** Same rule as `createMembershipRequestSchema`: the server chooses `grantId`. */
export const writeGrantRequestSchema = z
  .object({
    membershipId: uuid,
    capabilityKey,
    /** `false` is an EXPLICIT DENY and beats every allow in its window (SPEC-06 P-1). */
    granted: z.boolean(),
    validFrom: z.string().datetime().optional(),
    validTo: z.string().datetime().nullable().optional(),
  })
  .strict();

export type WriteGrantRequest = z.infer<typeof writeGrantRequestSchema>;

export const writeGrantResultSchema = z
  .object({
    grantId: uuid,
    membershipId: uuid,
    capabilityKey: z.string().min(1),
    granted: z.boolean(),
    correlationId: z.string().min(1),
  })
  .strict();

export type WriteGrantResult = z.infer<typeof writeGrantResultSchema>;

export const setEntitlementStateRequestSchema = z
  .object({
    state: z.enum(['trial', 'active', 'suspended', 'revoked']),
  })
  .strict();

export type SetEntitlementStateRequest = z.infer<typeof setEntitlementStateRequestSchema>;

export const setEntitlementStateResultSchema = z
  .object({
    organizationId: uuid,
    moduleKey: z.string().min(1),
    state: z.enum(['trial', 'active', 'suspended', 'revoked']),
    correlationId: z.string().min(1),
  })
  .strict();

export type SetEntitlementStateResult = z.infer<typeof setEntitlementStateResultSchema>;

/**
 * The `409` body these surfaces emit.
 *
 * `responses.ts` states the rule this exists to satisfy: "Every 409 is parsed
 * through its own contract on the way out … it makes a field added here without
 * being added to the schema a test failure rather than an undocumented wire
 * change." The two conflict paths in `authorization.route.ts` sent raw inline
 * objects until an independent review pointed at the rule next door.
 *
 * `code` is a single fixed literal on purpose: a 23505 and a 23P01 must be
 * indistinguishable on the wire, because one of them can be raised by a
 * tenant-qualified index and the other by an exclusion constraint, and telling
 * the caller which would describe the schema.
 */
export const conflictBodySchema = z
  .object({
    error: z
      .object({
        code: z.literal('CONFLICT'),
        message: z.string().min(1),
        correlationId: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type ConflictBody = z.infer<typeof conflictBodySchema>;
