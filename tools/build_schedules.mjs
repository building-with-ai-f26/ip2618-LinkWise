// LinkWise — Build 3 schedule preprocessor.
//
// Downloads the OFFICIAL static GTFS timetables for PATH and NJ TRANSIT (which
// carries Hudson-Bergen Light Rail), filters them down to the LinkWise NJ<->NYC
// commute corridor, and emits two lightweight JSON files the static app can load
// directly:
//
//     docs/app/data/path_schedule.json   (SCHEDULED — PATH)
//     docs/app/data/hblr_schedule.json   (SCHEDULED — Hudson-Bergen Light Rail)
//
// WHY PREPROCESS: the raw feeds are ~16-19 MB uncompressed; parsing GTFS ZIPs in
// the browser on every load would be far too heavy for GitHub Pages / mobile.
// We extract only the corridor stations + legs we need and preserve the exact
// published stop times (we never invent or round them).
//
// IMPORTANT — redistribution:
//   * NJ TRANSIT's developer terms REQUIRE a registered developer account and
//     allow hosting a SUBSET of the data on a third-party server, used AS-IS,
//     with a "not real-time / not endorsed by NJT" disclaimer.
//   * PATH/PANYNJ redistribution permission is NOT yet confirmed.
//   Therefore the generated files are git-ignored (see .gitignore). Do not commit
//   them until permission is verified.
//
// This file is split into PURE, dependency-free functions (unit-tested in
// tests/build_schedules.test.mjs) and a thin CLI that shells out to `curl`/`unzip`
// (only when run directly: `node tools/build_schedules.mjs`).

import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ===========================================================================
//  PURE helpers (no I/O) — these are the correctness-critical, tested pieces.
// ===========================================================================

// Parse GTFS CSV text into an array of row objects. Handles quoted fields that
// contain commas and doubled "" escapes, and strips a UTF-8 BOM if present.
export function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQ = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* ignore */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.length && !(r.length === 1 && r[0] === '')).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] !== undefined ? r[i].trim() : ''); });
    return o;
  });
}

// Convert a GTFS "HH:MM:SS" (or "H:MM") clock, which may exceed 24:00 for
// after-midnight trips, into integer minutes-after-midnight-of-the-service-date.
// "25:49:00" -> 1549 (i.e. 01:49 the following calendar day). Returns null on junk.
export function gtfsTimeToMinutes(hms) {
  const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(String(hms).trim());
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]);
}

// True if the time is an after-midnight (>= 24:00) GTFS time.
export function isOvernightTime(hms) {
  const mins = gtfsTimeToMinutes(hms);
  return mins != null && mins >= 1440;
}

// Build a compact calendar model for one service_id by combining calendar.txt
// (weekly pattern + start/end) with calendar_dates.txt exceptions.
//   calendarRow: a row object from calendar.txt (or null if the feed has none)
//   exceptions:  array of { date, exception_type } for this service_id
// Returns { days:[0..6], start:"YYYYMMDD", end:"YYYYMMDD", add:[...], except:[...] }.
// exception_type 1 = service ADDED on date; 2 = service REMOVED on date.
export function buildCalendar(calendarRow, exceptions = []) {
  const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const days = [];
  let start = null, end = null;
  if (calendarRow) {
    for (let i = 0; i < 7; i++) if (String(calendarRow[DOW[i]]) === '1') days.push(i);
    start = calendarRow.start_date || null;
    end = calendarRow.end_date || null;
  }
  const add = [], except = [];
  for (const e of exceptions) {
    if (String(e.exception_type) === '1') add.push(e.date);
    else if (String(e.exception_type) === '2') except.push(e.date);
  }
  // Feeds with no calendar.txt (e.g. NJ TRANSIT) enumerate every service day as
  // an "added" exception. Derive the weekly day-set + bounds from those dates so
  // the runtime can still answer runsOn()/lookahead efficiently.
  if (!calendarRow && add.length) {
    const dset = new Set();
    let mn = null, mx = null;
    for (const d of add) {
      const wd = weekdayOf(d);
      if (wd != null) dset.add(wd);
      if (mn == null || d < mn) mn = d;
      if (mx == null || d > mx) mx = d;
    }
    return { days: [...dset].sort(), start: mn, end: mx, add, except };
  }
  return { days, start, end, add, except };
}

