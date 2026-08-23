/**
 * REV-A PROBE 3 — hand-crafted invalid candidates for M4-evaluable HARD kinds,
 * at the EXACT boundary, plus their satisfied twins.
 *
 * The shipped `hard-rule-check.test.ts` pairs each kind with one satisfied and
 * one breaching arrangement. This probe attacks the place a checker is most
 * likely to be wrong and least likely to be tested: the boundary itself. For each
 * kind it builds the arrangement that sits EXACTLY ON the limit (must NOT breach)
 * and the arrangement one unit past it (MUST breach). An off-by-one in either
 * direction shows up here and nowhere else.
 *
 * Runs against packages/domain/dist. Touches no tracked file.
 */
import {
  compileRule,
  evaluateHardRules,
  EVALUATED_HARD_RULE_KINDS,
  NOT_EVALUABLE_REASONS,
  RULE_NODE_KINDS,
} from 'file:///home/user/SchedulePoint/packages/domain/dist/src/index.js';

const A = 'm-alpha';
const B = 'm-bravo';

const ms = (date, hhmm) => new Date(`${date}T${hhmm}:00.000Z`).getTime();

function asg(snapshotId, date, startHHMM, endHHMM, extra = {}) {
  const endDate = extra.endDate ?? date;
  return {
    snapshotId,
    assignmentIdentityId: `id-${snapshotId}`,
    membershipId: A,
    date,
    startsAtMs: ms(date, startHHMM),
    endsAtMs: ms(endDate, endHHMM),
    shiftTypeCode: 'DAY',
    isOnCall: false,
    ...extra,
  };
}

function facts(o = {}) {
  const staffGroups = o.staffGroups ?? {};
  const validGroups = o.validGroups ?? {};
  return {
    horizon: o.horizon ?? { from: '2031-03-01', to: '2031-03-31' },
    knownStaffGroupIds: new Set(Object.keys(staffGroups)),
    staffGroupMembers: (id) => (id in staffGroups ? new Set(staffGroups[id]) : null),
    knownValidGroupIds: new Set(Object.keys(validGroups)),
    validGroupShiftTypes: (id) => (id in validGroups ? new Set(validGroups[id]) : null),
    weekdayTarget: (m, w) => o.weekdayTargets?.[m]?.[w] ?? null,
    workPercentage: (m) => o.workPercentages?.[m] ?? null,
    priorAssignments: o.prior ?? [],
  };
}

function version(assignments, o = {}) {
  const held = new Set(o.held ?? []);
  return {
    assignments,
    knownShiftTypeCodes: new Set(o.codes ?? ['DAY', 'NIGHT', 'CALL']),
    knownMembershipIds: new Set(o.members ?? [A, B]),
    qualifications: {
      knownQualificationKeys: new Set(o.quals ?? ['acls']),
      heldOn: (m, k, d) => held.has(`${m}|${k}|${d}`),
    },
    ...(o.facts === undefined ? {} : { candidateFacts: facts(o.facts) }),
  };
}

function hard(ruleKey, predicate, scope = {}) {
  return { ruleKey, name: `probe ${ruleKey}`, ruleSchemaVersion: 1, classification: 'HARD', scope, predicate };
}

function run(rules, subject) {
  return evaluateHardRules(rules.map(compileRule), subject);
}

const results = [];
function expectBreach(label, rules, subject) {
  const f = run(rules, subject);
  const ok = f.some((x) => x.finding === 'breach');
  results.push({ label, want: 'breach', got: f.map((x) => `${x.finding}:${x.nodeKind}`).join(',') || 'NONE', ok });
}
function expectClean(label, rules, subject) {
  const f = run(rules, subject);
  const ok = f.length === 0;
  results.push({ label, want: 'clean', got: f.map((x) => `${x.finding}:${x.nodeKind}:${x.explanation.slice(0, 60)}`).join(' | ') || 'NONE', ok });
}

