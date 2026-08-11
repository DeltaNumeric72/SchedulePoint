import { z } from 'zod';

/**
 * The wire shapes for the scheduling-structure catalogue (OPUS-M2-002, CAP-011,
 * CAP-012, and the CAR-011 holiday slice).
 *
 * ## Rules this package works under, restated where they bite
 *
 *  - **`.strict()` on every object.** An unknown key is rejected, not carried
 *    (I-07 alignment). A catalogue write that silently accepted an extra field
 *    would be a free-text channel into a configuration table.
 *  - **Enums are duplicated here rather than imported.** `@schedulepoint/contracts`
 *    imports zod and nothing else — the layering rule, enforced by
 *    `.dependency-cruiser.cjs` — so the palette keys, text styles and day names
 *    cannot come from `@schedulepoint/domain`. They are duplicated **and
 *    asserted**: `packages/domain/test/catalogue/display.test.ts` compares the two
 *    lists and the database CHECK, so drift is a failing test rather than a
 *    silent rejection at save time.
 *  - **No response body carries a denial reason** (P-3, SPEC-01 §2.4). These
 *    schemas describe success and validation only; a denial is the fixed 403/404
 *    envelope.
 *
 * ## Why validation problems ARE on the wire
 *
 * A `422` here is not an authorization signal — it is the server telling an
 * authoring form which of the fields the caller just typed is wrong, and SP-E
 * brief §3 requires the form to move focus to a `role="alert"` summary that
 * **links to those fields**. That is impossible with a sentence. Every problem is
 * `{ field, message }`, the field names match the request schema, and the message
 * repeats nothing the caller did not send.
 */

const uuid = z.string().uuid();

/** `HH:MM`, 24-hour. Seconds are deliberately not accepted: a rota is not that precise. */
const timeOfDay = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'a time of day is HH:MM in 24-hour form');

export const SHIFT_PALETTE_KEY_VALUES = [
  'neutral',
  'indigo',
  'teal',
  'amber',
  'rose',
  'violet',
] as const;
export const SHIFT_TEXT_STYLE_VALUES = ['regular', 'bold', 'italic'] as const;
export const CATALOGUE_DAY_VALUES = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
  'holiday',
] as const;

export const shiftPaletteKeySchema = z.enum(SHIFT_PALETTE_KEY_VALUES);
export const shiftTextStyleSchema = z.enum(SHIFT_TEXT_STYLE_VALUES);
export const catalogueDaySchema = z.enum(CATALOGUE_DAY_VALUES);

/**
 * A field-addressed validation failure.
 *
 * `field` names a property of the request schema so the authoring form can build
 * `<a href="#field-<name>">` and land the caret in the control that is wrong.
 */
export const fieldProblemSchema = z
  .object({
    field: z.string().min(1).max(64),
    message: z.string().min(1).max(300),
  })
  .strict();

export type FieldProblemWire = z.infer<typeof fieldProblemSchema>;

/** The `422` body. Distinct from the fixed error envelope, which carries no detail. */
export const validationProblemBodySchema = z
  .object({
    error: z
      .object({
        code: z.literal('VALIDATION_FAILED'),
        message: z.string().min(1),
        correlationId: z.string().min(1),
        problems: z.array(fieldProblemSchema).min(1).max(40),
      })
      .strict(),
  })
  .strict();

export type ValidationProblemBody = z.infer<typeof validationProblemBodySchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Shift types
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The authoring body.
 *
 * **`crossesMidnight` is absent, and its absence is the contract.** It is derived
 * from the two times by the server (`crossesMidnight` in the domain) and enforced
 * by a database CHECK. A client that could send it could send a value that
 * contradicts the times it also sent, and one of the two would have to win
 * silently.
 *
 * **`id` is absent for the same reason it is absent from the membership
 * contract**: a caller-chosen primary key is an existence oracle, because PK
 * uniqueness is checked outside RLS (X-11). The server generates and returns it.
 */
export const createShiftTypeRequestSchema = z
  .object({
    code: z.string().min(1).max(24),
    name: z.string().min(1).max(120),
    description: z.string().max(500).nullable().default(null),
    displayPaletteKey: shiftPaletteKeySchema.default('neutral'),
    displayTextStyle: shiftTextStyleSchema.default('regular'),
    startTime: timeOfDay,
    endTime: timeOfDay,
    isOnCall: z.boolean().default(false),
    attractsStipend: z.boolean().default(false),
    isManualOnly: z.boolean().default(false),
    isDailyPick: z.boolean().default(false),
    includeInStatistics: z.boolean().default(true),
    isLeaveOfAbsence: z.boolean().default(false),
    allowOnRequest: z.boolean().default(false),
    allowOffRequest: z.boolean().default(false),
    reportOrder: z.number().int().min(0).max(100000).default(0),
    creditWeight: z.number().min(0).max(1000).default(1),
    /**
     * The IN-FORCE WINDOW, and it is authorable rather than implied.
     *
     * Absent means "from now, open-ended", which is what the columns default to.
     * A supplied `effectiveFrom` is a definition prepared ahead of the rota
     * change it belongs to — the case effective dating exists for, and the case
     * that made this a real column rather than `created_at` in disguise.
     *
     * `null` on `effectiveTo` is how a window is left OPEN. An infinite bound is
     * not accepted: `timestamptz` takes `infinity`, every ordinary window
     * comparison is satisfied by it, and node-postgres returns it as the number
     * `Infinity` on which `.toISOString()` throws (0002's S-22).
     *
     * **In-force READ FILTERING is deliberately NOT here.** An authoring surface
     * must show the definition that is not in force yet, or it cannot be edited.
     * Selecting the in-force row belongs where the catalogue becomes engine
     * input (M4), using the shared in-force loader rather than a second
     * implementation. Recorded as a ruling, not an omission.
     */
    effectiveFrom: z.string().datetime().optional(),
    effectiveTo: z.string().datetime().nullable().optional(),
  })
  .strict();

