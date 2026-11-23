// Deterministic tests for LinkWise core logic (no browser, no network).
//
// Loads docs/app/app.js inside a vm sandbox with minimal browser stubs so we can
// exercise the REAL ScheduleService + helpers against fixed timestamps.
//
// Run:  node tests/schedule_logic.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const schedule = JSON.parse(fs.readFileSync(path.join(root, 'docs/app/data/mock_schedule.json'), 'utf8'));
const appSrc = fs.readFileSync(path.join(root, 'docs/app/app.js'), 'utf8')
  // Expose const/function bindings (vm doesn't surface lexical decls on the context).
  + '\n;Object.assign(globalThis, { ScheduleService, toMinutes, fmtCountdown, suggestCommuteId, loadCommutes, getCommutes: () => commutes, parseMtaDepartures, calendarActiveOn, ymd, minToClock, transferAssessment, legStatus, migrateCommuteToScheduled, commuteHasScheduledEquivalent, selectLegDepartures, setLegBoarded: (a) => { legBoarded = a; }, commutePlan, planArriveBy, commuteMode, commuteArrivalBuffer, commuteWalkMinutes, departuresOnDate, fixedBoardOn, midnightOf, addDays, journeyBreakdown, journeyNodes, journeyMapSvg, isDemoCommute, suggestCommuteId, loadCommutes, deleteCommute, setCommutes: (a) => { commutes = a; }, getCommutes: () => commutes });';

// --- Minimal browser stubs --------------------------------------------------
const noop = () => {};
const fakeEl = () => ({
  innerHTML: '', className: '', style: {}, classList: { add: noop, remove: noop, contains: () => false },
  addEventListener: noop, querySelectorAll: () => [], querySelector: () => null,
  appendChild: noop, insertBefore: noop, scrollIntoView: noop, setAttribute: noop,
  getAttribute: () => null, closest: () => null, textContent: ''
});
const sandbox = {
  console,
  document: {
    getElementById: () => fakeEl(),
    querySelector: () => fakeEl(),
    createElement: () => fakeEl(),
    body: fakeEl()
  },
  localStorage: (() => { const m = {}; return {
    getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; }
  }; })(),
  setInterval: () => 0, clearInterval: noop,
  TextDecoder: globalThis.TextDecoder, Buffer,  // native in browsers; supplied to the sandbox for tests
  // init() fetches the schedule; resolve it so boot succeeds.
  fetch: async () => ({ ok: true, status: 200, json: async () => schedule }),
  Date, Math, JSON, Array, Object
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(appSrc, sandbox, { filename: 'app.js' });

const { ScheduleService, toMinutes, fmtCountdown, suggestCommuteId, loadCommutes } = sandbox;
ScheduleService.init(schedule); // ensure initialized regardless of boot timing
loadCommutes();                 // seed sample commutes synchronously for tests

// --- Tiny assert harness ----------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`); }
}

// Fixed reference day: Wednesday, Jan 15 2025 (getDay() === 3, a weekday).
const wed = (h, m, s = 0) => new Date(2025, 0, 15, h, m, s);
const sat = (h, m) => new Date(2025, 0, 18, h, m, 0); // Saturday

console.log('\ntoMinutes / fmtCountdown');
check('toMinutes parses 07:56', toMinutes('07:56') === 7 * 60 + 56);
check('toMinutes rejects junk', toMinutes('nope') === null);
check('toMinutes rejects 24:00', toMinutes('24:00') === null);
check('fmtCountdown mm:ss under an hour', fmtCountdown(5 * 60000 + 9000) === '5:09');
check('fmtCountdown h:mm:ss over an hour', fmtCountdown(3600000 + 2 * 60000 + 3000) === '1:02:03');
check('fmtCountdown clamps negatives to 0:00', fmtCountdown(-5000) === '0:00');

console.log('\nScheduleService.upcomingDepartures — next eligible departure');
{
  // Light rail Port Imperial->Hoboken has a 07:56 departure.
  const deps = ScheduleService.upcomingDepartures('hblr_port_imperial_to_hoboken', wed(7, 50));
  check('at 7:50 the soonest HBLR departure is 07:56', deps[0] && deps[0].hhmm === '07:56', deps[0] && deps[0].hhmm);
  check('following departure is 08:04', deps[1] && deps[1].hhmm === '08:04', deps[1] && deps[1].hhmm);
}
{
  // Once 07:56 passes, it must roll forward to the next one.
  const deps = ScheduleService.upcomingDepartures('hblr_port_imperial_to_hoboken', wed(7, 57));
  check('at 7:57 (just missed 07:56) soonest is 08:04', deps[0] && deps[0].hhmm === '08:04', deps[0] && deps[0].hhmm);
}
{
  // afterTime (preferred window) filters earlier departures today.
  const deps = ScheduleService.upcomingDepartures('hblr_port_imperial_to_hoboken', wed(6, 0), { afterTime: '07:56' });
  check('afterTime=07:56 yields 07:56 as first even at 6:00', deps[0] && deps[0].hhmm === '07:56', deps[0] && deps[0].hhmm);
}

console.log('\nWeekday validity — weekend rolls to next weekday');
{
  // Saturday: these services run Mon-Fri only, so the next departure is Monday.
  const deps = ScheduleService.upcomingDepartures('hblr_port_imperial_to_hoboken', sat(7, 0));
  check('no departures found earlier than Monday on a Saturday',
    deps.length > 0 && deps[0].when.getDay() === 1, deps[0] && String(deps[0].when));
  check('runsOn is false on Saturday', ScheduleService.runsOn('hblr_port_imperial_to_hoboken', sat(7, 0)) === false);
  check('runsOn is true on Wednesday', ScheduleService.runsOn('hblr_port_imperial_to_hoboken', wed(7, 0)) === true);
}