// Day-of-week (0=Sun..6=Sat) for a "YYYYMMDD" string, using UTC to avoid TZ drift.
export function weekdayOf(ymd) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(ymd));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
}

// From one trip's ordered stop_times, extract the (departure@origin, arrival@dest)
// pair for a leg, requiring the origin to be visited before the destination.
//   stopTimes: array of { stop_id, stop_sequence, departure_time, arrival_time }
//   originIds / destIds: Sets of acceptable gtfs stop_ids for each end
// Returns { depMin, arrMin } or null if this trip doesn't serve the leg in order.
export function extractLeg(stopTimes, originIds, destIds) {
  const seq = stopTimes
    .map(s => ({ ...s, seq: +s.stop_sequence }))
    .sort((a, b) => a.seq - b.seq);
  let o = null, d = null;
  for (const s of seq) {
    if (o == null && originIds.has(s.stop_id)) o = s;
    else if (o != null && destIds.has(s.stop_id)) { d = s; break; }
  }
  if (!o || !d) return null;
  const depMin = gtfsTimeToMinutes(o.departure_time || o.arrival_time);
  const arrMin = gtfsTimeToMinutes(d.arrival_time || d.departure_time);
  if (depMin == null || arrMin == null) return null;
  return { depMin, arrMin };
}

// Derive the overall [serviceStart, serviceEnd] window of a set of calendars so
// the runtime can flag the whole dataset UNAVAILABLE once it is out of date.
export function datasetWindow(calendars) {
  let start = null, end = null;
  for (const c of Object.values(calendars)) {
    if (c.start && (start == null || c.start < start)) start = c.start;
    if (c.end && (end == null || c.end > end)) end = c.end;
    for (const dts of [c.add, c.except]) for (const d of (dts || [])) {
      if (start == null || d < start) start = d;
      if (end == null || d > end) end = d;
    }
  }
  return { serviceStart: start, serviceEnd: end };
}

// ===========================================================================
//  Corridor configuration — WHICH stations and legs LinkWise cares about.
//  Extend these lists to widen corridor coverage later.
// ===========================================================================

// PATH official feed (https://www.panynj.gov/content/dam/path/gtfs/PATH_GTFS.zip)
// identifies stations by name; several platform-level stop_ids share a name.
const PATH_STATIONS = [
  { id: 'path_hoboken', name: 'Hoboken', gtfsName: 'Hoboken' },
  { id: 'path_newport', name: 'Newport', gtfsName: 'Newport' },
  { id: 'path_9th', name: '9th Street', gtfsName: '9th Street' },
  { id: 'path_33rd', name: '33rd Street', gtfsName: '33rd Street' }
];
const PATH_LEGS = [
  { origin: 'path_hoboken', dest: 'path_9th', direction: '33rd Street-bound (via Christopher St)' },
  { origin: 'path_9th', dest: 'path_hoboken', direction: 'Hoboken-bound' },
  { origin: 'path_hoboken', dest: 'path_33rd', direction: '33rd Street-bound' },
  { origin: 'path_33rd', dest: 'path_hoboken', direction: 'Hoboken-bound' },
  { origin: 'path_newport', dest: 'path_33rd', direction: '33rd Street-bound' },
  { origin: 'path_33rd', dest: 'path_newport', direction: 'Newport / Journal Square-bound' }
];

// NJ TRANSIT rail feed (https://www.njtransit.com/rail_data.zip) — HBLR is route
// short_name "HBLR". Stations are matched by exact stop_name.
const HBLR_STATIONS = [
  { id: 'hblr_port_imperial', name: 'Port Imperial', gtfsName: 'PORT IMPERIAL HBLR STATION' },
  { id: 'hblr_hoboken', name: 'Hoboken Terminal', gtfsName: 'HOBOKEN TERMINAL LIGHT RAIL STATION' }
];
const HBLR_LEGS = [
  { origin: 'hblr_port_imperial', dest: 'hblr_hoboken', direction: 'Southbound toward Hoboken' },
  { origin: 'hblr_hoboken', dest: 'hblr_port_imperial', direction: 'Northbound toward Port Imperial / Tonnelle Ave' }
];

// ===========================================================================
//  Feed -> corridor schedule document (pure given already-parsed GTFS tables).
// ===========================================================================

