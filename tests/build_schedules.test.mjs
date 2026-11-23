// Deterministic unit tests for the PURE functions in tools/build_schedules.mjs.
// No network, no real GTFS data — tiny synthetic inputs exercise the tricky
// correctness-critical bits (CSV quoting, overnight times, calendar merging,
// leg extraction from stop_times, and dataset windowing).
//
// Run:  node tests/build_schedules.test.mjs

import {
  parseCsv, gtfsTimeToMinutes, isOvernightTime, buildCalendar, weekdayOf,
  extractLeg, datasetWindow, buildServices, buildScheduleDoc
} from '../tools/build_schedules.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log('\nparseCsv');
{
  const rows = parseCsv('a,b,c\n1,"x,y",3\n4,"he said ""hi""",6\n');
  check('splits header + rows', rows.length === 2);
  check('handles quoted comma', rows[0].b === 'x,y', rows[0].b);
  check('handles doubled quotes', rows[1].b === 'he said "hi"', rows[1].b);
  check('maps columns by header', rows[0].a === '1' && rows[0].c === '3');
}

console.log('\ngtfsTimeToMinutes / isOvernightTime');
check('08:17:00 -> 497', gtfsTimeToMinutes('08:17:00') === 497);
check('25:49:00 -> 1549 (overnight)', gtfsTimeToMinutes('25:49:00') === 1549);
check('H:MM accepted', gtfsTimeToMinutes('7:05') === 425);
check('junk -> null', gtfsTimeToMinutes('nope') === null);
check('isOvernightTime true for 24:00+', isOvernightTime('24:10:00') === true);
check('isOvernightTime false for 23:59', isOvernightTime('23:59:00') === false);

console.log('\nweekdayOf');
check('20250618 is Wednesday (3)', weekdayOf('20250618') === 3);
check('20250704 is Friday (5)', weekdayOf('20250704') === 5);

console.log('\nbuildCalendar — calendar.txt + calendar_dates.txt');
{
  const row = { monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '0', sunday: '0', start_date: '20250101', end_date: '20251231' };
  const cal = buildCalendar(row, [
    { date: '20250704', exception_type: '2' }, // removed (holiday)
    { date: '20250706', exception_type: '1' }  // added (special Sunday service)
  ]);
  check('weekday days [1-5]', JSON.stringify(cal.days) === JSON.stringify([1, 2, 3, 4, 5]));
  check('start/end carried', cal.start === '20250101' && cal.end === '20251231');
  check('exception_type 2 -> except', cal.except.includes('20250704'));
  check('exception_type 1 -> add', cal.add.includes('20250706'));
}
{
  // NJ-TRANSIT style: no calendar.txt, service days enumerated as add-exceptions.
  const cal = buildCalendar(null, [
    { date: '20250617', exception_type: '1' }, // Tue
    { date: '20250618', exception_type: '1' }, // Wed
    { date: '20250619', exception_type: '1' }  // Thu
  ]);
  check('derives weekday set from added dates', JSON.stringify(cal.days) === JSON.stringify([2, 3, 4]), JSON.stringify(cal.days));
  check('derives bounds from added dates', cal.start === '20250617' && cal.end === '20250619');
}

console.log('\nextractLeg — origin before destination with correct times');
{
  const st = [
    { stop_id: 'HOB', stop_sequence: '1', departure_time: '08:17:00', arrival_time: '08:17:00' },
    { stop_id: 'CHR', stop_sequence: '2', departure_time: '08:25:00', arrival_time: '08:25:00' },
    { stop_id: '9TH', stop_sequence: '3', departure_time: '08:27:00', arrival_time: '08:27:00' }
  ];
  const leg = extractLeg(st, new Set(['HOB']), new Set(['9TH']));
  check('dep@origin = 08:17 (497)', leg && leg.depMin === 497, leg && leg.depMin);
  check('arr@dest = 08:27 (507)', leg && leg.arrMin === 507, leg && leg.arrMin);
  check('wrong direction (9th before Hoboken) -> null', extractLeg(st, new Set(['9TH']), new Set(['HOB'])) === null);
  check('unserved stop -> null', extractLeg(st, new Set(['HOB']), new Set(['WTC'])) === null);
}

console.log('\ndatasetWindow');
{
  const w = datasetWindow({
    a: { start: '20250301', end: '20250901', add: ['20250110'], except: ['20251005'] },
    b: { start: '20250201', end: '20250801', add: [], except: [] }
  });
  check('serviceStart is earliest bound incl. add', w.serviceStart === '20250110', w.serviceStart);
  check('serviceEnd is latest bound incl. except', w.serviceEnd === '20251005', w.serviceEnd);
}

console.log('\nbuildServices / buildScheduleDoc — end to end on synthetic GTFS');
{
  const tables = {
    stops: [
      { stop_id: 'HOB1', stop_name: 'Hoboken' },
      { stop_id: '9TH1', stop_name: '9th Street' },
      { stop_id: '33S1', stop_name: '33rd Street' }
    ],
    routes: [{ route_id: 'BLU', route_short_name: 'BLU' }],
    trips: [
      { route_id: 'BLU', service_id: 'wk', trip_id: 't1' },
      { route_id: 'BLU', service_id: 'wk', trip_id: 't2' }
    ],
    stop_times: [
      { trip_id: 't1', stop_id: 'HOB1', stop_sequence: '1', departure_time: '08:17:00', arrival_time: '08:17:00' },
      { trip_id: 't1', stop_id: '9TH1', stop_sequence: '2', departure_time: '08:27:00', arrival_time: '08:27:00' },
      { trip_id: 't2', stop_id: 'HOB1', stop_sequence: '1', departure_time: '08:30:00', arrival_time: '08:30:00' },
      { trip_id: 't2', stop_id: '9TH1', stop_sequence: '2', departure_time: '08:40:00', arrival_time: '08:40:00' }
    ],
    calendar: [{ service_id: 'wk', monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '0', sunday: '0', start_date: '20250101', end_date: '20251231' }],
    calendar_dates: []
  };
  const cfg = {
    operatorId: 'PATH', operatorName: 'PATH', operatorShort: 'PATH', color: '#4d92fb',
    routeMatch: () => true,
    stations: [
      { id: 'path_hoboken', name: 'Hoboken', gtfsName: 'Hoboken' },
      { id: 'path_9th', name: '9th Street', gtfsName: '9th Street' }
    ],
    legs: [{ origin: 'path_hoboken', dest: 'path_9th', direction: '33rd Street-bound' }]
  };
  const services = buildServices(tables, cfg);
  check('one corridor service built', services.length === 1, 'n=' + services.length);
  check('service id is origin_to_dest', services[0].id === 'path_hoboken_to_path_9th', services[0].id);
  check('two trips captured, sorted by departure', services[0].trips.length === 2 && services[0].trips[0].depMin === 497);
  check('dataBasis scheduled', services[0].dataBasis === 'scheduled');

  const doc = buildScheduleDoc(tables, cfg, {
    source: 'test', sourceUrl: 'x', fetchedAt: 'now',
    disclaimer: 'd', attribution: 'a', sampleCommutes: []
  });
  check('doc _meta.dataBasis scheduled', doc._meta.dataBasis === 'scheduled');
  check('doc window serviceEnd set', doc._meta.serviceEnd === '20251231', doc._meta.serviceEnd);
  check('doc exposes operator + stations', doc.operators[0].id === 'PATH' && doc.stations.length === 2);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