console.log('\ndescribeService — display fields');
{
  const info = ScheduleService.describeService('path_hoboken_to_33rd');
  check('operator name resolves', info.operatorName === 'PATH');
  check('origin resolves to Hoboken', info.originName === 'Hoboken', info.originName);
  check('direction is present', /33rd Street-bound/.test(info.direction), info.direction);
}

console.log('\nsuggestCommuteId — day/time relevance');
{
  // Seed the two sample commutes into the loaded `commutes` array via localStorage path.
  // suggestCommuteId reads module-level `commutes`; it was seeded during boot.
  const morningId = suggestCommuteId(wed(7, 30)); // morning window
  check('morning time suggests "Morning to NYU"', morningId === 'morning_to_nyu', morningId);
  const eveningId = suggestCommuteId(wed(17, 0)); // evening window
  check('evening time suggests "Evening Home"', eveningId === 'evening_home', eveningId);
}

// ---------------------------------------------------------------------------
//  Focused test for the real-data adapter: parse a REAL captured MTA
//  GTFS-Realtime response (tests/fixtures/mta_gtfs_123.pb) and confirm the
//  pure protobuf decoder extracts Times Sq (stop 127S) departures for the 1 train.
// ---------------------------------------------------------------------------
const { parseMtaDepartures, calendarActiveOn, ymd, minToClock, transferAssessment, legStatus,
  migrateCommuteToScheduled, commuteHasScheduledEquivalent, selectLegDepartures, setLegBoarded,
  commutePlan, planArriveBy, commuteMode, commuteArrivalBuffer, commuteWalkMinutes,
  journeyBreakdown, journeyNodes, journeyMapSvg } = sandbox;
console.log('\nMTA GTFS-Realtime adapter (real captured feed fixture)');
{
  const fixturePath = path.join(root, 'tests/fixtures/mta_gtfs_123.pb');
  const bytes = new Uint8Array(fs.readFileSync(fixturePath));
  const parsed = parseMtaDepartures(bytes, { stopId: '127S', route: '1' });
  const all = parseMtaDepartures(bytes, { stopId: '127S' }); // no route filter

  check('returns a FeedHeader timestamp (epoch seconds)',
    Number.isFinite(parsed.feedTs) && parsed.feedTs > 1600000000, 'feedTs=' + parsed.feedTs);
  check('extracts at least one 127S departure', parsed.departures.length >= 1, 'n=' + parsed.departures.length);
  check('route filter "1" keeps only route 1 departures',
    parsed.departures.length > 0 && parsed.departures.every(d => d.route === '1'),
    'routes=' + [...new Set(parsed.departures.map(d => d.route))].join(','));
  check('unfiltered 127S includes multiple routes (1/2/3)',
    new Set(all.departures.map(d => d.route)).size >= 2,
    'routes=' + [...new Set(all.departures.map(d => d.route))].join(','));
  check('departure epochs are plausible unix seconds (varint decoded without 32-bit overflow)',
    parsed.departures.every(d => d.epoch > 1600000000 && d.epoch < 2000000000),
    'sample=' + (parsed.departures[0] || {}).epoch);
  check('departures are sorted soonest-first',
    parsed.departures.every((d, i, a) => i === 0 || a[i - 1].epoch <= d.epoch));
  check('a wrong stop id yields no departures', parseMtaDepartures(bytes, { stopId: 'NOPE' }).departures.length === 0);
}

// ---------------------------------------------------------------------------
//  Build 3: SCHEDULED (published GTFS) timetable logic.
//  Uses a hand-authored SYNTHETIC corridor fixture (NOT redistributed real data)
//  that mirrors the structure tools/build_schedules.mjs generates, so the same
//  ScheduleService code paths are exercised deterministically.
// ---------------------------------------------------------------------------
const sched = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/scheduled_corridor.synthetic.json'), 'utf8'));
ScheduleService.addScheduledDoc(sched);

const HBLR = 'hblr_port_imperial_to_hblr_hoboken';
const PATH9 = 'path_hoboken_to_path_9th';
const wk = (mo, day, h, m) => new Date(2025, mo - 1, day, h, m, 0); // 2025 local dates

console.log('\nSCHEDULED helpers (calendar / overnight clock)');
check('ymd formats local date as YYYYMMDD', ymd(new Date(2025, 6, 4)) === '20250704');
check('minToClock 1549 -> 01:49 (overnight)', minToClock(1549) === '01:49');
check('minToClock 497 -> 08:17', minToClock(497) === '08:17');
{
  const cal = { days: [1, 2, 3, 4, 5], start: '20250101', end: '20251231', add: [], except: ['20250704'] };
  check('calendarActiveOn weekday true', calendarActiveOn(cal, wk(6, 18, 0, 0)) === true);       // Wed Jun 18
  check('calendarActiveOn weekend false', calendarActiveOn(cal, new Date(2025, 5, 21)) === false); // Sat Jun 21
  check('calendarActiveOn excepted holiday false', calendarActiveOn(cal, wk(7, 4, 0, 0)) === false); // Fri Jul 4 removed
}

console.log('\nScheduleService SCHEDULED — state + published departures');
check('isScheduled true for a scheduled service', ScheduleService.isScheduled(PATH9) === true);
check('isScheduled false for a mock service', ScheduleService.isScheduled('hblr_port_imperial_to_hoboken') === false);
check('scheduledState usable on an in-window weekday', ScheduleService.scheduledState(PATH9, wk(6, 18, 7, 0)).status === 'scheduled');
check('scheduledState UNAVAILABLE once expired (after serviceEnd)',
  ScheduleService.scheduledState(PATH9, new Date(2026, 0, 2)).status === 'unavailable',
  ScheduleService.scheduledState(PATH9, new Date(2026, 0, 2)).reason);