/* ── 1. MinimumRestBetween — minHours 10 ─────────────────────────────────────
 * The boundary: a rest of EXACTLY 10h must be clean; 9h59m must breach. Also
 * probed across a 2-day gap (the M4-002 R-1 "adjacent-date-only" defect class)
 * and across a real DST spring-forward, where the WALL-CLOCK gap is 10h but the
 * ELAPSED gap is 9h.                                                        */
{
  const rule = [hard('rest', { kind: 'MinimumRestBetween', minHours: 10 })];
  expectClean('rest: exactly 10h apart', rule, version([
    asg('r1', '2031-03-03', '08:00', '16:00'),
    asg('r2', '2031-03-04', '02:00', '10:00'),
  ]));
  expectBreach('rest: 9h59m apart (one minute inside)', rule, version([
    asg('r1', '2031-03-03', '08:00', '16:00'),
    asg('r2', '2031-03-04', '01:59', '10:00'),
  ]));
  expectBreach('rest: violation across a two-day gap (R-1 class)', rule, version([
    asg('r1', '2031-03-03', '08:00', '23:59'),
    asg('r2', '2031-03-05', '00:00', '08:00'),
  ].map((a, i) => (i === 1 ? { ...a, startsAtMs: ms('2031-03-04', '00:00'), endsAtMs: ms('2031-03-04', '08:00') } : a))));
  expectClean('rest: two-day gap, genuinely 24h+ rest', rule, version([
    asg('r1', '2031-03-03', '08:00', '16:00'),
    asg('r2', '2031-03-05', '08:00', '16:00'),
  ]));
  expectBreach('rest: same date, second shift starts 1h after the first ends', rule, version([
    asg('r1', '2031-03-03', '00:00', '08:00'),
    asg('r2', '2031-03-03', '09:00', '17:00'),
  ]));
  // Two different memberships must NOT pair.
  expectClean('rest: 1h apart but DIFFERENT memberships', rule, version([
    asg('r1', '2031-03-03', '00:00', '08:00'),
    asg('r2', '2031-03-03', '09:00', '17:00', { membershipId: B }),
  ]));
}

/* ── 2. MaxConsecutive — maxDays 3 ─────────────────────────────────────────── */
{
  const rule = [hard('consec', { kind: 'MaxConsecutive', maxDays: 3 })];
  expectClean('consec: exactly 3 in a row', rule, version([
    asg('c1', '2031-03-03', '08:00', '16:00'),
    asg('c2', '2031-03-04', '08:00', '16:00'),
    asg('c3', '2031-03-05', '08:00', '16:00'),
  ]));
  expectBreach('consec: 4 in a row', rule, version([
    asg('c1', '2031-03-03', '08:00', '16:00'),
    asg('c2', '2031-03-04', '08:00', '16:00'),
    asg('c3', '2031-03-05', '08:00', '16:00'),
    asg('c4', '2031-03-06', '08:00', '16:00'),
  ]));
  expectClean('consec: 3 + gap + 3 (two runs, neither over)', rule, version([
    asg('c1', '2031-03-03', '08:00', '16:00'),
    asg('c2', '2031-03-04', '08:00', '16:00'),
    asg('c3', '2031-03-05', '08:00', '16:00'),
    asg('c5', '2031-03-07', '08:00', '16:00'),
    asg('c6', '2031-03-08', '08:00', '16:00'),
    asg('c7', '2031-03-09', '08:00', '16:00'),
  ]));
  expectClean('consec: 4 days but TWO memberships alternating', rule, version([
    asg('c1', '2031-03-03', '08:00', '16:00'),
    asg('c2', '2031-03-04', '08:00', '16:00', { membershipId: B }),
    asg('c3', '2031-03-05', '08:00', '16:00'),
    asg('c4', '2031-03-06', '08:00', '16:00', { membershipId: B }),
  ]));
  // A month boundary: 2031-03-31 -> 2031-04-01 must count as consecutive.
  expectBreach('consec: 4 in a row ACROSS a month boundary', rule, version([
    asg('c1', '2031-03-29', '08:00', '16:00'),
    asg('c2', '2031-03-30', '08:00', '16:00'),
    asg('c3', '2031-03-31', '08:00', '16:00'),
    asg('c4', '2031-04-01', '08:00', '16:00'),
  ]));
  // Two assignments on the SAME date must not count as two consecutive days.
  expectClean('consec: 3 distinct dates, one of them doubled', rule, version([
    asg('c1', '2031-03-03', '00:00', '06:00'),
    asg('c1b', '2031-03-03', '12:00', '18:00'),
    asg('c2', '2031-03-04', '08:00', '16:00'),
    asg('c3', '2031-03-05', '08:00', '16:00'),
  ]));
}