// Build the services[] for one operator from parsed GTFS tables.
//   tables: { stops, routes, trips, stop_times, calendar, calendar_dates }
//   cfg: { operatorId, operatorName, operatorShort, color, routeMatch(route)->bool,
//          stations:[{id,name,gtfsName}], legs:[{origin,dest,direction}] }
export function buildServices(tables, cfg) {
  const { stops, trips, stop_times, calendar = [], calendar_dates = [], routes = [] } = tables;

  // name -> Set(stop_id) for our corridor stations (include child/platform ids).
  const idsByStation = {};
  for (const st of cfg.stations) idsByStation[st.id] = new Set();
  for (const s of stops) {
    for (const st of cfg.stations) {
      if ((s.stop_name || '').trim() === st.gtfsName) idsByStation[st.id].add(s.stop_id);
    }
  }

  // Which route_ids belong to this operator/mode?
  const okRoute = new Set(routes.filter(r => cfg.routeMatch(r)).map(r => r.route_id));

  // Index stop_times by trip_id.
  const stByTrip = new Map();
  for (const s of stop_times) {
    if (!stByTrip.has(s.trip_id)) stByTrip.set(s.trip_id, []);
    stByTrip.get(s.trip_id).push(s);
  }

  // Index calendar_dates exceptions by service_id.
  const exByService = new Map();
  for (const e of calendar_dates) {
    if (!exByService.has(e.service_id)) exByService.set(e.service_id, []);
    exByService.get(e.service_id).push(e);
  }
  const calByService = new Map(calendar.map(c => [c.service_id, c]));

  // Build compact calendars lazily, keyed by GTFS service_id.
  const calendars = {};
  const calKey = (serviceId) => {
    if (!calendars[serviceId]) {
      calendars[serviceId] = buildCalendar(
        calByService.get(serviceId) || null,
        exByService.get(serviceId) || []
      );
    }
    return serviceId;
  };

  const services = [];
  for (const leg of cfg.legs) {
    const originIds = idsByStation[leg.origin];
    const destIds = idsByStation[leg.dest];
    if (!originIds || !destIds || !originIds.size || !destIds.size) continue;

    const tripRows = [];
    const usedCals = new Set();
    for (const t of trips) {
      if (okRoute.size && !okRoute.has(t.route_id)) continue;
      const st = stByTrip.get(t.trip_id);
      if (!st) continue;
      const pair = extractLeg(st, originIds, destIds);
      if (!pair) continue;
      const cal = calKey(t.service_id);
      usedCals.add(cal);
      tripRows.push({ cal, depMin: pair.depMin, arrMin: pair.arrMin });
    }
    if (!tripRows.length) continue;
    tripRows.sort((a, b) => a.depMin - b.depMin);

    const legCalendars = {};
    for (const c of usedCals) legCalendars[c] = calendars[c];

    services.push({
      id: `${leg.origin}_to_${leg.dest}`.replace(/^(path|hblr)_/, m => m), // keep readable ids
      operator: cfg.operatorId,
      origin: leg.origin,
      destination: leg.dest,
      direction: leg.direction,
      line: cfg.operatorShort,
      dataBasis: 'scheduled',
      calendars: legCalendars,
      trips: tripRows
    });
  }
  return services;
}

// Assemble a full schedule document (what the app loads).
export function buildScheduleDoc(tables, cfg, meta) {
  const services = buildServices(tables, cfg);
  const allCals = {};
  for (const s of services) Object.assign(allCals, s.calendars);
  const win = datasetWindow(allCals);
  return {
    _meta: {
      dataBasis: 'scheduled',
      source: meta.source,
      sourceUrl: meta.sourceUrl,
      fetchedAt: meta.fetchedAt,
      generatedBy: 'tools/build_schedules.mjs',
      serviceStart: win.serviceStart,
      serviceEnd: win.serviceEnd,
      disclaimer: meta.disclaimer,
      attribution: meta.attribution
    },
    operators: [{
      id: cfg.operatorId, name: cfg.operatorName,
      shortName: cfg.operatorShort, color: cfg.color
    }],
    stations: cfg.stations.map(s => ({ id: s.id, operator: cfg.operatorId, name: s.name })),
    services,
    sampleCommutes: meta.sampleCommutes || []
  };
}

// ===========================================================================
//  CLI (impure): download + unzip + parse + write. Runs only when invoked
//  directly. Requires `curl` and `unzip` on PATH.
// ===========================================================================