check('legStatus SCHEDULED for an in-window published leg', legStatus({ serviceId: PATH9 }, wk(6, 18, 7, 0)) === 'SCHEDULED');
check('legStatus UNAVAILABLE for an expired published leg', legStatus({ serviceId: PATH9 }, new Date(2026, 0, 2)) === 'UNAVAILABLE');
check('legStatus MOCK for a mock leg', legStatus({ serviceId: 'hblr_port_imperial_to_hoboken' }, wk(6, 18, 7, 0)) === 'MOCK');
{
  // Wed Jun 18 2025, 07:50 — soonest HBLR Port Imperial board is 07:56 arriving 08:08.
  const deps = ScheduleService.upcomingDepartures(HBLR, wk(6, 18, 7, 50));
  check('HBLR soonest board is 07:56', deps[0] && deps[0].hhmm === '07:56', deps[0] && deps[0].hhmm);
  check('HBLR departure exposes arrival 08:08 for transfer math',
    deps[0] && deps[0].arr && minToClock(deps[0].arr.getHours() * 60 + deps[0].arr.getMinutes()) === '08:08');
}

console.log('\nSCHEDULED — weekend / holiday / overnight correctness');
{
  // PATH example is weekday-only: on Saturday it must roll to the next weekday.
  const deps = ScheduleService.upcomingDepartures(PATH9, new Date(2025, 5, 21, 7, 0)); // Sat Jun 21
  check('PATH on Saturday rolls to Monday', deps[0] && deps[0].when.getDay() === 1, deps[0] && String(deps[0].when));
}
{
  // Fri Jul 4 2025 is a weekday but excepted — no PATH service that day.
  const deps = ScheduleService.upcomingDepartures(PATH9, wk(7, 4, 6, 0));
  check('PATH skips excepted holiday (no Jul 4 departure)',
    deps.every(d => ymd(d.when) !== '20250704'), deps[0] && ymd(deps[0].when));
  check('PATH after holiday resumes Monday Jul 7', deps[0] && ymd(deps[0].when) === '20250707', deps[0] && ymd(deps[0].when));
}
{
  // Just after midnight Wed, the 25:49 (01:49) overnight trip from Tue service date must appear.
  const deps = ScheduleService.upcomingDepartures(PATH9, wk(6, 18, 0, 5));
  check('overnight 01:49 departure surfaces just after midnight',
    deps.some(d => d.hhmm === '01:49' && ymd(d.when) === '20250618'),
    deps.map(d => d.hhmm).join(','));
}

console.log('\nTransfer window vs minimum buffer (distinct concepts)');
{
  const arr = wk(6, 18, 8, 8), dep = wk(6, 18, 8, 17);
  const a = transferAssessment(arr, dep, 4);
  check('actual transfer window is 9 minutes', a.windowMin === 9, 'window=' + a.windowMin);
  check('min buffer is reported separately (4), not the window', a.minBufferMin === 4);
  check('9-min window clears a 4-min buffer', a.feasible === true);
  check('9-min window FAILS a 12-min required buffer', transferAssessment(arr, dep, 12).feasible === false);
}

const hhmm = (dt) => minToClock(dt.getHours() * 60 + dt.getMinutes());

console.log('\nPRIORITY 1 — transfer-aware onward selection (feasible vs infeasible)');
{
  // Inbound arrives Hoboken 08:08. PATH options: 08:10 (2 min, INFEASIBLE),
  // 08:17 (9 min, feasible), 08:30. onwardDepartures must exclude 08:10 at buffer 4.
  const arr = wk(6, 18, 8, 8);
  const feas4 = ScheduleService.onwardDepartures(PATH9, arr, { minBufferMin: 4 });
  check('recommended onward is 08:17 (08:10 excluded by 4-min buffer)', hhmm(feas4[0].when) === '08:17', hhmm(feas4[0].when));
  check('no feasible onward is within the buffer', feas4.every(d => d.transferWindowMin >= 4));
  check('recommended onward reports a 9-min transfer window', feas4[0].transferWindowMin === 9, 'w=' + feas4[0].transferWindowMin);
  const feas1 = ScheduleService.onwardDepartures(PATH9, arr, { minBufferMin: 1 });
  check('with a 1-min buffer the 08:10 becomes feasible (first)', hhmm(feas1[0].when) === '08:10', hhmm(feas1[0].when));
}
{
  // Mirror the real Nov-24-2026 example wording: 08:09-style infeasible, 08:17 feasible.
  const arr = wk(6, 18, 8, 8);
  const picked = ScheduleService.onwardDepartures(PATH9, arr, { minBufferMin: 4 })[0];
  check('does NOT recommend the infeasible soonest train', hhmm(picked.when) !== '08:10');
  check('DOES recommend the feasible 08:17 connection', hhmm(picked.when) === '08:17');
}

console.log('\nPRIORITY 1 — selectLegDepartures uses leg-1 scheduled arrival, not device clock');
{
  const commute = { id: 'c_test', name: 'T', recurringDays: [1, 2, 3, 4, 5],
    legs: [{ serviceId: HBLR, preferredTime: 'next' }, { serviceId: PATH9, preferredTime: 'next' }] };
  const now = wk(6, 18, 7, 50);
  // Rider boarded the 07:56 HBLR (arrives 08:08); advance to leg 2.
  const leg1 = ScheduleService.upcomingDepartures(HBLR, now)[0];
  setLegBoarded([{ when: leg1.when, arr: leg1.arr }]);
  const sel = selectLegDepartures(commute, 1, now);
  check('leg-2 selection is transfer-anchored (not device time)', !!sel.transfer);
  check('leg-2 recommended departure is 08:17 (same morning)', hhmm(sel.deps[0].when) === '08:17', hhmm(sel.deps[0].when));
  check('every offered connection clears the 4-min buffer (no sub-buffer window)', sel.deps.every(d => d.transferWindowMin >= 4));
  check('transfer window (9) is distinct from the min buffer (4)', sel.transfer.windowMin === 9 && sel.transfer.buffer === 4);
  setLegBoarded([]);
}
{
  // Infeasible case: if the rider's arrival falls outside the published service
  // window (after serviceEnd), there is no valid onward departure -> UNAVAILABLE.
  const commute = { id: 'c2', name: 'T2', recurringDays: [1, 2, 3, 4, 5],
    legs: [{ serviceId: HBLR, preferredTime: 'next' }, { serviceId: PATH9, preferredTime: 'next' }] };
  const past = new Date(2026, 5, 1, 8, 0, 0); // after fixture serviceEnd 20251231
  setLegBoarded([{ when: new Date(2026, 5, 1, 7, 50, 0), arr: past }]);
  const sel = selectLegDepartures(commute, 1, past);
  check('no feasible connection -> empty deps (UNAVAILABLE path)', sel.deps.length === 0 && sel.transfer && sel.transfer.feasible === false);
  setLegBoarded([]);
}

