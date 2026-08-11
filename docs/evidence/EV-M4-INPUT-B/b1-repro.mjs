const W = '/Users/prabashan/Claude/SchedulePoint/.worktrees/m4-000b';
const { resolveShiftInterval } = await import(`${W}/packages/domain/dist/src/time/zoned-time.js`);
for (const [zone, date, s, e, gap] of [
  ['America/New_York','2027-03-14','02:30','03:00','1h'],
  ['Australia/Lord_Howe','2027-10-03','02:10','02:25','30m'],
  ['Antarctica/Troll','2027-03-28','01:30','02:30','2h'],
]) {
  try {
    const i = resolveShiftInterval(zone, date, s, e);
    console.log(`${zone.padEnd(22)} ${s}->${e} gap=${gap}  elapsed=${i.elapsedMinutes}min  ORDERED=${i.endsAt>i.startsAt}`);
  } catch (err) { console.log(`${zone.padEnd(22)} ${s}->${e} gap=${gap}  REFUSED: ${err.constructor.name}: ${String(err.message).slice(0,90)}`); }
}
