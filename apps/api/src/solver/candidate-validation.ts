import {
  blocksPublication,
  compileRule,
  evaluateHardRules,
  type CandidateFacts,
  type CandidatePriorAssignment,
  type CheckedAssignment,
  type CheckedVersion,
  type CompiledRule,
  type HardRuleFinding,
  type Rule,
  type RuleWeekday,
  type SolverCandidateAssignment,
  type SolverInputSnapshotDocument,
} from '@schedulepoint/domain';

/**
 * **Independent re-validation of a solver candidate** — SPEC-04 §3.3, OPUS-M4-002.
 *
 * > Every returned solution is re-validated against every `HARD` rule by an
 * > **independent checker** before it can become a schedule version. A violation
 * > fails the build.
 *
 * ## The redundancy is the point
 *
 * Trusting the worker to have honoured what we asked would make a translation
 * bug indistinguishable from a correct schedule — and a wrong schedule is the
 * single most dangerous thing this pipeline can produce, because it looks
 * exactly like a right one. So the candidate is checked again, by code that
 * shares **no evaluation logic** with the model that produced it:
 *
 * | | the model | this |
 * |---|---|---|
 * | runtime | Python, in the worker | TypeScript, in the API |
 * | input | the request | the snapshot + the returned assignments |
 * | shape | CP-SAT variables and linear statements | a pass over finished rows |
 * | shared | **the AST types and the rulings — nothing else** | |
 *
 * A constraint silently dropped from the model is therefore caught here, and the
 * standing red case proves it (`scripts/red-cases/`, the
 * `solver-model-constraint-dropped` arm).
 *
 * ## What "incorrect worker output" means, exactly
 *
 * Four classes, and none of them is a hard-rule question:
 *
 *  1. **the wrong problem** — the response echoes a `canonicalInputHash` that is
 *     not the one dispatched. A result for a different problem is not a result;
 *  2. **an unknown reference** — an assignment naming a membership, shift type or
 *     date the snapshot does not contain. The worker may only return things it
 *     was given;
 *  3. **a duplicate** — one membership placed twice on one date and shift type;
 *  4. **an ineligible assignment** — the snapshot's own verdict says this
 *     membership may not work this shift type. See below;
 *  5. **a hard violation** — found by the checker below.
 *
 * All five make the candidate **unusable**, and `M4-003` owns what the build
 * lifecycle then does with it. Nothing here persists anything.
 *
 * ## Why eligibility is a rejection class of its own (OPUS-M4-002)
 *
 * It was not one, and the gap was found by the race-produced corpus fixture
 * rather than reasoned about: the granted-while-retiring interleaving leaves a
 * **conferring holding of a retired qualification** — open-ended, `valid`, in
 * window — and the frozen verdict is the only thing that withholds eligibility
 * (FAD-35). A candidate staffing that membership on that shift type was
 * ACCEPTED here, because the four classes above have nothing to say about it and
 * the snapshot carried no HARD rule to catch it either.
 *
 * The solver model cannot produce such a row — it only creates variables for
 * eligible pairs — and that is exactly the reason the check belongs here: the
 * whole point of an independent checker is that it does not assume the model did
 * its job. A translation defect, a hand-built response, or a compromised worker
 * all produce the same row, and it would have been indistinguishable from a
 * correct schedule.
 *
 * The verdict is **read** from the snapshot, never recomputed. There is one
 * eligibility spelling in this system (`packages/domain/src/eligibility`, FROZEN)
 * and it ran once, at assembly; a second evaluation here would be the S-01
 * defect with both copies in the same language, where it is hardest to notice.
 */

/** Why a candidate may not be used. Structural facts only — never payload text. */
export type CandidateRejection =
  | { readonly reason: 'input-hash-mismatch'; readonly detail: string }
  | { readonly reason: 'unknown-reference'; readonly detail: string }
  | { readonly reason: 'duplicate-assignment'; readonly detail: string }
  | { readonly reason: 'ineligible-assignment'; readonly detail: string }
  | { readonly reason: 'hard-violation'; readonly findings: readonly HardRuleFinding[] };

export interface CandidateVerdict {
  /** `true` only when every check passed. A candidate is usable or it is not. */
  readonly usable: boolean;
  readonly rejections: readonly CandidateRejection[];
  /** Every independently measured finding, whether or not it was fatal. */
  readonly findings: readonly HardRuleFinding[];
  /** SPEC-04 §7 `hard_violations`. **Must be 0** for a usable candidate. */
  readonly hardViolations: number;
}

export interface ValidateCandidateOptions {
  readonly snapshot: SolverInputSnapshotDocument;
  readonly assignments: readonly SolverCandidateAssignment[];
  /** What was dispatched. The echo is compared against it, never trusted. */
  readonly expectedInputHash: string;
  readonly reportedInputHash: string;
}

/**
 * Validate one candidate. Pure over its arguments — no database, no clock.
 *
 * Purity is deliberate: a reviewer's probe can hand-build a deliberately
 * incorrect candidate and prove this rejects it, without a cluster.
 */