console.log('\nPRIORITY 2 — safe migration of saved commutes onto SCHEDULED services');
{
  // Mock HBLR Port Imperial->Hoboken HAS a scheduled equivalent (same stations).
  check('scheduledEquivalentOf maps mock HBLR PI->Hoboken to scheduled',
    ScheduleService.scheduledEquivalentOf('hblr_port_imperial_to_hoboken') === HBLR,
    ScheduleService.scheduledEquivalentOf('hblr_port_imperial_to_hoboken'));
  // Mock PATH Hoboken->33rd has NO 33rd scheduled service in this fixture: must NOT
  // be silently substituted with the 9th St scheduled service.
  check('no silent 33rd->9th substitution (equivalent is null)',
    ScheduleService.scheduledEquivalentOf('path_hoboken_to_33rd') === null,
    String(ScheduleService.scheduledEquivalentOf('path_hoboken_to_33rd')));
  const original = { id: 'morning_to_nyu', name: 'Morning to NYU', recurringDays: [1, 2, 3, 4, 5],
    legs: [{ serviceId: 'hblr_port_imperial_to_hoboken', preferredTime: '07:56' },
           { serviceId: 'path_hoboken_to_33rd', preferredTime: 'next' }] };
  const { commute: migrated, changed } = migrateCommuteToScheduled(original);
  check('migration reports a change', changed === true);
  check('migration preserves id, name, days', migrated.id === 'morning_to_nyu' && migrated.name === 'Morning to NYU' && JSON.stringify(migrated.recurringDays) === JSON.stringify([1, 2, 3, 4, 5]));
  check('leg 1 repointed to SCHEDULED HBLR', migrated.legs[0].serviceId === HBLR);
  check('leg 1 preferred time preserved (07:56)', migrated.legs[0].preferredTime === '07:56');
  check('leg 2 (33rd) left UNCHANGED (no equivalent) — destination not altered', migrated.legs[1].serviceId === 'path_hoboken_to_33rd');
  check('original object not mutated (non-destructive)', original.legs[0].serviceId === 'hblr_port_imperial_to_hoboken');
  check('commuteHasScheduledEquivalent true for this commute', commuteHasScheduledEquivalent(original) === true);
}
{
  // A commute with no scheduled equivalents is preserved verbatim.
  const evening = { id: 'x', name: 'X', recurringDays: [1], legs: [{ serviceId: 'path_hoboken_to_33rd', preferredTime: 'next' }] };
  const { changed } = migrateCommuteToScheduled(evening);
  check('no-equivalent commute: migration reports no change', changed === false);
  check('no-equivalent commute: has no scheduled equivalent', commuteHasScheduledEquivalent(evening) === false);
}

console.log('\nPRIORITY 3 — scheduled preferred-time options honor selected days');
{
  const wkTimes = ScheduleService.scheduledDepartureTimes(PATH9, [1, 2, 3, 4, 5]);
  check('weekday options include 08:17', wkTimes.includes('08:17'), wkTimes.join(','));
  check('weekday options are sorted + distinct', JSON.stringify(wkTimes) === JSON.stringify([...new Set(wkTimes)].sort()));
  const weekendTimes = ScheduleService.scheduledDepartureTimes(PATH9, [0, 6]);
  check('weekend options empty (PATH fixture is weekday-only)', weekendTimes.length === 0, weekendTimes.join(','));
  const hblrSat = ScheduleService.scheduledDepartureTimes(HBLR, [6]);
  check('HBLR Saturday options include its 09:00 trip', hblrSat.includes('09:00'), hblrSat.join(','));
}

console.log('\nFull journey Port Imperial → Hoboken → PATH → 9th St (transfer-aware, multiple dates)');
for (const [mo, day, label] of [[6, 18, 'Wed Jun 18'], [6, 19, 'Thu Jun 19'], [6, 23, 'Mon Jun 23']]) {
  const now = wk(mo, day, 7, 50);
  const leg1 = ScheduleService.upcomingDepartures(HBLR, now)[0];
  const leg2 = ScheduleService.onwardDepartures(PATH9, leg1.arr, { minBufferMin: 4 })[0];
  const totalMin = Math.round((leg2.arr.getTime() - leg1.when.getTime()) / 60000);
  check(`${label}: HBLR boards 07:56`, hhmm(leg1.when) === '07:56', hhmm(leg1.when));
  check(`${label}: feasible PATH onward boards 08:17 (not 08:10)`, hhmm(leg2.when) === '08:17', hhmm(leg2.when));
  check(`${label}: transfer window 9 min ≥ 4-min buffer`, leg2.transferWindowMin === 9, 'w=' + leg2.transferWindowMin);
  check(`${label}: total scheduled journey is 31 min (07:56→08:27)`, totalMin === 31, 'total=' + totalMin);
}

