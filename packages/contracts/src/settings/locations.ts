import { z } from 'zod';

import { timeZoneSchema } from './group-settings.js';

/**
 * `locations` — doc 06 §3.2 row 237 (OPUS-M3-007; carried M2 item 7, CAP-004).
 *
 * ## `siteLabel` is a free-form ATTRIBUTE, and that is the whole point
 *
 * PO-DEC-01 is `pending` with the working default "defer a first-class Site;
 * model location as an attribute". doc 06 §3.2a: "A first-class table with
 * foreign keys is not neutral toward that decision", and "**no site
 * administration surface, no site-scoped API, and no site-specific workflow is
 * designed** — building one would select the branch by stealth" (non-bypass rule
 * 12).
 *
 * So `siteLabel` is a nullable string on this contract and a nullable `text`
 * column in the table. It is not an id, it is not validated against a list of
 * sites, and there is no `sites` endpoint, no `siteId`, and no site resource
 * anywhere in this package. Several locations sharing a label is the ordinary
 * case.
 *
 * Both directions of doc 06 §3.2a's migration boundary are proven to work as
 * **test fixtures** (`apps/api/test/settings/site-migration-fixtures.test.ts`),
 * on synthetic rows in a scratch schema. Neither migration is built.
 */

const uuid = z.string().uuid();

/**
 * Trimmed, bounded, single-line free text.
 *
 * Bounded not because a place name is sensitive — doc 06 classifies `locations`
 * sensitivity `NONE`, and an address is a place rather than a person, so I-07 is
 * not in play — but because an unbounded text field is how a form acquires a
 * notes box nobody designed.
 */
const boundedText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max);

export const createLocationRequestSchema = z
  .object({
    name: boundedText(120),
    /** The PO-DEC-01 attribute. Free-form, optional, referencing nothing. */
    siteLabel: boundedText(120).nullable().default(null),
    address: boundedText(500).nullable().default(null),
    /**
     * Optional and genuinely optional: most locations sit in their group's zone,
     * and storing a copy of it here would create two truths that can drift. A
     * location only carries a zone when it really is in a different one.
     */
    timezone: timeZoneSchema.nullable().default(null),
  })
  .strict();

export type CreateLocationRequest = z.infer<typeof createLocationRequestSchema>;

export const updateLocationRequestSchema = z
  .object({
    name: boundedText(120).optional(),
    siteLabel: boundedText(120).nullable().optional(),
    address: boundedText(500).nullable().optional(),
    timezone: timeZoneSchema.nullable().optional(),
    /** Archive, never delete. `archived` is the only removal this table has. */
    status: z.enum(['active', 'archived']).optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();

export type UpdateLocationRequest = z.infer<typeof updateLocationRequestSchema>;

export const locationSchema = z
  .object({
    locationId: uuid,
    name: z.string().min(1),
    siteLabel: z.string().nullable(),
    address: z.string().nullable(),
    timezone: z.string().nullable(),
    status: z.enum(['active', 'archived']),
    version: z.number().int(),
  })
  .strict();

export type Location = z.infer<typeof locationSchema>;

export const locationListSchema = z
  .object({ locations: z.array(locationSchema), correlationId: z.string().min(1) })
  .strict();

export type LocationList = z.infer<typeof locationListSchema>;

export const locationResultSchema = z
  .object({ location: locationSchema, correlationId: z.string().min(1) })
  .strict();

export type LocationResult = z.infer<typeof locationResultSchema>;