export function validateCandidate(options: ValidateCandidateOptions): CandidateVerdict {
  const { snapshot, assignments } = options;
  const rejections: CandidateRejection[] = [];

  if (options.reportedInputHash !== options.expectedInputHash) {
    rejections.push({
      reason: 'input-hash-mismatch',
      detail:
        'the worker echoed a canonical input hash that is not the one dispatched; a result ' +
        'for a different problem is not a result for this one',
    });
  }

  const codeOfShiftType = new Map(
    snapshot.shiftTypes.map((shiftType) => [shiftType.shiftTypeId, shiftType.code]),
  );
  const membershipIds = new Set(snapshot.participants.map((p) => p.membershipId));
  const dates = new Set(datesBetween(snapshot.startDate, snapshot.endDate));

  /* The FROZEN verdict, as the assembly recorded it. A pair the snapshot does
   * not carry a verdict for is NOT treated as eligible: an absent verdict is an
   * absent permission, and defaulting it to `true` would make the check pass
   * hardest exactly where the assembly went wrong. */
  const eligiblePairs = new Set<string>();
  for (const participant of snapshot.participants) {
    for (const verdict of participant.eligibility) {
      if (verdict.eligible) eligiblePairs.add(`${participant.membershipId} ${verdict.shiftTypeId}`);
    }
  }

  const seen = new Set<string>();
  for (const assignment of assignments) {
    if (!membershipIds.has(assignment.membershipId)) {
      rejections.push({
        reason: 'unknown-reference',
        detail: 'an assignment names a membership that is not a participant of this snapshot',
      });
    }
    if (!codeOfShiftType.has(assignment.shiftTypeId)) {
      rejections.push({
        reason: 'unknown-reference',
        detail: 'an assignment names a shift type that is not in this snapshot',
      });
    }
    if (!dates.has(assignment.date)) {
      rejections.push({
        reason: 'unknown-reference',
        detail: "an assignment is dated outside the snapshot's period range",
      });
    }
    if (!eligiblePairs.has(`${assignment.membershipId} ${assignment.shiftTypeId}`)) {
      rejections.push({
        reason: 'ineligible-assignment',
        detail:
          "the snapshot's own eligibility verdict does not admit this membership for this shift " +
          'type; a candidate may only staff pairs the verdict allowed',
      });
    }
    const key = `${assignment.membershipId}|${assignment.date}|${assignment.shiftTypeId}`;
    if (seen.has(key)) {
      rejections.push({
        reason: 'duplicate-assignment',
        detail: 'one membership is placed twice on one date and shift type',
      });
    }
    seen.add(key);
  }

  const findings = evaluateHardRules(compiledRulesOf(snapshot), checkedVersionOf(options));
  const violations = findings.filter((finding) => finding.finding === 'breach');
  /* A `not-evaluable` finding is fatal too, and for the reason FAD-27 gives:
   * "this HARD rule cannot be checked, so this version cannot be asserted to
   * satisfy it". A candidate the checker could not fully check is not a checked
   * candidate. */
  if (blocksPublication(findings)) {
    rejections.push({ reason: 'hard-violation', findings });
  }

  return {
    usable: rejections.length === 0,
    rejections,
    findings,
    hardViolations: violations.length,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Snapshot → the checker's world
 *
 * Every mapping here is a READ of the snapshot. Nothing is recomputed, and in
 * particular eligibility is not: the frozen verdict was evaluated at assembly
 * and the snapshot carries it. A second spelling here would be the S-01 defect
 * with the two copies in the same language, where it is hardest to notice.
 * ──────────────────────────────────────────────────────────────────────────── */

function compiledRulesOf(snapshot: SolverInputSnapshotDocument): readonly CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const revision of snapshot.ruleRevisions) {
    if (revision.status !== 'active') continue;
    /* The stored AST, already validated on the way in (migration 0015 writes a
     * revision only for a rule that passed `ruleProblems`). The cast crosses
     * `unknown` and nothing else — the VALUES are the bytes the revision row
     * reconstructs. */
    const rule = {
      ruleKey: revision.ruleKey,
      name: revision.ruleKey,
      ruleSchemaVersion: revision.ruleSchemaVersion,
      classification: revision.classification,
      ...(revision.classification === 'SOFT'
        ? { weight: Number(revision.weight ?? 0) }
        : { weight: undefined }),
      scope: revision.scope,
      predicate: revision.predicate,
    } as unknown as Rule;
    compiled.push(compileRule(rule));
  }
  return compiled;
}