// ---------------------------------------------------------------------------
//  OPTIONAL real-feed validation: if the locally-generated (git-ignored) PATH +
//  HBLR schedule files exist, validate the ACTUAL journey. Skipped on a fresh
//  clone / CI where redistributed data is absent (so the suite stays deterministic).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
//  Phase C: ARRIVE-BY scheduling. Uses the synthetic arrive_by commute
//  (Port Imperial -> Hoboken -> 9th St, target 09:00). HBLR boards 07:56/08:08;
//  PATH onward 08:10/08:17/08:30. The planner works backward from the target.
// ---------------------------------------------------------------------------
const arriveCommute = sched.sampleCommutes[0]; // scheduleMode:'arrive_by', goal 09:00, buffer 10, walk 0
const hhmm2 = (dt) => minToClock(dt.getHours() * 60 + dt.getMinutes());
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

console.log('\nPHASE C — arrive-by backward planning (9:00 AM NYU goal)');
{
  const plan = planArriveBy(arriveCommute, wk(6, 18, 0, 0), { arrivalBuffer: 10, walkMinutes: 0 });
  check('plan is feasible', plan.feasible === true, plan.reason);
  check('recommends a LATE feasible first train (08:08), not the earliest/overnight',
    hhmm2(plan.board) === '08:08', plan.board && hhmm2(plan.board));
  check('does NOT recommend an unrelated early-morning train', hhmm2(plan.board) !== '00:10' && hhmm2(plan.board) !== '04:48');
  check('reaches final station by target - buffer (08:50)', plan.finalArrive.getTime() <= wk(6, 18, 8, 50).getTime(), hhmm2(plan.finalArrive));
  check('arrives >= 10 min before 09:00 target', (wk(6, 18, 9, 0) - plan.finalArrive) / 60000 >= 10);
  // transfer buffer enforced between planned legs:
  const win = (plan.legs[1].dep - plan.legs[0].arr) / 60000;
  check('planned transfer keeps >= 4-min buffer', win >= 4, 'win=' + win);
}

console.log('\nPHASE C — configurable 10-min buffer + walking times 0/5/10/15');
{
  const b10 = planArriveBy(arriveCommute, wk(6, 18, 0, 0), { arrivalBuffer: 10, walkMinutes: 0 });
  check('buffer 10 feasible & >=10 min early', b10.feasible && (wk(6, 18, 9, 0) - b10.finalArrive) / 60000 >= 10);
  const b30 = planArriveBy(arriveCommute, wk(6, 18, 0, 0), { arrivalBuffer: 30, walkMinutes: 0 });
  check('larger buffer (30) shifts to an earlier departure (07:56)', hhmm2(b30.board) === '07:56', hhmm2(b30.board));
  const expect = { 0: '08:08', 5: '08:08', 10: '08:08', 15: '07:56' };
  for (const w of [0, 5, 10, 15]) {
    const p = planArriveBy(arriveCommute, wk(6, 18, 0, 0), { arrivalBuffer: 10, walkMinutes: w });
    check(`walk ${w} min -> board ${expect[w]}`, hhmm2(p.board) === expect[w], hhmm2(p.board));
    check(`walk ${w} min -> reach station by 08:50-walk`, p.finalArrive.getTime() <= wk(6, 18, 8, 50 - w).getTime());
  }
}

console.log('\nPHASE C — commutePlan: today vs "Next commute" framing, weekend, holiday');
{
  const p = commutePlan(arriveCommute, wk(6, 18, 3, 0)); // Wed 3 AM
  check('at 3 AM still recommends the on-time 08:08 (not 04:48/00:10)', hhmm2(p.board) === '08:08', hhmm2(p.board));
  check('today occurrence flagged isToday', p.isToday === true);
}
{
  const sat = commutePlan(arriveCommute, new Date(2025, 5, 21, 7, 0)); // Saturday
  check('weekend: rolls to next weekday (Monday)', sat.feasible && sat.date.getDay() === 1, sat.date && DAY[sat.date.getDay()]);
  check('weekend: shown as a future (not today) commute', sat.isToday === false);
  check('weekend: "Next commute" board is 08:08', hhmm2(sat.board) === '08:08', hhmm2(sat.board));
}
{
  const jul4 = commutePlan(arriveCommute, wk(7, 4, 6, 0)); // Fri Jul 4 (PATH excepted holiday)
  check('holiday: skips excepted Jul 4, next feasible is Mon Jul 7', jul4.feasible && ymd(jul4.date) === '20250707', jul4.date && ymd(jul4.date));
}
{
  // Past the last feasible train today -> rolls to the next weekday.
  const late = commutePlan(arriveCommute, wk(6, 18, 10, 0)); // Wed 10 AM (after 08:08)
  check('after last feasible train: next occurrence is tomorrow (Thu)', late.feasible && late.date.getDay() === 4 && late.isToday === false, late.date && DAY[late.date.getDay()]);
}

console.log('\nPHASE C — fixed + next-available modes');
{
  const fixedC = { id: 'f', name: 'F', scheduleMode: 'fixed', recurringDays: [1, 2, 3, 4, 5],
    legs: [{ serviceId: HBLR, preferredTime: '07:56' }, { serviceId: PATH9, preferredTime: 'next' }] };
  const p = commutePlan(fixedC, wk(6, 18, 3, 0));
  check('fixed mode boards the chosen 07:56 train', hhmm2(p.board) === '07:56', hhmm2(p.board));
  const nextC = { id: 'n', name: 'N', scheduleMode: 'next_available', recurringDays: [1, 2, 3, 4, 5],
    legs: [{ serviceId: HBLR, preferredTime: 'next' }] };
  const np = commutePlan(nextC, wk(6, 18, 3, 0));
  check('next-available boards the soonest train (07:56) from 3 AM', hhmm2(np.board) === '07:56', hhmm2(np.board));
}

console.log('\nPHASE C — backward compatibility (no stored scheduleMode)');
{
  const legacyFixed = { legs: [{ serviceId: HBLR, preferredTime: '07:56' }] };
  const legacyNext = { legs: [{ serviceId: HBLR, preferredTime: 'next' }] };
  check('legacy commute with a set time infers FIXED', commuteMode(legacyFixed) === 'fixed');
  check('legacy commute with "next" infers NEXT_AVAILABLE', commuteMode(legacyNext) === 'next_available');
  check('default arrival buffer is 10', commuteArrivalBuffer({}) === 10);
  check('default walking time is 0 (none entered)', commuteWalkMinutes({}) === 0);
  check('explicit scheduleMode always wins', commuteMode({ scheduleMode: 'arrive_by', legs: [{ serviceId: HBLR, preferredTime: '07:56' }] }) === 'arrive_by');
}