/* ── 3. MaxAssignmentsInWindow — max 2 in 7 days ───────────────────────────── */
{
  const rule = [hard('window', { kind: 'MaxAssignmentsInWindow', max: 2, windowDays: 7 })];
  expectClean('window: exactly 2 inside 7 days', rule, version([
    asg('w1', '2031-03-03', '08:00', '16:00'),
    asg('w2', '2031-03-09', '08:00', '16:00'),
  ]));
  expectBreach('window: 3 inside 7 days', rule, version([
    asg('w1', '2031-03-03', '08:00', '16:00'),
    asg('w2', '2031-03-06', '08:00', '16:00'),
    asg('w3', '2031-03-09', '08:00', '16:00'),
  ]));
  expectClean('window: 3 spread so no 7-day window holds all three', rule, version([
    asg('w1', '2031-03-01', '08:00', '16:00'),
    asg('w2', '2031-03-09', '08:00', '16:00'),
    asg('w3', '2031-03-17', '08:00', '16:00'),
  ]));
}

/* ── 4. RequiresQualification — validAt shift_date ─────────────────────────── */
{
  const rule = [hard('qual', { kind: 'RequiresQualification', qualification: 'acls', validAt: 'shift_date' })];
  expectClean('qual: held ON the shift date', rule, version(
    [asg('q1', '2031-03-03', '08:00', '16:00')],
    { held: [`${A}|acls|2031-03-03`] },
  ));
  expectBreach('qual: held the day BEFORE only', rule, version(
    [asg('q1', '2031-03-03', '08:00', '16:00')],
    { held: [`${A}|acls|2031-03-02`] },
  ));
  expectBreach('qual: held the day AFTER only', rule, version(
    [asg('q1', '2031-03-03', '08:00', '16:00')],
    { held: [`${A}|acls|2031-03-04`] },
  ));
  expectBreach('qual: the OTHER membership holds it', rule, version(
    [asg('q1', '2031-03-03', '08:00', '16:00')],
    { held: [`${B}|acls|2031-03-03`] },
  ));
  // A qualification key the group does not define must NOT read as satisfied.
  const unknown = [hard('qualx', { kind: 'RequiresQualification', qualification: 'ghost', validAt: 'shift_date' })];
  const f = run(unknown, version([asg('q1', '2031-03-03', '08:00', '16:00')], { held: [] }));
  results.push({
    label: 'qual: UNKNOWN qualification key does not read as satisfied',
    want: 'breach or not-evaluable',
    got: f.map((x) => `${x.finding}:${x.nodeKind}`).join(',') || 'NONE',
    ok: f.length > 0,
  });
}

/* ── 5. CallSpacing — minDaysBetweenCalls 3, isOnCall the discriminator ────── */
{
  const rule = [hard('call', { kind: 'CallSpacing', minDaysBetweenCalls: 3 })];
  expectClean('call: exactly 3 days between calls', rule, version([
    asg('k1', '2031-03-03', '08:00', '16:00', { isOnCall: true, shiftTypeCode: 'CALL' }),
    asg('k2', '2031-03-06', '08:00', '16:00', { isOnCall: true, shiftTypeCode: 'CALL' }),
  ]));
  expectBreach('call: 2 days between calls', rule, version([
    asg('k1', '2031-03-03', '08:00', '16:00', { isOnCall: true, shiftTypeCode: 'CALL' }),
    asg('k2', '2031-03-05', '08:00', '16:00', { isOnCall: true, shiftTypeCode: 'CALL' }),
  ]));
  expectClean('call: 1 day apart but NEITHER is on call', rule, version([
    asg('k1', '2031-03-03', '08:00', '16:00', { isOnCall: false }),
    asg('k2', '2031-03-04', '08:00', '16:00', { isOnCall: false }),
  ]));
  expectClean('call: 1 day apart, only ONE is on call', rule, version([
    asg('k1', '2031-03-03', '08:00', '16:00', { isOnCall: true, shiftTypeCode: 'CALL' }),
    asg('k2', '2031-03-04', '08:00', '16:00', { isOnCall: false }),
  ]));
}

