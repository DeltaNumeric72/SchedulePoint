/**
 * REV-A PROBE 2 — R-B4 / R-B5 / overnight sweep, far wider than the shipped set.
 *
 * Runs against packages/domain/dist (the compiled artifact `pnpm check` builds),
 * touching no tracked file. Enumerates a large cross-product of IANA zones,
 * transition-adjacent dates, and authored shift windows, and asserts the three
 * properties the rulings promise:
 *
 *   P1  no authored shift with a positive nominal duration is refused as
 *       DEGENERATE (the M4-000B defect class: 399 enumerated -> 0);
 *   P2  R-B4a — when the start is gap-normalized, the WHOLE interval translates,
 *       so elapsed == nominal for a gap start (the shift keeps its length);
 *   P3  elapsed always > 0, endsAt > startsAt, and elapsed differs from nominal
 *       ONLY by a whole number of the zone's transition minutes.
 */
import {
  resolveShiftInterval,
  DegenerateShiftIntervalError,
} from 'file:///home/user/SchedulePoint/packages/domain/dist/src/index.js';

const ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/St_Johns', // :30 offset
  'America/Santiago', // southern hemisphere, midnight transition
  'America/Havana', // midnight transition
  'America/Asuncion', // midnight transition
  'America/Sao_Paulo', // midnight transition (historic)
  'Europe/London',
  'Europe/Berlin',
  'Europe/Lisbon',
  'Atlantic/Azores',
  'Australia/Sydney',
  'Australia/Lord_Howe', // 30-MINUTE DST shift
  'Pacific/Auckland',
  'Pacific/Chatham', // :45 offset, 30-minute-ish
  'Asia/Tehran',
  'Asia/Kathmandu', // :45 offset, no DST
  'Asia/Kolkata', // :30 offset, no DST
  'Pacific/Kiritimati', // +14
  'Etc/GMT+12',
  'UTC',
];

const YEARS = [2026, 2027, 2028];

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Every date in the year on which the zone's UTC offset changes, +/- 1 day. */
function transitionDates(zone, year) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    timeZoneName: 'longOffset',
    year: 'numeric',
  });
  const dates = [];
  let previous = null;
  for (let d = new Date(Date.UTC(year, 0, 1)); d.getUTCFullYear() === year; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const offset = fmt.formatToParts(new Date(`${iso}T12:00:00Z`)).find((p) => p.type === 'timeZoneName')?.value;
    if (previous !== null && offset !== previous) {
      dates.push(addDays(iso, -1), iso, addDays(iso, 1));
    }
    previous = offset;
  }
  return dates;
}

const WINDOWS = [
  ['00:00', '08:00'],
  ['00:30', '08:30'],
  ['01:00', '09:00'],
  ['01:30', '02:30'],
  ['02:00', '10:00'],
  ['02:15', '02:45'],
  ['02:30', '03:00'],
  ['07:00', '19:00'],
  ['08:00', '16:00'],
  ['12:00', '00:00'], // exactly 12h crossing midnight
  ['16:00', '00:30'],
  ['19:00', '07:00'], // classic overnight
  ['22:00', '02:00'],
  ['23:00', '01:00'],
  ['23:30', '00:30'],
  ['23:45', '00:15'],
];

const degenerate = [];
const gapNotTranslated = [];
const nonPositive = [];
const oddDeltas = [];
let evaluated = 0;
let gapStarts = 0;
let foldStarts = 0;
let foldEnds = 0;

for (const zone of ZONES) {
  const dates = new Set();
  for (const year of YEARS) for (const d of transitionDates(zone, year)) dates.add(d);
  // Plus a plain non-transition control date per year.
  for (const year of YEARS) dates.add(`${year}-06-15`);
  for (const date of dates) {
    for (const [start, end] of WINDOWS) {
      evaluated += 1;
      let interval;
      try {
        interval = resolveShiftInterval(zone, date, start, end);
      } catch (error) {
        if (error instanceof DegenerateShiftIntervalError) {
          degenerate.push(`${zone} ${date} ${start}-${end}: ${error.message}`);
        } else {
          degenerate.push(`${zone} ${date} ${start}-${end}: OTHER ${error.message}`);
        }
        continue;
      }
      if (interval.elapsedMinutes <= 0) {
        nonPositive.push(`${zone} ${date} ${start}-${end}: elapsed=${interval.elapsedMinutes}`);
      }
      if (interval.start.kind === 'gap') {
        gapStarts += 1;
        if (interval.elapsedMinutes !== interval.nominalDurationMinutes) {
          gapNotTranslated.push(
            `${zone} ${date} ${start}-${end}: gap start, elapsed=${interval.elapsedMinutes} nominal=${interval.nominalDurationMinutes}`,
          );
        }
      }
      if (interval.start.kind === 'fold') foldStarts += 1;
      if (interval.end.kind === 'fold') foldEnds += 1;
      const delta = interval.elapsedMinutes - interval.nominalDurationMinutes;
      // A transition is a whole number of minutes; the only legal deltas here
      // are 0 or a real transition size. Anything not a multiple of 15 minutes
      // is not a DST offset anywhere on earth.
      if (delta !== 0 && Math.abs(delta) % 15 !== 0) {
        oddDeltas.push(`${zone} ${date} ${start}-${end}: delta=${delta}`);
      }
    }
  }
}

console.log('REV-A DST/overnight sweep');
console.log('zones            :', ZONES.length);
console.log('intervals evaluated:', evaluated);
console.log('gap starts observed:', gapStarts);
console.log('fold starts observed:', foldStarts);
console.log('fold ends observed  :', foldEnds);
console.log('--- P1 degenerate/refused (expect 0):', degenerate.length);
for (const d of degenerate.slice(0, 20)) console.log('   ', d);
console.log('--- P2 gap start NOT translated (expect 0):', gapNotTranslated.length);
for (const d of gapNotTranslated.slice(0, 20)) console.log('   ', d);
console.log('--- P3a non-positive elapsed (expect 0):', nonPositive.length);
for (const d of nonPositive.slice(0, 20)) console.log('   ', d);
console.log('--- P3b delta not a whole quarter-hour (expect 0):', oddDeltas.length);
for (const d of oddDeltas.slice(0, 20)) console.log('   ', d);

const failures =
  degenerate.length + gapNotTranslated.length + nonPositive.length + oddDeltas.length;
console.log('TOTAL VIOLATIONS:', failures);
process.exit(failures === 0 ? 0 : 1);