console.log('\nPHASE C — infeasible journey is explained, not invented');
{
  const badGoal = Object.assign({}, arriveCommute, { arrivalGoal: '01:00' }); // before any (even overnight) arrival
  const p = commutePlan(badGoal, wk(6, 18, 3, 0));
  check('unreachable goal -> not feasible (clear reason, no invented train)', p.feasible === false && /arrives by/.test(p.reason), p.reason);
}

// ---------------------------------------------------------------------------
//  Monday flagship: Port Imperial -> Hoboken -> 9th St -> NYU, class 10:30,
//  buffer 10, walk 10. Backward plan expects HBLR 09:40 -> Hoboken 09:52,
//  transfer 6 min, PATH 09:58 -> 9th 10:08, walk 10 -> NYU 10:18 (12 min early).
// ---------------------------------------------------------------------------
const flagship = sched.sampleCommutes.find(c => c.id === 'monday_nyu_flagship');
const mon = (h, m) => new Date(2025, 5, 2, h, m, 0); // Mon Jun 2 2025

console.log('\nFLAGSHIP — Monday 10:30 NYU backward plan');
{
  check('flagship is Monday-only, arrive-by 10:30, walk 10, NYU', flagship.recurringDays.join() === '1' && flagship.arrivalGoal === '10:30' && flagship.walkMinutes === 10 && flagship.destinationLabel === 'NYU');
  const plan = planArriveBy(flagship, mon(0, 0), { arrivalBuffer: 10, walkMinutes: 10 });
  check('plan feasible', plan.feasible === true, plan.reason);
  check('HBLR boards 09:40 (latest feasible, not an early train)', hhmm2(plan.board) === '09:40', hhmm2(plan.board));
  check('final PATH arrival (9th St) is 10:08 <= 10:30-10-10 (10:10)', hhmm2(plan.finalArrive) === '10:08', hhmm2(plan.finalArrive));
}

console.log('\nFLAGSHIP — full journey breakdown (official times vs walk assumption)');
{
  const plan = planArriveBy(flagship, mon(0, 0), { arrivalBuffer: 10, walkMinutes: 10 });
  const bd = journeyBreakdown(flagship, plan, 10);
  check('Light Rail dep 09:40 -> arr 09:52 (ride 12)', hhmm2(bd.legs[0].dep) === '09:40' && hhmm2(bd.legs[0].arr) === '09:52' && bd.legs[0].rideMin === 12);
  check('scheduled transfer wait is 6 min (>= 4-min buffer)', bd.transfers[0].waitMin === 6 && bd.transfers[0].bufferMin === 4);
  check('PATH dep 09:58 -> arr 10:08 (ride 10)', hhmm2(bd.legs[1].dep) === '09:58' && hhmm2(bd.legs[1].arr) === '10:08' && bd.legs[1].rideMin === 10);
  check('reach 9th St (station) at 10:08', hhmm2(bd.reachStation) === '10:08');
  check('estimated NYU arrival (with 10-min walk) is 10:18', hhmm2(bd.destArrive) === '10:18', hhmm2(bd.destArrive));
  check('arrives 12 min before the 10:30 class', bd.arriveEarlyMin === 12, 'early=' + bd.arriveEarlyMin);
  check('TOTAL door-to-NYU journey is 38 min', bd.totalMin === 38, 'total=' + bd.totalMin);
  check('transit-only time (no walk) is 28 min', bd.transitMin === 28, 'transit=' + bd.transitMin);
  check('walk is a SEPARATE user assumption (10 min)', bd.walk === 10);
}

console.log('\nFLAGSHIP — walking-time & buffer adjustments move NYU arrival');
{
  const p0 = journeyBreakdown(flagship, planArriveBy(flagship, mon(0, 0), { arrivalBuffer: 10, walkMinutes: 0 }), 0);
  const p10 = journeyBreakdown(flagship, planArriveBy(flagship, mon(0, 0), { arrivalBuffer: 10, walkMinutes: 10 }), 10);
  check('walk 0 -> NYU arrival equals station arrival', hhmm2(p0.destArrive) === hhmm2(p0.reachStation));
  check('walk 10 adds exactly 10 min to NYU arrival vs station', (p10.destArrive - p10.reachStation) / 60000 === 10);
  const big = planArriveBy(flagship, mon(0, 0), { arrivalBuffer: 30, walkMinutes: 10 });
  check('larger buffer (30) still arrives >= 30+10 before 10:30', (mon(10, 30) - big.finalArrive) / 60000 >= 30);
}

console.log('\nFLAGSHIP — "Next commute: Monday" framing + today');
{
  const onMon = commutePlan(flagship, mon(6, 0));
  check('on Monday morning: today’s commute, boards 09:40', onMon.isToday === true && hhmm2(onMon.board) === '09:40');
  const onWed = commutePlan(flagship, wk(6, 18, 12, 0)); // Wednesday
  check('midweek: rolls to next Monday (not today)', onWed.feasible && onWed.date.getDay() === 1 && onWed.isToday === false, onWed.date && DAY[onWed.date.getDay()]);
}