export type CreateShiftTypeRequest = z.infer<typeof createShiftTypeRequestSchema>;

/**
 * The update body. Every field optional, `code` absent.
 *
 * A shift type's code is its permanent name: it is cited by every grid, report
 * and audit row, and changing it would silently rewrite what those citations
 * mean — the same defect class as renumbering a stable ID (non-bypass rule 13),
 * reached through tenant data instead. The database agrees: `code` is not in the
 * column-level UPDATE grant, so the statement fails 42501 even if this schema
 * were widened.
 */
export const updateShiftTypeRequestSchema = createShiftTypeRequestSchema
  .omit({ code: true })
  .partial()
  .extend({ status: z.enum(['active', 'retired']).optional() })
  .strict();

export type UpdateShiftTypeRequest = z.infer<typeof updateShiftTypeRequestSchema>;

export const shiftTypeSchema = z
  .object({
    shiftTypeId: uuid,
    code: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable(),
    displayPaletteKey: shiftPaletteKeySchema,
    displayTextStyle: shiftTextStyleSchema,
    startTime: timeOfDay,
    endTime: timeOfDay,
    crossesMidnight: z.boolean(),
    isOnCall: z.boolean(),
    attractsStipend: z.boolean(),
    isManualOnly: z.boolean(),
    isDailyPick: z.boolean(),
    includeInStatistics: z.boolean(),
    isLeaveOfAbsence: z.boolean(),
    allowOnRequest: z.boolean(),
    allowOffRequest: z.boolean(),
    reportOrder: z.number().int(),
    creditWeight: z.number(),
    status: z.enum(['active', 'retired']),
    effectiveFrom: z.string().datetime(),
    effectiveTo: z.string().datetime().nullable(),
    version: z.number().int(),
  })
  .strict();

export type ShiftType = z.infer<typeof shiftTypeSchema>;

export const shiftTypeListSchema = z
  .object({
    shiftTypes: z.array(shiftTypeSchema),
    correlationId: z.string().min(1),
  })
  .strict();

export type ShiftTypeList = z.infer<typeof shiftTypeListSchema>;

export const shiftTypeResultSchema = z
  .object({
    shiftType: shiftTypeSchema,
    correlationId: z.string().min(1),
  })
  .strict();

export type ShiftTypeResult = z.infer<typeof shiftTypeResultSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Per-weekday and holiday demand
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The whole set in one request, not one day at a time.
 *
 * I-10 — "one user action produces one request". An authoring form with eight
 * day fields and a Save button is ONE user action; eight PATCHes would be
 * request amplification wearing a REST costume. The server replaces the set,
 * so the result of a save is exactly what the form showed.
 */
export const setWeekdayDemandRequestSchema = z
  .object({
    demand: z
      .array(
        z
          .object({
            day: catalogueDaySchema,
            demandCount: z.number().int().min(0).max(999),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

export type SetWeekdayDemandRequest = z.infer<typeof setWeekdayDemandRequestSchema>;

export const weekdayDemandSchema = z
  .object({
    shiftTypeId: uuid,
    demand: z.array(
      z.object({ day: catalogueDaySchema, demandCount: z.number().int().min(0) }).strict(),
    ),
    correlationId: z.string().min(1),
  })
  .strict();

/* ────────────────────────────────────────────────────────────────────────────
 * The atomic whole-set demand replacement (OPUS-M4-000A; doc 34 §4-A)
 *
 * `setWeekdayDemandRequestSchema` / `weekdayDemandSchema` above are SUPERSEDED
 * on the wire by the aggregate form below and retained for additive-contract
 * discipline. The canonical omitted-entry rule, stated once here and mirrored
 * on the page:
 *
 *   **Saving produces exactly the presented set. A day omitted from the
 *   request — or presented with a count of zero — has its row DELETED.**
 *
 * The zero half of the rule is what the catalogue read has said since FAD-16:
 * "an absent row means no demand declared, which is zero demand". Because
 * absent and zero are the SAME reading on this surface, storing a zero row
 * would create two spellings of one fact — and would break the open-then-
 * save-unchanged no-op, since the eight-field form always presents eight
 * entries while the table holds only the positive ones.
 *
 * `expectedVersion` is the AGGREGATE demand version for the shift type
 * (`staffing_set_versions`, scope `weekday_demand`; never-written presents 1).
 * Stale → explicit `409 STALE_SET_VERSION` with the current version; nothing
 * merges, so two concurrent replacements can never combine into a union.
 * ──────────────────────────────────────────────────────────────────────────── */

export const replaceWeekdayDemandRequestSchema = z
  .object({
    demand: z
      .array(
        z
          .object({
            day: catalogueDaySchema,
            demandCount: z.number().int().min(0).max(999),
          })
          .strict(),
      )
      .max(8),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type ReplaceWeekdayDemandRequest = z.infer<typeof replaceWeekdayDemandRequestSchema>;

/**
 * The read AND the save result: always all eight days (absent rows as zero),
 * plus the aggregate version the next save must present. Editors load this
 * before opening — the version is the load-before-edit token.
 */
export const weekdayDemandSetSchema = z
  .object({
    shiftTypeId: uuid,
    demand: z.array(
      z.object({ day: catalogueDaySchema, demandCount: z.number().int().min(0) }).strict(),
    ),
    version: z.number().int().min(1),
    correlationId: z.string().min(1),
  })
  .strict();
export type WeekdayDemandSet = z.infer<typeof weekdayDemandSetSchema>;

export type WeekdayDemand = z.infer<typeof weekdayDemandSchema>;