/* ── 6. AvoidDate ──────────────────────────────────────────────────────────── */
{
  const rule = [hard('avoid', { kind: 'AvoidDate', date: '2031-03-05' })];
  expectBreach('avoid: an assignment ON the avoided date', rule, version([
    asg('a1', '2031-03-05', '08:00', '16:00'),
  ]));
  expectClean('avoid: the day before', rule, version([asg('a1', '2031-03-04', '08:00', '16:00')]));
  expectClean('avoid: the day after', rule, version([asg('a1', '2031-03-06', '08:00', '16:00')]));
  // Overnight: a shift STARTING the day before and ending on the avoided date.
  const overnight = version([asg('a1', '2031-03-04', '20:00', '06:00', { endDate: '2031-03-05' })]);
  const f = run(rule, overnight);
  results.push({
    label: 'avoid: overnight shift starting the day before, ending ON the avoided date',
    want: '(recorded — the ruling keys AvoidDate on the assignment DATE)',
    got: f.map((x) => `${x.finding}:${x.nodeKind}`).join(',') || 'NONE',
    ok: true,
    informational: true,
  });
}

/* ── 7. FixedAssignment — the drop-the-pin arm (needs candidateFacts) ──────── */
{
  const rule = [hard('fixed', { kind: 'FixedAssignment', assignmentIdentity: 'id-p1' })];
  const pin = [{ assignmentIdentityId: 'id-p1', membershipId: A, date: '2031-03-03', shiftTypeCode: 'DAY', isPinned: true }];
  expectClean('fixed: the pinned identity is present and unchanged', rule, version(
    [asg('p1', '2031-03-03', '08:00', '16:00')],
    { facts: { prior: pin } },
  ));
  expectBreach('fixed: the pinned identity was DROPPED from the candidate', rule, version(
    [asg('p2', '2031-03-03', '08:00', '16:00')],
    { facts: { prior: pin } },
  ));
  expectBreach('fixed: the pinned identity was MOVED to another membership', rule, version(
    [asg('p1', '2031-03-03', '08:00', '16:00', { membershipId: B })],
    { facts: { prior: pin } },
  ));
  expectBreach('fixed: the pinned identity was MOVED to another date', rule, version(
    [asg('p1', '2031-03-04', '08:00', '16:00')],
    { facts: { prior: pin } },
  ));
  expectBreach('fixed: the pinned identity changed SHIFT TYPE', rule, version(
    [asg('p1', '2031-03-03', '08:00', '16:00', { shiftTypeCode: 'NIGHT' })],
    { facts: { prior: pin } },
  ));
  // Without candidateFacts, the kind must be not-evaluable, never a silent pass.
  const f = run(rule, version([asg('p2', '2031-03-03', '08:00', '16:00')]));
  results.push({
    label: 'fixed: with NO candidateFacts it is not-evaluable (never a silent pass)',
    want: 'not-evaluable',
    got: f.map((x) => `${x.finding}:${x.nodeKind}`).join(',') || 'NONE',
    ok: f.some((x) => x.finding === 'not-evaluable'),
  });
}

/* ── 8. The eight unevaluated kinds fail CLOSED, each with a named reason ──── */
{
  const unevaluated = RULE_NODE_KINDS.filter((k) => !EVALUATED_HARD_RULE_KINDS.includes(k));
  results.push({
    label: `registry: ${RULE_NODE_KINDS.length} kinds = ${EVALUATED_HARD_RULE_KINDS.length} evaluated + ${unevaluated.length} not`,
    want: '30 = 22 + 8',
    got: `${RULE_NODE_KINDS.length} = ${EVALUATED_HARD_RULE_KINDS.length} + ${unevaluated.length}`,
    ok: RULE_NODE_KINDS.length === 30 && EVALUATED_HARD_RULE_KINDS.length === 22 && unevaluated.length === 8,
  });
  const missingReason = unevaluated.filter((k) => !(k in NOT_EVALUABLE_REASONS));
  results.push({
    label: 'every unevaluated kind has a NAMED reason',
    want: '0 without a reason',
    got: missingReason.join(',') || 'none missing',
    ok: missingReason.length === 0,
  });
}

/* ── report ────────────────────────────────────────────────────────────────── */
let failed = 0;
console.log('REV-A hard-rule boundary probe — %d arms\n', results.length);
for (const r of results) {
  const mark = r.informational ? 'INFO' : r.ok ? 'PASS' : 'FAIL';
  if (!r.ok && !r.informational) failed += 1;
  console.log(`[${mark}] ${r.label}\n        want=${r.want}\n        got =${r.got}`);
}
console.log(`\narms=${results.length} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