console.log('\nFLAGSHIP — schematic map state (no GPS claims)');
{
  const nodes = journeyNodes(flagship);
  check('four nodes in sequence: Port Imperial → Hoboken → 9th St → NYU',
    nodes.length === 4 && /Port Imperial/.test(nodes[0].name) && /Hoboken/.test(nodes[1].name) && /9th Street/.test(nodes[2].name) && nodes[3].name === 'NYU',
    nodes.map(n => n.name).join(' / '));
  check('final node is a WALK destination (not a rail station)', nodes[3].kind === 'walk' && nodes[0].kind === 'rail');
  check('rail nodes carry real station coordinates', nodes.slice(0, 3).every(n => typeof n.lat === 'number' && typeof n.lon === 'number'));
  const svgFull = journeyMapSvg(flagship, 0, []);
  check('map draws a dashed final walk segment', /stroke-dasharray/.test(svgFull));
  check('map shows all four labels incl. NYU', /NYU/.test(svgFull) && /Port Imperial/.test(svgFull));
  const atStart = journeyMapSvg(flagship, 0, []);
  const midTrip = journeyMapSvg(flagship, 1, [{ when: mon(9, 40), arr: mon(9, 52) }]);
  check('map renders inline SVG', /<svg/.test(atStart) && /<\/svg>/.test(atStart));
  check('active leg uses violet highlight at start', /#7c3aed/.test(atStart));
  check('completed leg turns teal after advancing', /#14b8a6/.test(midTrip) && !/#14b8a6/.test(atStart));
  check('map explicitly disclaims GPS / live tracking', /not live train position or GPS/.test(atStart));
  check('no claim of tracking the user’s own position', !/your location|we track|tracking your|live gps/i.test(atStart));
}

// ---------------------------------------------------------------------------
//  UI refinement: featured-journey selection, demo separation, safe seed/delete.
// ---------------------------------------------------------------------------
const { isDemoCommute, deleteCommute, setCommutes, getCommutes } = sandbox;

console.log('\nUI — featured journey excludes demos & is arrival-aware');
{
  check('isDemoCommute flags the MTA demo', isDemoCommute({ id: 'live_api_demo' }) === true && isDemoCommute({ demo: true }) === true);
  check('isDemoCommute false for a normal commute', isDemoCommute({ id: 'x' }) === false);
  // Seed a user commute + the demo; the demo must never be the featured journey.
  setCommutes([
    { id: 'u1', name: 'Morning', scheduleMode: 'fixed', recurringDays: [1, 2, 3, 4, 5], legs: [{ serviceId: HBLR, preferredTime: '07:56' }] },
    { id: 'live_api_demo', demo: true, name: 'Live Demo', scheduleMode: 'next_available', recurringDays: [0, 1, 2, 3, 4, 5, 6], legs: [{ serviceId: HBLR, preferredTime: 'next' }] }
  ]);
  check('suggestCommuteId never returns a demo', suggestCommuteId(wk(6, 18, 7, 0)) === 'u1');
}

console.log('\nUI — safe delete (no resurrection) & no duplicate seeding');
{
  setCommutes([
    { id: 'u1', name: 'A', legs: [{ serviceId: HBLR, preferredTime: 'next' }] },
    { id: 'u2', name: 'B', legs: [{ serviceId: PATH9, preferredTime: 'next' }] }
  ]);
  deleteCommute('u1');
  check('deleteCommute removes only the target', getCommutes().length === 1 && getCommutes()[0].id === 'u2');
  check('other commutes untouched by delete', getCommutes()[0].name === 'B');
  // loadCommutes seeds each sample at most once (tracked in SEEDED_KEY); a second
  // call must not duplicate or resurrect anything.
  loadCommutes();
  const ids1 = getCommutes().map(c => c.id);
  loadCommutes();
  const ids2 = getCommutes().map(c => c.id);
  check('repeat loadCommutes does not add duplicates', JSON.stringify(ids1) === JSON.stringify(ids2), ids2.join(','));
  check('no id appears twice after seeding', new Set(ids2).size === ids2.length, ids2.join(','));
}

console.log('\nFEATURED RANKING — Monday flagship vs older weekday commute');
{
  // Reproduces the reported setup: an older every-weekday "Morning to NYU" (fixed
  // 07:56, ends at 33rd) alongside the Monday-only arrive-by flagship (ends 9th→NYU).
  const older = { id: 'morning_to_nyu', name: 'Morning to NYU', scheduleMode: 'fixed', arrivalGoal: '09:00',
    recurringDays: [1, 2, 3, 4, 5], legs: [{ serviceId: HBLR, preferredTime: '07:56' }, { serviceId: PATH9, preferredTime: 'next' }] };
  const flag = sched.sampleCommutes.find(c => c.id === 'monday_nyu_flagship');
  setCommutes([older, flag]);
  const monAM = mon(6, 30), monLate = mon(10, 30), wedAM = wk(6, 18, 7, 0);
  check('MONDAY morning features the Monday-only flagship (not the weekday commute)',
    suggestCommuteId(monAM) === 'monday_nyu_flagship', suggestCommuteId(monAM));
  check('WEEKDAY (Wed) features the weekday commute (flagship doesn’t run)',
    suggestCommuteId(wedAM) === 'morning_to_nyu', suggestCommuteId(wedAM));
  check('after Monday’s journeys pass, next day’s weekday commute outranks next-week flagship',
    suggestCommuteId(monLate) === 'morning_to_nyu', suggestCommuteId(monLate));
}

console.log('\nSEEDING — existing localStorage keeps data, gains new sample once, no resurrection');
{
  // Simulate an existing user (old set, no SEEDED_KEY) using the real localStorage
  // path. We drive loadCommutes through the sandbox localStorage stub.
  const LS = sandbox.localStorage;
  LS.setItem('linkwise_commutes_v1', JSON.stringify([
    { id: 'morning_to_nyu', name: 'Morning to NYU', scheduleMode: 'fixed', recurringDays: [1, 2, 3, 4, 5], legs: [{ serviceId: 'hblr_port_imperial_to_hoboken', preferredTime: '07:56' }, { serviceId: 'path_hoboken_to_33rd', preferredTime: 'next' }] },
    { id: 'evening_home', name: 'Evening Home', legs: [{ serviceId: 'path_9th_to_hoboken', preferredTime: '17:12' }] }
  ]));
  LS.removeItem('linkwise_seeded_samples_v1');
  loadCommutes();
  const ids = getCommutes().map(c => c.id);
  check('existing commutes preserved', ids.includes('morning_to_nyu') && ids.includes('evening_home'));
  check('new sample (flagship) is introduced to an existing user', ids.includes('monday_nyu_flagship'));
  check('no duplicate ids after seeding', new Set(ids).size === ids.length, ids.join(','));
  const saved33 = getCommutes().find(c => c.id === 'morning_to_nyu');
  check('saved destination preserved (still 33rd Street, not substituted)', saved33.legs[1].serviceId === 'path_hoboken_to_33rd');
  check('map of the saved commute reflects its 33rd St destination',
    journeyNodes(saved33).some(nd => /33rd Street/.test(nd.name)));

  // A user who DELETES a seeded sample must not have it resurrected on reload.
  deleteCommute('monday_nyu_flagship');
  loadCommutes();
  check('deleted sample is NOT re-seeded on reload', !getCommutes().some(c => c.id === 'monday_nyu_flagship'));
}

// ---------------------------------------------------------------------------
//  DEMO data basis (public fallback). Clearly-labeled synthetic data that the
//  arrive-by planner treats like scheduled but that can NEVER be labeled
//  SCHEDULED or LIVE.
// ---------------------------------------------------------------------------
console.log('\nDEMO data basis — planned like scheduled, labeled DEMO, never SCHEDULED/LIVE');
{
  const demoDoc = {
    _meta: { dataBasis: 'demo', source: 'DEMO', serviceStart: '20250101', serviceEnd: '20301231' },
    operators: [{ id: 'DX', name: 'Demo Op', shortName: 'Demo', color: '#fb7185' }],
    stations: [{ id: 'demo_a', operator: 'DX', name: 'Demo A' }, { id: 'demo_b', operator: 'DX', name: 'Demo B' }],
    services: [{
      id: 'demo_leg1', operator: 'DX', origin: 'demo_a', destination: 'demo_b', direction: 'DEMO', line: 'Demo',
      dataBasis: 'demo',
      calendars: { wk: { days: [1, 2, 3, 4, 5], start: '20250101', end: '20301231', add: [], except: [] } },
      trips: [{ cal: 'wk', depMin: 480, arrMin: 500 }, { cal: 'wk', depMin: 540, arrMin: 560 }]
    }],
    sampleCommutes: []
  };
  ScheduleService.addScheduledDoc(demoDoc);
  check('isDemo true, isScheduled false, isLive false', ScheduleService.isDemo('demo_leg1') && !ScheduleService.isScheduled('demo_leg1') && !ScheduleService.isLive('demo_leg1'));
  check('isPlanned true (planned like scheduled)', ScheduleService.isPlanned('demo_leg1') === true);
  check('legStatus is DEMO (never SCHEDULED/LIVE)', legStatus({ serviceId: 'demo_leg1' }, wk(6, 18, 6, 0)) === 'DEMO');
  check('demo leg is NOT labeled SCHEDULED', legStatus({ serviceId: 'demo_leg1' }, wk(6, 18, 6, 0)) !== 'SCHEDULED');
  check('demo leg is NOT labeled LIVE', legStatus({ serviceId: 'demo_leg1' }, wk(6, 18, 6, 0)) !== 'LIVE');
  const deps = ScheduleService.upcomingDepartures('demo_leg1', wk(6, 18, 6, 0));
  check('demo departures are planned (08:00 first, with arrival)', deps[0] && deps[0].hhmm === '08:00' && !!deps[0].arr, deps[0] && deps[0].hhmm);
  check('demo is NOT a migration target for mock commutes', ScheduleService.scheduledEquivalentOf('demo_leg1') === null);
}

console.log('\nDEMO committed file — honest labeling + flagship present');
{
  const demo = JSON.parse(fs.readFileSync(path.join(root, 'docs/app/data/demo_schedule.json'), 'utf8'));
  check('committed demo file dataBasis is "demo"', demo._meta.dataBasis === 'demo');
  check('every demo service has dataBasis demo (never scheduled)', demo.services.every(s => s.dataBasis === 'demo'));
  check('no demo service is flagged live', demo.services.every(s => !s.live));
  check('disclaimer states times are SIMULATED / not real', /simulated/i.test(demo._meta.disclaimer) && /not real|NOT real/i.test(demo._meta.disclaimer));
  check('demo provides the Monday NYU flagship commute', demo.sampleCommutes.some(c => c.id === 'monday_nyu_flagship' && c.arrivalGoal === '10:30'));
  check('demo flagship name advertises DEMO', /DEMO/i.test(demo.sampleCommutes[0].name));
}

console.log('\nReal generated schedule files (optional, local only)');
{
  const pPath = path.join(root, 'docs/app/data/path_schedule.json');
  const hPath = path.join(root, 'docs/app/data/hblr_schedule.json');
  if (fs.existsSync(pPath) && fs.existsSync(hPath)) {
    const pDoc = JSON.parse(fs.readFileSync(pPath, 'utf8'));
    const hDoc = JSON.parse(fs.readFileSync(hPath, 'utf8'));
    ScheduleService.addScheduledDoc(pDoc);
    ScheduleService.addScheduledDoc(hDoc);
    const realHblr = hDoc.services.find(s => s.origin === 'hblr_port_imperial' && s.destination === 'hblr_hoboken');
    const realPath = pDoc.services.find(s => s.origin === 'path_hoboken' && s.destination === 'path_9th');
    check('real HBLR Port Imperial→Hoboken leg present', !!realHblr && realHblr.trips.length > 0);
    check('real PATH Hoboken→9th St leg present', !!realPath && realPath.trips.length > 0);
    check('real PATH feed advertises a serviceEnd', !!pDoc._meta.serviceEnd);
  } else {
    console.log('  – skipped (generated files not present; run `node tools/build_schedules.mjs` locally)');
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
