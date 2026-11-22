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
  + '\n;Object.assign(globalThis, { ScheduleService, toMinutes, fmtCountdown, suggestCommuteId, loadCommutes, getCommutes: () => commutes, parseMtaDepartures, calendarActiveOn, ymd, minToClock, transferAssessment, legStatus });';

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
const { parseMtaDepartures, calendarActiveOn, ymd, minToClock, transferAssessment, legStatus } = sandbox;
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

console.log('\nFull journey Port Imperial → Hoboken → PATH → 9th St (multiple service dates)');
for (const [mo, day, label] of [[6, 18, 'Wed Jun 18'], [6, 19, 'Thu Jun 19'], [6, 23, 'Mon Jun 23']]) {
  const now = wk(mo, day, 7, 50);
  const leg1 = ScheduleService.upcomingDepartures(HBLR, now)[0];
  const board1 = leg1 && minToClock(leg1.when.getHours() * 60 + leg1.when.getMinutes());
  const arrive1 = leg1 && leg1.arr;
  // onward PATH departure at/after the HBLR arrival (08:08):
  const leg2 = ScheduleService.upcomingDepartures(PATH9, now, { afterTime: '08:08' })[0];
  const t = arrive1 && leg2 ? transferAssessment(arrive1, leg2.when, 4) : null;
  const totalMin = leg1 && leg2 ? Math.round((leg2.arr.getTime() - leg1.when.getTime()) / 60000) : null;
  check(`${label}: HBLR boards 07:56`, board1 === '07:56', board1);
  check(`${label}: PATH onward boards 08:17`, leg2 && minToClock(leg2.when.getHours() * 60 + leg2.when.getMinutes()) === '08:17');
  check(`${label}: transfer feasible (9-min window ≥ 4-min buffer)`, t && t.feasible === true, t && ('window=' + t.windowMin));
  check(`${label}: total scheduled journey is 31 min (07:56→08:27)`, totalMin === 31, 'total=' + totalMin);
}

// ---------------------------------------------------------------------------
//  OPTIONAL real-feed validation: if the locally-generated (git-ignored) PATH +
//  HBLR schedule files exist, validate the ACTUAL journey. Skipped on a fresh
//  clone / CI where redistributed data is absent (so the suite stays deterministic).
// ---------------------------------------------------------------------------
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