function checkedVersionOf(options: ValidateCandidateOptions): CheckedVersion {
  const { snapshot, assignments } = options;
  const shiftTypeById = new Map(snapshot.shiftTypes.map((s) => [s.shiftTypeId, s]));
  const qualificationKeyById = new Map(
    snapshot.qualifications.map((q) => [q.qualificationId, q.key]),
  );
  const qualificationIdByKey = new Map(
    snapshot.qualifications.map((q) => [q.key, q.qualificationId]),
  );

  /* Holdings, indexed by the caller's own choice of key — this module decides
   * its own indexing and the domain never has to agree with it about a
   * separator (the lesson `QualificationFacts` records). */
  const holdings = new Map<string, { from: string; until: string | null; status: string }[]>();
  for (const participant of snapshot.participants) {
    for (const holding of participant.holdings) {
      const key = `${participant.membershipId}\x00${holding.qualificationId}`;
      const list = holdings.get(key) ?? [];
      list.push({
        from: holding.validFrom.slice(0, 10),
        until: holding.validUntil === null ? null : holding.validUntil.slice(0, 10),
        status: holding.status,
      });
      holdings.set(key, list);
    }
  }

  const checked: CheckedAssignment[] = assignments.map((assignment, index) => {
    const shiftType = shiftTypeById.get(assignment.shiftTypeId);
    const start = Date.parse(`${assignment.date}T${shiftType?.startTime ?? '00:00:00'}Z`);
    const endBase = Date.parse(`${assignment.date}T${shiftType?.endTime ?? '00:00:00'}Z`);
    return {
      /* The worker returns no row ids — it never saw one. A positional handle
       * keeps findings addressable without inventing an identifier that would
       * later be mistaken for a database key. */
      snapshotId: `candidate#${String(index)}`,
      assignmentIdentityId: identityOf(snapshot, assignment) ?? `candidate#${String(index)}`,
      membershipId: assignment.membershipId,
      date: assignment.date,
      startsAtMs: start,
      endsAtMs: shiftType?.crossesMidnight === true ? endBase + 86_400_000 : endBase,
      shiftTypeCode: shiftType?.code ?? '',
      isOnCall: shiftType?.isOnCall ?? false,
      /* A solver-produced assignment carries NO pick position — RK-RULING-04's
       * vacuous arm. Carried explicitly as `null` rather than omitted, because
       * omitting it would make the kind not-evaluable and block a candidate the
       * ruling says is fine. */
      pickPosition: null,
    };
  });

  const prior: CandidatePriorAssignment[] = snapshot.fixedAssignments.map((fixed) => ({
    assignmentIdentityId: fixed.assignmentIdentityId,
    membershipId: fixed.membershipId,
    date: fixed.date,
    shiftTypeCode: shiftTypeById.get(fixed.shiftTypeId)?.code ?? '',
    isPinned: fixed.isPinned,
  }));

  const staffGroups = new Map(
    snapshot.staffGroups.map((g) => [g.staffGroupId, new Set(g.memberMembershipIds)]),
  );
  const validGroups = new Map(
    snapshot.validGroups.map((g) => [
      g.validGroupId,
      new Set(g.shiftTypeIds.map((id) => shiftTypeById.get(id)?.code ?? '')),
    ]),
  );
  const workProfiles = new Map(
    snapshot.participants.map((p) => [p.membershipId, p.workProfile]),
  );

  const facts: CandidateFacts = {
    horizon: { from: snapshot.startDate, to: snapshot.endDate },
    knownStaffGroupIds: new Set(staffGroups.keys()),
    staffGroupMembers: (id) => staffGroups.get(id) ?? null,
    knownValidGroupIds: new Set(validGroups.keys()),
    validGroupShiftTypes: (id) => validGroups.get(id) ?? null,
    weekdayTarget: (membershipId: string, weekday: RuleWeekday) => {
      const profile = workProfiles.get(membershipId);
      if (profile === null || profile === undefined) return null;
      const target = profile.weekdayTargets.find((entry) => entry.day === weekday);
      if (target === undefined) return null;
      return { fteFraction: target.fteFraction, maxAssignments: target.maxAssignments };
    },
    workPercentage: (membershipId: string) => {
      const profile = workProfiles.get(membershipId);
      return profile === null || profile === undefined ? null : profile.workPercentage;
    },
    priorAssignments: prior,
  };

  return {
    assignments: checked,
    knownShiftTypeCodes: new Set(snapshot.shiftTypes.map((s) => s.code)),
    knownMembershipIds: new Set(snapshot.participants.map((p) => p.membershipId)),
    qualifications: {
      knownQualificationKeys: new Set(qualificationKeyById.values()),
      heldOn: (membershipId, key, date) => {
        const qualificationId = qualificationIdByKey.get(key);
        if (qualificationId === undefined) return false;
        for (const window of holdings.get(`${membershipId}\x00${qualificationId}`) ?? []) {
          if (window.status !== 'active') continue;
          if (date < window.from) continue;
          if (window.until !== null && date >= window.until) continue;
          return true;
        }
        return false;
      },
    },
    candidateFacts: facts,
  };
}

/** The fixed input this candidate row corresponds to, when it is one. */
function identityOf(
  snapshot: SolverInputSnapshotDocument,
  assignment: SolverCandidateAssignment,
): string | null {
  for (const fixed of snapshot.fixedAssignments) {
    if (
      fixed.membershipId === assignment.membershipId &&
      fixed.date === assignment.date &&
      fixed.shiftTypeId === assignment.shiftTypeId
    ) {
      return fixed.assignmentIdentityId;
    }
  }
  return null;
}

/** Every date in the inclusive range. Pure string arithmetic, no zone. */
function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return out;
  for (let ms = start; ms <= end; ms += 86_400_000) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}