const PATH_FEED = 'https://www.panynj.gov/content/dam/path/gtfs/PATH_GTFS.zip';
const NJT_FEED = 'https://www.njtransit.com/rail_data.zip';

function readTables(dir, files) {
  const t = {};
  for (const f of files) {
    const p = join(dir, f + '.txt');
    t[f] = existsSync(p) ? parseCsv(readFileSync(p, 'utf8')) : [];
  }
  return t;
}

function downloadAndUnzip(url, cacheDir, name) {
  mkdirSync(cacheDir, { recursive: true });
  const zip = join(cacheDir, name + '.zip');
  const out = join(cacheDir, name);
  console.log(`  downloading ${url}`);
  execFileSync('curl', ['-sS', '-L', '-o', zip, '-m', '90', url], { stdio: 'inherit' });
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  execFileSync('unzip', ['-o', '-q', zip, '-d', out], { stdio: 'inherit' });
  return out;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = join(here, '..');
  const cache = join(here, '.gtfs_cache');
  const outDir = join(repo, 'docs/app/data');
  const now = new Date().toISOString();

  // --- PATH ---
  console.log('PATH (PANYNJ official GTFS):');
  const pDir = downloadAndUnzip(PATH_FEED, cache, 'path');
  const pTables = readTables(pDir, ['stops', 'routes', 'trips', 'stop_times', 'calendar', 'calendar_dates']);
  const pDoc = buildScheduleDoc(pTables, {
    operatorId: 'PATH', operatorName: 'PATH', operatorShort: 'PATH', color: '#4d92fb',
    routeMatch: () => true, stations: PATH_STATIONS, legs: PATH_LEGS
  }, {
    source: 'PATH (Port Authority Trans-Hudson, official PANYNJ GTFS)',
    sourceUrl: PATH_FEED, fetchedAt: now,
    disclaimer: 'SCHEDULED published PATH timetable times. Not real-time; not a live prediction.',
    attribution: 'Schedule data from PATH / Port Authority of NY & NJ. Not endorsed by or affiliated with PANYNJ.',
    sampleCommutes: []
  });
  writeFileSync(join(outDir, 'path_schedule.json'), JSON.stringify(pDoc, null, 2));
  console.log(`  wrote path_schedule.json (${pDoc.services.length} services, ${pDoc._meta.serviceStart}->${pDoc._meta.serviceEnd})`);

  // --- HBLR (inside NJ TRANSIT rail feed) ---
  console.log('Hudson-Bergen Light Rail (NJ TRANSIT rail GTFS):');
  const nDir = downloadAndUnzip(NJT_FEED, cache, 'njrail');
  const nTables = readTables(nDir, ['stops', 'routes', 'trips', 'stop_times', 'calendar', 'calendar_dates']);
  const hDoc = buildScheduleDoc(nTables, {
    operatorId: 'HBLR', operatorName: 'Hudson-Bergen Light Rail', operatorShort: 'Light Rail', color: '#2dd4bf',
    routeMatch: (r) => (r.route_short_name || '').toUpperCase() === 'HBLR',
    stations: HBLR_STATIONS, legs: HBLR_LEGS
  }, {
    source: 'Hudson-Bergen Light Rail (NJ TRANSIT rail GTFS)',
    sourceUrl: NJT_FEED, fetchedAt: now,
    disclaimer: 'SCHEDULED published HBLR timetable times. Not real-time; not a live prediction.',
    attribution: 'Data obtained from NJ TRANSIT and redistributed by LinkWise. May not be real-time. Not licensed or endorsed by NJ TRANSIT.',
    sampleCommutes: [{
      id: 'scheduled_morning_pi_9th',
      name: 'Morning: Port Imperial \u2192 9th St (Scheduled)',
      recurringDays: [1, 2, 3, 4, 5],
      legs: [
        { serviceId: 'hblr_port_imperial_to_hblr_hoboken', preferredTime: 'next' },
        { serviceId: 'path_hoboken_to_path_9th', preferredTime: 'next' }
      ]
    }]
  });
  writeFileSync(join(outDir, 'hblr_schedule.json'), JSON.stringify(hDoc, null, 2));
  console.log(`  wrote hblr_schedule.json (${hDoc.services.length} services, ${hDoc._meta.serviceStart}->${hDoc._meta.serviceEnd})`);

  console.log('\nDone. NOTE: generated files are git-ignored pending redistribution approval.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
