/**
 * REV-A PROBE 4 — the FAD-49/50/52 resultReproducibility derivation, driven
 * directly over its whole input space, including the two residuals FAD-52
 * registered as GH-008 (M-1 mid-band, M-2 solver_status fail-open) and the
 * knife-edge case measured in the GH-007 record.
 */
import {
  resultReproducibility,
  WALL_CLOCK_BINDING_FRACTION,
  DETERMINISTIC_BUDGET_UNSPENT_FRACTION,
} from 'file:///home/user/SchedulePoint/packages/domain/dist/src/index.js';

const PINNED = { randomSeed: 1, numSearchWorkers: 1, maxTimeInSeconds: 10, maxDeterministicTime: 100, interleaveSearch: true };
const BEST_EFFORT = { ...PINNED, maxDeterministicTime: null };

const rows = [];
const call = (label, o) => {
  const v = resultReproducibility({ parameters: o.parameters ?? PINNED, wallTimeSeconds: o.wall, terminationReason: o.term, status: o.status, deterministicTimeUnits: o.units });
  rows.push({ label, verdict: v.verdict, reproducible: v.reproducible, promise: /produces the same schedule/.test(v.detail), detail: v.detail.slice(0, 105) });
};

console.log('WALL_CLOCK_BINDING_FRACTION =', WALL_CLOCK_BINDING_FRACTION);
console.log('DETERMINISTIC_BUDGET_UNSPENT_FRACTION =', DETERMINISTIC_BUDGET_UNSPENT_FRACTION);
console.log();

/* The GH-007 ground truth: wall 8.6-9.1s of 10s, 8.076904 of 100 units, FEASIBLE, completed. */
call('GH-007 ground truth: wall 8.68s, 8.076904/100 units, FEASIBLE, completed', { wall: 8.68, term: 'completed', status: 'FEASIBLE', units: 8.076904 });
call('GH-007 knife edge, other side: wall 9.07s (>= 0.9*10), same facts', { wall: 9.07, term: 'completed', status: 'FEASIBLE', units: 8.076904 });

/* FAD-50 B-1: the CANCELLED deterministic run. */
call('B-1: CANCELLED status, completed termination (contradiction)', { wall: 2.35, term: 'completed', status: 'CANCELLED', units: 5.6 });
call('B-1: user_cancelled termination', { wall: 2.35, term: 'user_cancelled', status: 'CANCELLED', units: 5.6 });

/* The stopped-early boundary, both sides, exactly. */
call('stopped-early boundary: units EXACTLY 50.0 of 100 (== 0.5x)', { wall: 1, term: 'completed', status: 'FEASIBLE', units: 50 });
call('stopped-early boundary: units 50.000001 of 100 (just over 0.5x)  << GH-008 M-1', { wall: 1, term: 'completed', status: 'FEASIBLE', units: 50.000001 });
call('mid-band: units 75 of 100, FEASIBLE, completed, wall 1s  << GH-008 M-1', { wall: 1, term: 'completed', status: 'FEASIBLE', units: 75 });
call('mid-band: units 99.9 of 100 (budget essentially spent)', { wall: 1, term: 'completed', status: 'FEASIBLE', units: 99.9 });

/* FAD-52 counterexamples that must NOT be stopped-early. */
call('OPTIMAL at 76.702882/100 units (the machine of record)', { wall: 1, term: 'completed', status: 'OPTIMAL', units: 76.702882 });
call('OPTIMAL at 5 units (proof was cheap)', { wall: 1, term: 'completed', status: 'OPTIMAL', units: 5 });
call('INFEASIBLE at 0.0 units (the G1 counterexample)', { wall: 0.001075, term: 'completed', status: 'INFEASIBLE', units: 0 });

/* The null-fact holes. */
call('FEASIBLE, completed, units NULL', { wall: 1, term: 'completed', status: 'FEASIBLE', units: null });
call('solver_status NULL, completed, wall 1s, units 8/100  << GH-008 M-2', { wall: 1, term: 'completed', status: null, units: 8 });
call('solver_status NULL, completed, wall 1s, units NULL   << GH-008 M-2', { wall: 1, term: 'completed', status: null, units: null });
call('solver_status UNKNOWN, completed, wall 1s, units 8/100', { wall: 1, term: 'completed', status: 'UNKNOWN', units: 8 });
call('termination NULL', { wall: 1, term: null, status: 'FEASIBLE', units: 8 });
call('wall time NULL', { wall: null, term: 'completed', status: 'FEASIBLE', units: 8 });

/* Wall-clock rule precedence over the units rule. */
call('wall 9.5s AND units 1/100 (both rules would fire)', { wall: 9.5, term: 'completed', status: 'FEASIBLE', units: 1 });
call('wall exactly 9.0s (== 0.9*10, the boundary)', { wall: 9.0, term: 'completed', status: 'FEASIBLE', units: 75 });
call('wall 8.999999s (just under the boundary), units 75', { wall: 8.999999, term: 'completed', status: 'FEASIBLE', units: 75 });

/* Best-effort. */
call('best-effort parameter set', { parameters: BEST_EFFORT, wall: 1, term: 'completed', status: 'OPTIMAL', units: 5 });

/* Every interruption reason. */
for (const r of ['deadline', 'killed', 'crashed', 'user_cancelled', 'superseded']) {
  call(`termination=${r}`, { wall: 1, term: r, status: 'FEASIBLE', units: 8 });
}

const w = (s, n) => String(s).padEnd(n);
console.log(w('CASE', 76), w('VERDICT', 22), w('REPRO', 6), 'PROMISE-SENTENCE');
for (const r of rows) console.log(w(r.label, 76), w(r.verdict, 22), w(r.reproducible, 6), r.promise ? 'YES' : '.');

console.log('\n--- rows that CLAIM reproducibility ---');
for (const r of rows.filter((x) => x.reproducible)) console.log(' *', r.label, '\n     ', r.detail);
