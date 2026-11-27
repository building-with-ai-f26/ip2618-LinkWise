// LinkWise — Smarter connections, every day.
//
// A personalized commuter assistant for NJ <-> NYC riders. The centerpiece is a
// large, colorful departure countdown that updates every second and rolls to
// the next eligible departure when one passes.
//
// ILLUSTRATIVE MOCK DATA ONLY. Departure times come from app/data/mock_schedule.json
// and are hand-entered recurring EXAMPLES — not live or verified PATH /
// NJ Transit / Hudson-Bergen Light Rail schedules. Nothing here is real-time.
//
// Architecture (future-API friendly):
//   mock_schedule.json  ->  ScheduleService (the single data seam)  ->  UI
// Swapping in a real transit API later means reimplementing ScheduleService
// only; the dashboard, countdown, and onboarding code stay the same.

const COMMUTES_KEY = 'linkwise_commutes_v1';
const SEEDED_KEY = 'linkwise_seeded_samples_v1';   // ids of sample commutes ever seeded (prevents duplicate accumulation)
const MIGRATION_KEY = 'linkwise_migrated_v2';       // one-time privacy migration flag
const PERSONAL_SAMPLE_IDS = ['morning_to_nyu', 'evening_home']; // removed in Build 4

// A "recommended" (comfortable) transfer threshold for DISPLAY ONLY. The planner
// still uses MIN_TRANSFER_BUFFER_MIN (4) as the feasibility floor; this larger
// value only drives a "tight connection" warning in the UI. Not a default change.
const RECOMMENDED_COMFORT_MIN = 7;

let SCHEDULE = null;          // raw mock schedule document
let commutes = [];            // user commutes (persisted)
let activeCommuteId = null;   // currently shown commute (session)
let activeLegIndex = 0;       // which leg of the active commute is in focus
let legBoarded = [];          // per-leg boarded train {when, arr} captured as the rider advances
let tickHandle = null;        // setInterval handle for the 1s countdown

// ---- Robust helpers: never fail silently -----------------------------------

function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing page element #${id} (HTML/JS out of sync — try a hard refresh).`);
  return node;
}

function showFatalError(err) {
  console.error('[LinkWise] load failed:', err);
  let banner = document.getElementById('fatal-error');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'fatal-error';
    banner.style.cssText =
      'margin:0 auto 20px;max-width:560px;background:#7f1d1d;color:#fff;border:1px solid #ef4444;' +
      'border-radius:12px;padding:14px 16px;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;';
    const wrap = document.querySelector('.wrap') || document.body;
    wrap.insertBefore(banner, wrap.firstChild);
  }
  banner.innerHTML =
    '<strong>LinkWise couldn\u2019t load.</strong> ' +
    String(err && err.message ? err.message : err) +
    '<br><span style="opacity:.85">Fix: run <code>python3 -m http.server</code> from the <code>app/</code> folder and hard-refresh (Cmd/Ctrl+Shift+R).</span>';
}

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- Toast notifications (save feedback, warnings) ------------------------

function showToast(message, type = 'info') {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function checkStorageAvailable() {
  try {
    const test = '__storage_test__';
    localStorage.setItem(test, test);
    localStorage.removeItem(test);
    return true;
  } catch {
    return false;
  }
}

// ===========================================================================
//  ScheduleService — the ONLY place that knows about the data source.
//  Replace the internals here to connect a real PATH / NJT / HBLR API later.
// ===========================================================================

const ScheduleService = {
  doc: null,
  _scheduledDocs: [],            // additional SCHEDULED documents (PATH / HBLR)
  _schedMetaByService: {},       // serviceId -> owning scheduled doc's _meta
  init(doc) { this.doc = doc; this._scheduledDocs = []; this._schedMetaByService = {}; },

  // Merge a preprocessed SCHEDULED document (from tools/build_schedules.mjs) into
  // the live service catalog. Operators/stations/services are added (deduped by id)
  // so every existing accessor keeps working uniformly. Safe if the file is absent.
  addScheduledDoc(sdoc) {
    if (!sdoc || !Array.isArray(sdoc.services)) return;
    this._scheduledDocs.push(sdoc);
    const meta = sdoc._meta || {};
    for (const op of (sdoc.operators || [])) if (!this.doc.operators.some(o => o.id === op.id)) this.doc.operators.push(op);
    for (const st of (sdoc.stations || [])) if (!this.doc.stations.some(s => s.id === st.id)) this.doc.stations.push(st);
    for (const sv of sdoc.services) {
      if (!this.doc.services.some(s => s.id === sv.id)) this.doc.services.push(sv);
      this._schedMetaByService[sv.id] = meta;
    }
  },

  operator(id) { return this.doc.operators.find(o => o.id === id) || null; },
  station(id) { return this.doc.stations.find(s => s.id === id) || null; },
  service(id) { return this.doc.services.find(s => s.id === id) || null; },
  get services() { return this.doc.services; },
  get sampleCommutes() {
    let out = (this.doc.sampleCommutes || []).slice();
    for (const sd of this._scheduledDocs) if (Array.isArray(sd.sampleCommutes)) out = out.concat(sd.sampleCommutes);
    return out;
  },

  // Is this service powered by a real-time API (not mock)?
  isLive(serviceId) { const s = this.service(serviceId); return !!(s && s.live); },

  // Is this service backed by a published timetable (SCHEDULED, not live, not mock)?
  isScheduled(serviceId) { const s = this.service(serviceId); return !!(s && s.dataBasis === 'scheduled'); },
  // Is this a clearly-labeled synthetic DEMO service (illustrative, never real)?
  isDemo(serviceId) { const s = this.service(serviceId); return !!(s && s.dataBasis === 'demo'); },
  // "Planned" = timetable-shaped (trips + calendars): SCHEDULED or DEMO. Both are
  // planned/transfer-checked the same way; only their LABEL differs. (Never LIVE/MOCK.)
  isPlanned(serviceId) { const s = this.service(serviceId); return !!(s && (s.dataBasis === 'scheduled' || s.dataBasis === 'demo')); },
  scheduledMeta(serviceId) { return this._schedMetaByService[serviceId] || null; },

  // SCHEDULED availability: a published timetable can go stale. Returns
  //   { status: 'scheduled' } when usable, or
  //   { status: 'unavailable', reason } when expired / not-yet-effective / empty.
  // This is what powers the honest UNAVAILABLE state (we never show expired times
  // as if current).
  scheduledState(serviceId, now = new Date()) {
    const svc = this.service(serviceId);
    if (!svc || !(svc.dataBasis === 'scheduled' || svc.dataBasis === 'demo')) return { status: 'n/a' };
    const meta = this.scheduledMeta(serviceId) || {};
    const today = ymd(now);
    if (meta.serviceEnd && today > meta.serviceEnd) return { status: 'unavailable', reason: 'published schedule has expired' };
    if (meta.serviceStart && today < meta.serviceStart) return { status: 'unavailable', reason: 'schedule not yet in effect' };
    if (!Array.isArray(svc.trips) || !svc.trips.length) return { status: 'unavailable', reason: 'no scheduled trips for this leg' };
    return { status: 'scheduled' };
  },

  // Live cache keyed by serviceId:
  //   { status: 'loading'|'live'|'unavailable', reason, departures:[{when,route,epoch}], feedTs, fetchedAt }
  _liveCache: {},
  liveState(serviceId) { return this._liveCache[serviceId] || { status: 'loading' }; },

  // Fetch + parse the real MTA feed for a live service, updating the cache.
  // Never throws: any failure sets status 'unavailable' with a reason.
  async refreshLive(serviceId) {
    const svc = this.service(serviceId);
    if (!svc || !svc.live) return;
    const set = (o) => { this._liveCache[serviceId] = Object.assign({ fetchedAt: Date.now() }, o); };
    let buf;
    try {
      const res = await fetch(svc.feedUrl, { cache: 'no-store' });
      if (!res.ok) return set({ status: 'unavailable', reason: `feed HTTP ${res.status}`, departures: [] });
      buf = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      return set({ status: 'unavailable', reason: 'network error reaching the MTA feed', departures: [] });
    }
    let parsed;
    try {
      parsed = parseMtaDepartures(buf, { stopId: svc.gtfsStopId, route: svc.routeFilter });
    } catch (e) {
      return set({ status: 'unavailable', reason: 'could not parse GTFS-Realtime feed', departures: [] });
    }
    const nowS = Date.now() / 1000;
    const maxAge = svc.maxFeedAgeSeconds || 120;
    if (parsed.feedTs && (nowS - parsed.feedTs) > maxAge) {
      return set({ status: 'unavailable', reason: 'live feed is stale', feedTs: parsed.feedTs, departures: [] });
    }
    const future = parsed.departures
      .filter(d => d.epoch * 1000 >= Date.now() - 15000) // allow 15s grace
      .map(d => ({ serviceId, when: new Date(d.epoch * 1000), epoch: d.epoch, route: d.route, live: true }))
      .sort((a, b) => a.when - b.when);
    if (!future.length) {
      return set({ status: 'unavailable', reason: 'no upcoming departures returned', feedTs: parsed.feedTs, departures: [] });
    }
    set({ status: 'live', feedTs: parsed.feedTs, departures: future });
  },

  // Human-readable summary of a service leg for display.
  describeService(serviceId) {
    const svc = this.service(serviceId);
    if (!svc) return null;
    const op = this.operator(svc.operator);
    return {
      serviceId,
      operatorId: svc.operator,
      operatorName: op ? op.name : svc.operator,
      operatorShort: op ? op.shortName : svc.operator,
      operatorColor: op ? op.color : '#8b5cf6',
      originName: (this.station(svc.origin) || {}).name || svc.origin,
      destinationName: (this.station(svc.destination) || {}).name || svc.destination,
      direction: svc.direction,
      line: svc.line
    };
  },

  // Does this service run on the given day? (0=Sun..6=Sat)
  runsOn(serviceId, date) {
    const svc = this.service(serviceId);
    if (!svc) return false;
    if (svc.dataBasis === 'scheduled' || svc.dataBasis === 'demo') {
      const cals = svc.calendars || {};
      return (svc.trips || []).some(t => calendarActiveOn(cals[t.cal], date));
    }
    const days = Array.isArray(svc.validDays) ? svc.validDays : [0, 1, 2, 3, 4, 5, 6];
    return days.includes(date.getDay());
  },

  // SCHEDULED upcoming departures: expand real trips over calendar days, honoring
  // weekly patterns, add/except exceptions, and after-midnight (>=24:00) GTFS times.
  // We start one day in the PAST so an overnight trip from yesterday's service date
  // (e.g. a 25:49 = 01:49-next-day departure) is still offered early in the morning.
  // Each item carries both `when` (board) and `arr` (alight) for transfer math.
  _schedUpcoming(svc, now, lookaheadDays, afterTime) {
    const cals = svc.calendars || {};
    const minToday = afterTime ? toMinutes(afterTime) : null;
    const out = [];
    for (let d = -1; d <= lookaheadDays; d++) {
      const day = new Date(now);
      day.setDate(now.getDate() + d);
      day.setHours(0, 0, 0, 0);
      for (const t of (svc.trips || [])) {
        if (!calendarActiveOn(cals[t.cal], day)) continue;
        if (d === 0 && minToday != null && (t.depMin % 1440) < minToday) continue;
        const when = new Date(day.getTime() + t.depMin * 60000);
        if (when.getTime() < now.getTime()) continue;
        const arr = (t.arrMin != null) ? new Date(day.getTime() + t.arrMin * 60000) : null;
        out.push({ serviceId: svc.id, hhmm: minToClock(t.depMin), when, arr, scheduled: true });
      }
      if (out.length >= 8) break;
    }
    out.sort((a, b) => a.when - b.when);
    return out.slice(0, 8);
  },

  // Core seam: upcoming departures for a service as absolute Date timestamps,
  // searching today and the next few valid days. Returns soonest-first.
  // `afterTime` (optional "HH:MM") filters out departures earlier than it today.
  upcomingDepartures(serviceId, now, { lookaheadDays = 7, afterTime = null } = {}) {
    const svc = this.service(serviceId);
    if (!svc) return [];
    if (svc.dataBasis === 'scheduled' || svc.dataBasis === 'demo') return this._schedUpcoming(svc, now, lookaheadDays, afterTime);
    if (!Array.isArray(svc.departures)) return [];
    const out = [];
    const minToday = afterTime ? toMinutes(afterTime) : null;

    for (let d = 0; d <= lookaheadDays; d++) {
      const day = new Date(now);
      day.setDate(now.getDate() + d);
      day.setHours(0, 0, 0, 0);
      if (!this.runsOn(serviceId, day)) continue;

      for (const hhmm of svc.departures) {
        const mins = toMinutes(hhmm);
        if (mins == null) continue;
        if (d === 0 && minToday != null && mins < minToday) continue; // respect preferred window today
        const when = new Date(day);
        when.setMinutes(mins);
        if (when.getTime() >= now.getTime()) {
          out.push({ serviceId, hhmm, when });
        }
      }
      if (out.length >= 6) break; // enough for "next" + "following"
    }
    out.sort((a, b) => a.when - b.when);
    return out;
  },

  // Transfer-aware departures for a CONNECTING leg. Given the scheduled arrival
  // of the inbound train, return only onward departures a rider could actually
  // catch: those at/after (arrival + minimum transfer buffer). Each is annotated
  // with transferWindowMin (minutes from arrival to this departure). This is how
  // we avoid recommending an infeasible connection (e.g. a train 1 min after you
  // step off). Anchored on the scheduled arrival — NOT the device clock.
  onwardDepartures(serviceId, prevArrival, { minBufferMin = MIN_TRANSFER_BUFFER_MIN, lookaheadDays = 7 } = {}) {
    if (!prevArrival) return [];
    const anchor = new Date(prevArrival.getTime() + minBufferMin * 60000);
    return this.upcomingDepartures(serviceId, anchor, { lookaheadDays })
      .map(d => Object.assign({}, d, { transferWindowMin: Math.round((d.when - prevArrival) / 60000) }));
  },

  // Find a SCHEDULED service covering the SAME origin+destination stations as a
  // given (mock) service. Used to safely migrate saved commutes onto published
  // schedules WITHOUT ever changing the stations/destination. Returns an id or null.
  scheduledEquivalentOf(serviceId) {
    const m = this.service(serviceId);
    if (!m || m.dataBasis === 'scheduled' || m.dataBasis === 'demo' || m.live) return null;
    const sc = this.doc.services.find(s =>
      s.dataBasis === 'scheduled' && s.origin === m.origin && s.destination === m.destination);
    return sc ? sc.id : null;
  },

  // All scheduled trips for a service that run on a given service date, as absolute
  // {dep, arr, hhmm} (overnight-aware: depMin/arrMin may exceed 24h). Returns [] for
  // non-scheduled services (mock/live) because the arrive-by planner needs arrivals.
  tripsOn(serviceId, date) {
    const svc = this.service(serviceId);
    if (!svc || !(svc.dataBasis === 'scheduled' || svc.dataBasis === 'demo') || !Array.isArray(svc.trips)) return [];
    const cals = svc.calendars || {};
    const mid = midnightOf(date);
    const out = [];
    for (const t of svc.trips) {
      if (!calendarActiveOn(cals[t.cal], date)) continue;
      const dep = new Date(mid.getTime() + t.depMin * 60000);
      const arr = (t.arrMin != null) ? new Date(mid.getTime() + t.arrMin * 60000) : null;
      out.push({ dep, arr, hhmm: minToClock(t.depMin) });
    }
    out.sort((a, b) => a.dep - b.dep);
    return out;
  },

  // Distinct scheduled departure clock times for a service that RUN on at least
  // one of the given weekdays (0=Sun..6=Sat) — for the commute-creation dropdown.
  // Uses the weekly calendar pattern (date-specific exceptions apply at runtime).
  scheduledDepartureTimes(serviceId, days = [0, 1, 2, 3, 4, 5, 6]) {
    const svc = this.service(serviceId);
    if (!svc || !(svc.dataBasis === 'scheduled' || svc.dataBasis === 'demo') || !Array.isArray(svc.trips)) return [];
    const cals = svc.calendars || {};
    const daySet = new Set(days);
    const times = new Set();
    for (const t of svc.trips) {
      const cal = cals[t.cal];
      if (!cal || !(cal.days || []).some(d => daySet.has(d))) continue;
      times.add(minToClock(t.depMin));
    }
    return [...times].sort();
  }
};

// ===========================================================================
//  GTFS-Realtime adapter (pure functions) for the official MTA subway feed.
//  No dependencies: a minimal protobuf wire-format decoder extracts just the
//  fields we need (FeedHeader.timestamp, TripUpdate.trip.route_id, and each
//  StopTimeUpdate.stop_id + departure/arrival time). Exposed for unit testing.
// ===========================================================================

// Read a base-128 varint starting at index i. Uses multiplication (not <<) so
// values beyond 31 bits (e.g. epoch seconds) stay exact in JS numbers.
function _pbVarint(bytes, i) {
  let shift = 1, result = 0, b;
  do { b = bytes[i++]; result += (b & 0x7f) * shift; shift *= 128; } while (b & 0x80);
  return [result, i];
}

// Walk one protobuf message, returning [{ f: fieldNumber, w: wireType, v }].
// For length-delimited fields v is a Uint8Array slice; for varints v is a number.
function _pbFields(bytes) {
  const out = [];
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    let key; [key, i] = _pbVarint(bytes, i);
    const f = Math.floor(key / 8), w = key & 7;
    if (w === 0) { let v; [v, i] = _pbVarint(bytes, i); out.push({ f, w, v }); }
    else if (w === 2) { let ln; [ln, i] = _pbVarint(bytes, i); out.push({ f, w, v: bytes.subarray(i, i + ln) }); i += ln; }
    else if (w === 1) { out.push({ f, w, v: bytes.subarray(i, i + 8) }); i += 8; }
    else if (w === 5) { out.push({ f, w, v: bytes.subarray(i, i + 4) }); i += 4; }
    else throw new Error('unsupported wire type ' + w);
  }
  return out;
}

function _pbStr(u8) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);
  return Buffer.from(u8).toString('utf8'); // Node fallback (tests)
}

// Parse a GTFS-Realtime FeedMessage and return upcoming departures for one
// GTFS stop_id (e.g. '127S'), optionally filtered to a route_id (e.g. '1').
// Returns { feedTs, departures: [{ epoch, route }] } sorted soonest-first.
function parseMtaDepartures(bytes, { stopId, route = null } = {}) {
  const top = _pbFields(bytes);
  let feedTs = null;
  const departures = [];
  for (const { f, w, v } of top) {
    if (f === 1 && w === 2) {                 // FeedHeader
      for (const h of _pbFields(v)) if (h.f === 3 && h.w === 0) feedTs = h.v;
    } else if (f === 2 && w === 2) {          // FeedEntity
      let tu = null;
      for (const e of _pbFields(v)) if (e.f === 3 && e.w === 2) tu = e.v; // trip_update
      if (!tu) continue;
      let routeId = null;
      const stus = [];
      for (const t of _pbFields(tu)) {
        if (t.f === 1 && t.w === 2) {         // TripDescriptor
          for (const d of _pbFields(t.v)) if (d.f === 5 && d.w === 2) routeId = _pbStr(d.v);
        } else if (t.f === 2 && t.w === 2) {  // StopTimeUpdate (repeated)
          stus.push(t.v);
        }
      }
      if (route && routeId !== route) continue;
      for (const stu of stus) {
        let sid = null, depT = null, arrT = null;
        for (const s of _pbFields(stu)) {
          if (s.f === 4 && s.w === 2) sid = _pbStr(s.v);               // stop_id
          else if (s.f === 3 && s.w === 2) {                           // departure event
            for (const x of _pbFields(s.v)) if (x.f === 2 && x.w === 0) depT = x.v;
          } else if (s.f === 2 && s.w === 2) {                         // arrival event
            for (const x of _pbFields(s.v)) if (x.f === 2 && x.w === 0) arrT = x.v;
          }
        }
        const t = depT || arrT;
        if (sid === stopId && t) departures.push({ epoch: t, route: routeId });
      }
    }
  }
  departures.sort((a, b) => a.epoch - b.epoch);
  return { feedTs, departures };
}

// ---- Time helpers ----------------------------------------------------------

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function fmtClock(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtCountdown(ms) {
  if (ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---- SCHEDULED (GTFS) helpers ---------------------------------------------

// Local-date key "YYYYMMDD" for a Date (used to match GTFS calendar bounds +
// add/except exception dates against the rider's day).
function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// Is a compact calendar active on `date`? add[] forces service on; otherwise the
// date must fall within [start,end], match a weekday, and not be in except[].
function calendarActiveOn(cal, date) {
  if (!cal) return false;
  const key = ymd(date);
  if (Array.isArray(cal.add) && cal.add.includes(key)) return true;
  if (cal.start && key < cal.start) return false;
  if (cal.end && key > cal.end) return false;
  if (Array.isArray(cal.except) && cal.except.includes(key)) return false;
  return (cal.days || []).includes(date.getDay());
}

// Minutes-after-midnight (possibly >=1440 for overnight) -> "HH:MM" clock label.
function minToClock(m) {
  const mm = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(mm / 60)).padStart(2, '0') + ':' + String(mm % 60).padStart(2, '0');
}

// Local midnight of a date, and a date shifted by whole days (DST-safe enough for
// commute planning). Used by the arrive-by planner to anchor service dates.
function midnightOf(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; }
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }

// Minimum in-station transfer buffer we require a rider to have (minutes). This
// is the SAFETY floor and is distinct from the actual scheduled gap between a
// train's arrival and the next train's departure (the "transfer window").
const MIN_TRANSFER_BUFFER_MIN = 4;

// Assess a connection: `arr` = alighting time of the inbound leg, `dep` =
// departure of the onward leg. Returns the actual window and whether it clears
// the required minimum buffer. windowMin (e.g. 9) is NOT the buffer (e.g. 4).
function transferAssessment(arr, dep, minBufferMin = MIN_TRANSFER_BUFFER_MIN) {
  if (!arr || !dep) return null;
  const windowMin = Math.round((dep.getTime() - arr.getTime()) / 60000);
  return { windowMin, minBufferMin, feasible: windowMin >= minBufferMin };
}

// ---- Persistence (safe if storage unavailable) -----------------------------

function sampleToCommute(c) {
  const out = {
    id: c.id,
    name: c.name,
    recurringDays: c.recurringDays.slice(),
    legs: c.legs.map(l => ({ serviceId: l.serviceId, preferredTime: l.preferredTime }))
  };
  // Carry arrive-by scheduling fields when the sample provides them (Phase C).
  if (c.scheduleMode) out.scheduleMode = c.scheduleMode;
  if (c.arrivalGoal != null) out.arrivalGoal = c.arrivalGoal;
  if (Number.isFinite(c.arrivalBuffer)) out.arrivalBuffer = c.arrivalBuffer;
  if (Number.isFinite(c.walkMinutes)) out.walkMinutes = c.walkMinutes;
  if (c.destinationLabel) out.destinationLabel = c.destinationLabel;
  if (c.demo) out.demo = true;
  return out;
}

// Demo commutes (e.g. the MTA LIVE demo) live in the "Explore" area, not the
// featured journey or the "My Commutes" list.
function isDemoCommute(c) { return !!(c && (c.demo || c.id === 'live_api_demo')); }

// One-time migration: convert removed personal samples to user-owned commutes so
// existing users keep their data. New visitors never see these samples.
function migratePersonalSamples() {
  try {
    const migrated = localStorage.getItem(MIGRATION_KEY);
    if (migrated) return false; // already migrated
    
    let changed = false;
    commutes = commutes.map(c => {
      if (PERSONAL_SAMPLE_IDS.includes(c.id)) {
        // Convert to user-owned with new ID so it's clearly theirs
        changed = true;
        return { ...c, id: randId('cmt_'), _migratedFromSample: true };
      }
      return c;
    });
    
    if (changed) {
      console.log('[LinkWise] Migrated', PERSONAL_SAMPLE_IDS.length, 'personal samples to user commutes');
    }
    localStorage.setItem(MIGRATION_KEY, 'true');
    return changed;
  } catch (e) {
    console.error('[LinkWise] Migration failed:', e);
    return false;
  }
}

// Seed each sample commute AT MOST ONCE EVER (tracked in SEEDED_KEY), so renamed
// or newly-added samples never pile up as duplicates and a user's deletion is
// respected (a seeded id is never re-added). Existing localStorage is preserved.
function loadCommutes() {
  let saved = null, seeded = [];
  try { saved = JSON.parse(localStorage.getItem(COMMUTES_KEY)); } catch { saved = null; }
  try { seeded = JSON.parse(localStorage.getItem(SEEDED_KEY)) || []; } catch { seeded = []; }
  if (!Array.isArray(seeded)) seeded = [];
  commutes = Array.isArray(saved) ? saved : [];

  // Run one-time migration for existing users
  const migrated = migratePersonalSamples();

  let changed = !Array.isArray(saved) || migrated;
  for (const s of ScheduleService.sampleCommutes) {
    if (seeded.includes(s.id)) continue;             // already seeded once — never again
    if (!commutes.some(c => c.id === s.id)) { commutes.push(sampleToCommute(s)); }
    seeded.push(s.id);
    changed = true;
  }
  // De-dupe by id defensively (guards against any legacy accumulation).
  const seen = new Set();
  const before = commutes.length;
  commutes = commutes.filter(c => (c && !seen.has(c.id)) ? (seen.add(c.id), true) : false);
  if (commutes.length !== before) changed = true;

  if (changed) { saveCommutes(); try { localStorage.setItem(SEEDED_KEY, JSON.stringify(seeded)); } catch {} }
}
function saveCommutes() {
  try {
    localStorage.setItem(COMMUTES_KEY, JSON.stringify(commutes));
    showToast('✓ Saved', 'success');
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      showToast('⚠ Storage full — delete old commutes to free space', 'error');
    } else {
      showToast('Save failed · Check storage settings', 'error');
    }
    console.error('[LinkWise] saveCommutes failed:', e);
  }
}

function randId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 8);
}

// ===========================================================================
//  Dashboard suggestion: pick the most relevant commute for "now".
// ===========================================================================

// Score each commute by how soon its first leg departs today (running services
// only). The soonest upcoming first-leg wins; commutes not running today sink.
function suggestCommuteId(now) {
  let best = null;
  const userCommutes = commutes.filter(c => !isDemoCommute(c)); // featured excludes demos
  for (const c of userCommutes) {
    if (!c.legs.length) continue;
    // Use each commute's OWN scheduling mode + next occurrence (arrival-goal aware).
    const plan = commutePlan(c, now);
    if (!plan.feasible) continue;
    const msAway = Math.max(0, (plan.board - now) / 60000); // minutes until departure
    // Ranking (smaller = more relevant), in strict priority order:
    //   1) a journey happening TODAY beats one on a future day;
    //   2) AMONG today's journeys, a more day-SPECIFIC one wins (e.g. a Monday-only
    //      commute is "the plan for Monday" vs a runs-every-weekday commute) — this
    //      is recurrence-based, not hardcoded to any particular commute;
    //   3) then the soonest departure. For future days, rank purely by soonest
    //      occurrence (so tomorrow beats next week).
    const specificity = (Array.isArray(c.recurringDays) && c.recurringDays.length) ? c.recurringDays.length : 7;
    const score = (plan.isToday ? 0 : 1e15) + (plan.isToday ? specificity * 1e12 : 0) + msAway;
    if (!best || score < best.score) best = { id: c.id, score };
  }
  return best ? best.id : (userCommutes[0] ? userCommutes[0].id : (commutes[0] ? commutes[0].id : null));
}

// ===========================================================================
//  Rendering
// ===========================================================================

function activeCommute() {
  return commutes.find(c => c.id === activeCommuteId) || null;
}

// Resolve the chosen departure for a leg: the next departure at/after its
// preferred time (today), else the next available.
function legDepartures(leg, now) {
  // LIVE legs read from the real-time cache (populated by the background poller).
  if (ScheduleService.isLive(leg.serviceId)) {
    const st = ScheduleService.liveState(leg.serviceId);
    if (st.status !== 'live') return [];
    return st.departures.filter(d => d.when >= now);
  }
  const preferred = leg.preferredTime && leg.preferredTime !== 'next' ? leg.preferredTime : null;
  // Always fetch the raw next departures (soonest first).
  const next = ScheduleService.upcomingDepartures(leg.serviceId, now, { lookaheadDays: 7 });
  if (!preferred) return next;
  // With a preferred time, bias toward the first departure >= preferred today,
  // but still fall through to next available once that has passed.
  const biased = ScheduleService.upcomingDepartures(leg.serviceId, now, { lookaheadDays: 7, afterTime: preferred });
  return biased.length ? biased : next;
}

// Transfer-aware departure selection for the active leg. Leg 1 is anchored on the
// device clock (+ the rider's preferred time). A CONNECTING leg is anchored on
// the SCHEDULED ARRIVAL of the train the rider boarded for the previous leg, so
// we only offer departures reachable within the minimum transfer buffer (never
// the device clock alone). Falls back to Build 2 behavior when the previous leg
// has no scheduled arrival (e.g. a MOCK or LIVE inbound leg).
//   returns { deps:[...], transfer: null | { prevArr, buffer, station, windowMin,
//             feasible, soonest, soonestWindowMin } }
function selectLegDepartures(c, i, now) {
  const leg = c.legs[i];
  // LIVE legs always read the real-time cache (Build 2 behavior preserved).
  if (ScheduleService.isLive(leg.serviceId)) {
    return { deps: legDepartures(leg, now), transfer: null, plan: null };
  }
  // Leg 1 is chosen by the commute's scheduling mode (arrive-by / fixed /
  // next-available) via commutePlan — NOT simply "next train after the clock".
  if (i === 0) {
    const plan = commutePlan(c, now);
    if (!plan.feasible) return { deps: [], transfer: null, plan };
    const deps = ScheduleService.upcomingDepartures(leg.serviceId, plan.board, { lookaheadDays: 8 });
    return { deps, transfer: null, plan };
  }
  const prev = legBoarded[i - 1];
  if (!prev || !prev.arr) {
    return { deps: legDepartures(leg, now), transfer: null, plan: null };
  }
  const buffer = MIN_TRANSFER_BUFFER_MIN;
  const feasible = ScheduleService.onwardDepartures(leg.serviceId, prev.arr, { minBufferMin: buffer });
  // Don't show a feasible train that has already left in real time; keep rolling.
  const upcoming = feasible.filter(d => d.when.getTime() >= now.getTime() - 15000);
  const deps = upcoming.length ? upcoming : feasible;
  const info = ScheduleService.describeService(leg.serviceId);
  const soonest = ScheduleService.upcomingDepartures(leg.serviceId, prev.arr, { lookaheadDays: 7 })[0] || null;
  const transfer = {
    prevArr: prev.arr,
    buffer,
    station: info ? info.originName : '',
    windowMin: deps[0] ? Math.round((deps[0].when - prev.arr) / 60000) : null,
    feasible: deps.length > 0,
    soonest,
    soonestWindowMin: soonest ? Math.round((soonest.when - prev.arr) / 60000) : null
  };
  return { deps, transfer, plan: null };
}

// ---- Safe migration of saved commutes onto SCHEDULED services ---------------

// Does this commute have at least one leg with a SCHEDULED equivalent it isn't
// already using? (i.e. is an opt-in migration available?)
function commuteHasScheduledEquivalent(commute) {
  return (commute.legs || []).some(l => ScheduleService.scheduledEquivalentOf(l.serviceId));
}

// Return a COPY of the commute with mappable legs repointed to their SCHEDULED
// equivalents. Preserves id, name, recurringDays, and each leg's preferredTime.
// Legs without a same-origin/same-destination scheduled equivalent are left as-is
// (never silently re-routed to a different destination). Pure: no persistence here.
function migrateCommuteToScheduled(commute) {
  const legs = (commute.legs || []).map(l => {
    const eq = ScheduleService.scheduledEquivalentOf(l.serviceId);
    return eq ? Object.assign({}, l, { serviceId: eq }) : Object.assign({}, l);
  });
  const changed = legs.some((l, i) => l.serviceId !== commute.legs[i].serviceId);
  return { commute: Object.assign({}, commute, { legs }), changed };
}

// ===========================================================================
//  ARRIVE-BY scheduling (Phase C). A recurring commute can be scheduled three
//  ways. Nothing here mutates stored commutes; effective settings are derived.
// ===========================================================================

const DEFAULT_ARRIVAL_BUFFER_MIN = 10;   // arrive this many minutes before the target
const DEFAULT_WALK_MIN = 0;              // 0 = no walking time entered (not "no walk needed")

// Effective scheduling mode. Stored mode wins; otherwise infer legacy behavior so
// existing saved commutes are preserved exactly (fixed if leg 1 has a set time,
// else next-available). Never persists anything.
function commuteMode(c) {
  if (c && (c.scheduleMode === 'arrive_by' || c.scheduleMode === 'fixed' || c.scheduleMode === 'next_available')) return c.scheduleMode;
  const l0 = c && c.legs && c.legs[0];
  if (l0 && l0.preferredTime && l0.preferredTime !== 'next') return 'fixed';
  return 'next_available';
}
function commuteArrivalBuffer(c) { return Number.isFinite(c && c.arrivalBuffer) ? c.arrivalBuffer : DEFAULT_ARRIVAL_BUFFER_MIN; }
function commuteWalkMinutes(c) { return Number.isFinite(c && c.walkMinutes) ? c.walkMinutes : DEFAULT_WALK_MIN; }

// All departures of a service on a given date as {when, arr, hhmm}. Scheduled
// services carry real arrivals; mock services are expanded from their departures[]
// (no arrival — arrive-by won't accept them).
function departuresOnDate(serviceId, date) {
  if (ScheduleService.isPlanned(serviceId)) {
    return ScheduleService.tripsOn(serviceId, date).map(t => ({ when: t.dep, arr: t.arr, hhmm: t.hhmm }));
  }
  const svc = ScheduleService.service(serviceId);
  if (!svc || !Array.isArray(svc.departures) || !ScheduleService.runsOn(serviceId, date)) return [];
  const mid = midnightOf(date);
  return svc.departures.map(hhmm => {
    const mm = toMinutes(hhmm);
    return { when: new Date(mid.getTime() + mm * 60000), arr: null, hhmm };
  });
}

// The specific leg-1 train at a fixed clock time on a date (>= now if today).
function fixedBoardOn(serviceId, date, prefMin, now) {
  let list = departuresOnDate(serviceId, date);
  if (prefMin != null) list = list.filter(x => toMinutes(x.hhmm) === prefMin);
  if (now) list = list.filter(x => x.when.getTime() >= now.getTime());
  list.sort((a, b) => a.when - b.when);
  return list[0] || null;
}

// Backward arrive-by planner for ONE service date. Works from the destination
// deadline (target − arrival buffer − walking time) back through every leg,
// enforcing the minimum transfer buffer, and prefers the LATEST feasible initial
// departure (so it never recommends an unrelated early-morning first train).
// Requires every leg to be SCHEDULED (we need real arrivals). Pure / no mutation.
function planArriveBy(commute, date, { arrivalBuffer = DEFAULT_ARRIVAL_BUFFER_MIN, walkMinutes = DEFAULT_WALK_MIN, minTransferBuffer = MIN_TRANSFER_BUFFER_MIN } = {}) {
  const goalMin = toMinutes(commute.arrivalGoal);
  if (goalMin == null) return { feasible: false, reason: 'no target arrival time set' };
  if (!commute.legs.length || !commute.legs.every(l => ScheduleService.isPlanned(l.serviceId))) {
    return { feasible: false, reason: 'arrive-by needs scheduled or demo data for every leg' };
  }
  const mid = midnightOf(date);
  const deadlineFinal = new Date(mid.getTime() + (goalMin - arrivalBuffer - walkMinutes) * 60000);
  const chosen = new Array(commute.legs.length).fill(null);
  let deadline = deadlineFinal;
  for (let i = commute.legs.length - 1; i >= 0; i--) {
    const sid = commute.legs[i].serviceId;
    // Candidates: trips on the service date, plus ONLY overnight carry-over trips
    // from the previous service date (those arriving after midnight on `date`) —
    // never an ordinary previous-day daytime train.
    const mid0 = midnightOf(date).getTime();
    const prevOvernight = ScheduleService.tripsOn(sid, addDays(date, -1))
      .filter(t => t.arr && t.arr.getTime() >= mid0);
    const cands = [...prevOvernight, ...ScheduleService.tripsOn(sid, date)]
      .filter(t => t.arr && t.arr.getTime() <= deadline.getTime());
    if (!cands.length) return { feasible: false, reason: 'no connection arrives in time', failedLeg: i };
    cands.sort((a, b) => b.dep - a.dep);      // latest feasible departure first
    const pick = cands[0];
    chosen[i] = pick;
    deadline = new Date(pick.dep.getTime() - minTransferBuffer * 60000);
  }
  return {
    feasible: true, date, legs: chosen, board: chosen[0].dep,
    finalArrive: chosen[chosen.length - 1].arr, targetMin: goalMin,
    arrivalBuffer, walkMinutes, deadlineFinal
  };
}

// Resolve the NEXT occurrence of a recurring commute: which service date to show
// and the recommended boarding time for leg 1, honoring the scheduling mode,
// recurring days, and service calendars. Looks up to 8 days ahead. Returns
//   { mode, feasible, date, isToday, board, finalArrive, targetMin, plan, buffer, walk, reason }
function commutePlan(commute, now) {
  const mode = commuteMode(commute);
  const buffer = commuteArrivalBuffer(commute);
  const walk = commuteWalkMinutes(commute);
  const base = { mode, buffer, walk };
  if (!commute.legs || !commute.legs.length) return Object.assign({ feasible: false, reason: 'no legs' }, base);
  const leg0 = commute.legs[0].serviceId;

  for (let d = 0; d <= 8; d++) {
    const date = addDays(now, d);
    const recurs = !Array.isArray(commute.recurringDays) || !commute.recurringDays.length || commute.recurringDays.includes(date.getDay());
    if (!recurs) continue;

    if (mode === 'arrive_by') {
      const plan = planArriveBy(commute, date, { arrivalBuffer: buffer, walkMinutes: walk });
      if (!plan.feasible) continue;
      if (d === 0 && plan.board.getTime() < now.getTime()) continue; // today's last feasible train already left
      return Object.assign({ feasible: true, date, isToday: d === 0, board: plan.board, finalArrive: plan.finalArrive, targetMin: plan.targetMin, plan }, base);
    }
    if (mode === 'fixed') {
      const pref = commute.legs[0].preferredTime;
      const prefMin = (pref && pref !== 'next') ? toMinutes(pref) : null;
      const b = fixedBoardOn(leg0, date, prefMin, d === 0 ? now : null);
      if (!b) continue;
      return Object.assign({ feasible: true, date, isToday: d === 0, board: b.when, finalArrive: null, plan: null }, base);
    }
    // next_available
    const deps = ScheduleService.isLive(leg0)
      ? legDepartures(commute.legs[0], now)
      : ScheduleService.upcomingDepartures(leg0, d === 0 ? now : midnightOf(date));
    if (!deps.length) continue;
    return Object.assign({ feasible: true, date, isToday: true, board: deps[0].when, finalArrive: null, plan: null }, base);
  }
  return Object.assign({
    feasible: false,
    reason: mode === 'arrive_by'
      ? `No journey arrives by ${esc(commute.arrivalGoal || 'your target')} within the next week of service.`
      : 'No upcoming departure found in the next week of service.'
  }, base);
}

// ===========================================================================
//  Journey map + full breakdown (Phase: Monday flagship). Everything here is a
//  SCHEMATIC derived from published static station coordinates — NOT GPS, NOT a
//  live train position. No external map tiles / dependencies.
// ===========================================================================

// Public static station coordinates (from the official PATH + NJ TRANSIT GTFS
// stops). Used only to lay out the schematic; not a redistribution of timetables.
const STATION_GEO = {
  hblr_port_imperial: { lat: 40.7759, lon: -74.0129 },
  hblr_hoboken: { lat: 40.7341, lon: -74.0292 },
  path_hoboken: { lat: 40.7359, lon: -74.0292 },
  path_9th: { lat: 40.7342, lon: -73.9991 },
  path_33rd: { lat: 40.7491, lon: -73.9883 },
  path_newport: { lat: 40.7270, lon: -74.0338 }
};
// Approx coordinates for named final destinations reached on foot (for the map).
const DEST_GEO = { NYU: { lat: 40.7295, lon: -73.9965 } };

// Short label for the map (drops "Terminal"/"Light Rail Station" noise).
function shortStationLabel(name) {
  return String(name).replace(/ Terminal.*/i, '').replace(/ HBLR Station/i, '').replace(/ Light Rail Station/i, '').replace(/ Street$/i, ' St');
}

// Ordered journey nodes: first leg's origin, each leg's destination (transfer
// station appears once), and — when the commute has a named walk destination —
// a trailing WALK node (dashed segment). Each node carries a kind: 'rail'|'walk'.
function journeyNodes(c) {
  const nodes = [];
  const add = (sid, kind) => {
    const st = ScheduleService.station(sid);
    const geo = STATION_GEO[sid] || null;
    nodes.push({ id: sid, name: st ? st.name : sid, lat: geo ? geo.lat : null, lon: geo ? geo.lon : null, kind: kind || 'rail' });
  };
  const s0 = ScheduleService.service(c.legs[0].serviceId);
  if (s0) add(s0.origin, 'rail');
  for (const l of c.legs) { const s = ScheduleService.service(l.serviceId); if (s) add(s.destination, 'rail'); }
  if (c.destinationLabel) {
    const geo = DEST_GEO[c.destinationLabel] || null;
    const last = nodes[nodes.length - 1];
    nodes.push({ id: '__dest', name: c.destinationLabel, lat: geo ? geo.lat : (last ? last.lat : null), lon: geo ? geo.lon : (last ? last.lon : null), kind: 'walk' });
  }
  return nodes;
}

function legColorOf(serviceId) {
  const info = ScheduleService.describeService(serviceId);
  return info ? info.operatorColor : '#8b5cf6';
}

// Compact inline-SVG schematic. Active leg highlighted (violet), completed legs
// shown teal with a check; upcoming legs use the operator color, dimmed.
function journeyMapSvg(c, activeIdx, boarded) {
  const nodes = journeyNodes(c);
  if (nodes.length < 2) return '';
  const n = nodes.length;
  const W = 320, H = 96, padX = 26, topPad = 22, railY = 40;
  // Sequence left-to-right with EVEN spacing (guarantees order + no label overlap);
  // nudge y by latitude so it still reads geographically (north a bit higher).
  const lats = nodes.map(nd => (nd.lat != null ? nd.lat : null)).filter(v => v != null);
  const minLat = lats.length ? Math.min(...lats) : 0, maxLat = lats.length ? Math.max(...lats) : 1;
  const spanLat = (maxLat - minLat) || 1e-6;
  const xy = nodes.map((nd, i) => {
    const x = padX + (n === 1 ? 0 : i / (n - 1) * (W - 2 * padX));
    const yJitter = nd.lat != null ? (1 - (nd.lat - minLat) / spanLat) * 14 - 7 : 0; // +/-7px by latitude
    return { x, y: railY + yJitter };
  });

  // Segment i connects node i -> node i+1. Rail legs map to c.legs[i]; the final
  // WALK segment (to the destination node) is always dashed + neutral violet.
  let lines = '';
  for (let i = 0; i < n - 1; i++) {
    const a = xy[i], b = xy[i + 1];
    const isWalk = nodes[i + 1].kind === 'walk';
    const completed = i < activeIdx;
    const active = i === activeIdx && !isWalk;
    let color, dash = '', w = 4, op = '1';
    if (isWalk) { color = '#8b5cf6'; dash = ' stroke-dasharray="2 5" stroke-linecap="round"'; w = 3; op = activeIdx >= c.legs.length ? '1' : '0.55'; }
    else if (completed) { color = '#14b8a6'; }
    else { color = legColorOf(c.legs[i].serviceId); if (active) { w = 6; } else { op = '0.4'; } }
    lines += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${color}" stroke-width="${w}" opacity="${op}" stroke-linecap="round"${dash} />`;
    if (active) lines += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#7c3aed" stroke-width="1.5" opacity="0.5" />`;
  }

  let dots = '';
  nodes.forEach((nd, i) => {
    const p = xy[i];
    const walk = nd.kind === 'walk';
    const done = i < activeIdx || (walk && activeIdx >= c.legs.length);
    const current = i === activeIdx && !walk;
    const fill = done ? '#14b8a6' : current ? '#7c3aed' : (walk ? '#ede9fe' : '#ffffff');
    const stroke = done ? '#14b8a6' : current ? '#7c3aed' : (walk ? '#8b5cf6' : '#c9bda4');
    const r = current ? 6.5 : 5;
    dots += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="2" />`;
    if (done) dots += `<path d="M${(p.x - 2.4).toFixed(1)} ${p.y.toFixed(1)} l1.7 1.8 l3 -3.4" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />`;
    // Labels alternate above/below to avoid collisions on narrow screens.
    const below = i % 2 === 0;
    const ly = below ? H - 8 : 12;
    const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    const lx = i === 0 ? p.x - 3 : (i === n - 1 ? p.x + 3 : p.x);
    dots += `<text x="${lx.toFixed(1)}" y="${ly}" text-anchor="${anchor}" font-size="9.5" font-weight="700" fill="${walk ? '#7c3aed' : '#4b4556'}">${walk ? 'Walk · ' : ''}${esc(shortStationLabel(nd.name))}</text>`;
  });

  return `
    <div class="cd-map">
      <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Schematic journey map, in sequence; active leg highlighted; final walk dashed">${lines}${dots}</svg>
      <div class="cd-map-cap">Schematic journey map — sequence only, not live train position or GPS</div>
    </div>`;
}

// Full journey breakdown from an arrive-by plan. Separates official SCHEDULED
// transit times from the user-entered walking assumption.
function journeyBreakdown(c, planLike, walkMin) {
  // Accept either a raw planArriveBy result (has .legs) or a commutePlan wrapper
  // (legs live under .plan).
  const plan = (planLike && Array.isArray(planLike.legs)) ? planLike
    : (planLike && planLike.plan && Array.isArray(planLike.plan.legs)) ? planLike.plan : null;
  if (!plan || !plan.feasible || !Array.isArray(plan.legs)) return null;
  const legs = plan.legs.map((t, i) => {
    const info = ScheduleService.describeService(c.legs[i].serviceId);
    return {
      operator: info ? info.operatorName : '', short: info ? info.operatorShort : '',
      color: info ? info.operatorColor : '#8b5cf6',
      origin: info ? info.originName : '', dest: info ? info.destinationName : '',
      dep: t.dep, arr: t.arr, rideMin: Math.round((t.arr - t.dep) / 60000)
    };
  });
  const transfers = [];
  for (let i = 0; i < plan.legs.length - 1; i++) {
    transfers.push({
      station: legs[i].dest,
      waitMin: Math.round((plan.legs[i + 1].dep - plan.legs[i].arr) / 60000),
      bufferMin: MIN_TRANSFER_BUFFER_MIN
    });
  }
  const departure = plan.legs[0].dep;
  const reachStation = plan.legs[plan.legs.length - 1].arr;
  const walk = walkMin || 0;
  const destArrive = new Date(reachStation.getTime() + walk * 60000);
  const targetDate = new Date(midnightOf(plan.date).getTime() + plan.targetMin * 60000);
  return {
    legs, transfers, departure, reachStation, walk, destArrive,
    totalMin: Math.round((destArrive - departure) / 60000),
    transitMin: Math.round((reachStation - departure) / 60000),
    targetDate, arriveEarlyMin: Math.round((targetDate - destArrive) / 60000)
  };
}

// HTML for the full-journey detail panel (Monday flagship). `destName` is the
// user's final destination label (e.g. "NYU").
function journeyPanelHtml(bd, destName, basis) {
  const basisLabel = basis === 'demo' ? 'DEMO (simulated)' : 'SCHEDULED transit';
  const t = bd.transfers[0];
  const rows = [];
  bd.legs.forEach((lg, i) => {
    rows.push(`<div class="jp-row"><span class="jp-dot" style="--op:${lg.color}"></span><span class="jp-leg">${esc(lg.short)}</span><span class="jp-time">${fmtClock(lg.dep)} <span class="jp-arrow">\u2192</span> ${fmtClock(lg.arr)}</span><span class="jp-ride">${lg.rideMin} min</span></div>`);
    if (bd.transfers[i]) {
      const tr = bd.transfers[i];
      const tight = tr.waitMin < RECOMMENDED_COMFORT_MIN;
      rows.push(`<div class="jp-row jp-xfer"><span class="jp-dot xfer"></span><span class="jp-leg">Transfer · ${esc(tr.station)}${tight ? ' <span class="tight">tight</span>' : ''}</span><span class="jp-time">wait ${tr.waitMin} min</span><span class="jp-ride">min ${tr.bufferMin}</span></div>`);
    }
  });
  const dest = destName || 'destination';
  return `
    <div class="journey-panel">
      <div class="jp-head">Full journey — <span class="jp-sched">${basisLabel}</span></div>
      ${rows.join('')}
      <div class="jp-row jp-walk"><span class="jp-dot walk"></span><span class="jp-leg">Walk to ${esc(dest)}</span><span class="jp-time">${bd.walk > 0 ? bd.walk + ' min' : 'none entered'}</span><span class="jp-ride">your estimate</span></div>
      <div class="jp-sep"></div>
      <div class="jp-row jp-sum"><span class="jp-leg">Depart ${esc(bd.legs[0].origin)}</span><span class="jp-time strong">${fmtClock(bd.departure)}</span></div>
      <div class="jp-row jp-sum"><span class="jp-leg">Reach ${esc(bd.legs[bd.legs.length - 1].dest)} (station)</span><span class="jp-time">${fmtClock(bd.reachStation)}</span></div>
      <div class="jp-row jp-sum"><span class="jp-leg">Arrive ${esc(dest)} (with walk)</span><span class="jp-time strong">${fmtClock(bd.destArrive)}</span></div>
      <div class="jp-row jp-sum"><span class="jp-leg">Class starts</span><span class="jp-time">${fmtClock(bd.targetDate)} · <span class="jp-early">${bd.arriveEarlyMin >= 0 ? bd.arriveEarlyMin + ' min early' : Math.abs(bd.arriveEarlyMin) + ' min LATE'}</span></span></div>
    </div>`;
}

// Data-source status for a leg: 'LIVE' | 'SCHEDULED' | 'MOCK' | 'UNAVAILABLE' | 'LOADING'.
function legStatus(leg, now = new Date()) {
  if (ScheduleService.isLive(leg.serviceId)) {
    const st = ScheduleService.liveState(leg.serviceId);
    if (st.status === 'live') return 'LIVE';
    if (st.status === 'loading') return 'LOADING';
    return 'UNAVAILABLE';
  }
  if (ScheduleService.isScheduled(leg.serviceId)) {
    return ScheduleService.scheduledState(leg.serviceId, now).status === 'scheduled' ? 'SCHEDULED' : 'UNAVAILABLE';
  }
  if (ScheduleService.isDemo(leg.serviceId)) {
    return ScheduleService.scheduledState(leg.serviceId, now).status === 'scheduled' ? 'DEMO' : 'UNAVAILABLE';
  }
  return 'MOCK';
}

// Trigger a live refresh for the active leg if it is live and the cache is
// missing or older than ~25s. Re-renders when fresh data arrives. Debounced.
let _liveRefreshing = {};
function maybeRefreshLive(leg, onDone) {
  if (!leg || !ScheduleService.isLive(leg.serviceId)) return;
  const sid = leg.serviceId;
  const st = ScheduleService.liveState(leg.serviceId);
  const fresh = st.fetchedAt && (Date.now() - st.fetchedAt) < 25000 && st.status === 'live';
  if (fresh || _liveRefreshing[sid]) return;
  _liveRefreshing[sid] = true;
  ScheduleService.refreshLive(sid).finally(() => {
    _liveRefreshing[sid] = false;
    if (typeof onDone === 'function') onDone();
  });
}

// Fire a PostHog event the first time a live-powered countdown renders for a
// given commute+leg (guarded so it doesn't fire on every 1-second tick).
const _capturedLiveViews = new Set();
function capturedLiveView(commuteId, serviceId) {
  const key = commuteId + '|' + serviceId;
  if (_capturedLiveViews.has(key)) return;
  _capturedLiveViews.add(key);
  try {
    if (typeof window !== 'undefined' && window.posthog) {
      window.posthog.capture('viewed_live_countdown', { commute_id: commuteId, service_id: serviceId, source: 'mta_gtfs_realtime' });
    }
  } catch (e) { /* analytics must never break the app */ }
}

// Route label "Origin → Destination" for a commute (uses walk destination if set).
function commuteRouteLabel(c) {
  if (!c.legs || !c.legs.length) return '';
  const first = ScheduleService.describeService(c.legs[0].serviceId);
  const lastSvc = ScheduleService.describeService(c.legs[c.legs.length - 1].serviceId);
  const end = c.destinationLabel || (lastSvc ? lastSvc.destinationName : '');
  return first ? `${esc(first.originName)} \u2192 ${esc(end)}` : '';
}

function modeLabel(c) {
  const m = commuteMode(c);
  if (m === 'arrive_by') return `Arrive by ${esc(c.arrivalGoal || '')}`;
  if (m === 'fixed') return 'Fixed departure';
  return 'Next available';
}

// The dashboard is now a compact top bar: one featured journey + menus. The
// featured journey itself is shown by the countdown below.
function renderDashboard() {
  const box = el('dashboard');
  const userCommutes = commutes.filter(c => !isDemoCommute(c));
  
  // Welcome screen for first-time visitors
  if (userCommutes.length === 0) {
    box.innerHTML = `
      <div class="welcome">
        <h1>LinkWise</h1>
        <p class="welcome-lead">Plan your commute and catch your next connection.</p>
        <div class="welcome-actions">
          <button class="btn btn-primary" id="welcomeCreateBtn">Create my commute</button>
          <button class="btn btn-ghost" id="welcomeExploreBtn">Try a live example</button>
        </div>
        <p class="welcome-note">
          <strong>📱 Saved on this device only.</strong>
        </p>
      </div>`;
    el('welcomeCreateBtn').addEventListener('click', openOnboarding);
    el('welcomeExploreBtn').addEventListener('click', function() {
      // "Try a live example" directly opens the MTA LIVE demo
      activateCommute('live_api_demo');
    });
    
    // Show storage warning if unavailable
    if (!checkStorageAvailable()) {
      const warn = document.createElement('div');
      warn.className = 'storage-warning';
      warn.innerHTML = '⚠️ <strong>Private browsing detected.</strong> Your commutes won\'t be saved. Use a standard browser window to keep your schedules.';
      box.insertBefore(warn, box.firstChild);
    }
    return;
  }
  
  // Returning user: show dashboard
  const c = activeCommute();
  const featuredName = c ? esc(c.name) : 'No journey selected';
  box.innerHTML = `
    <div class="top-bar">
      <button class="pill-btn" id="commutesBtn" aria-haspopup="true">
        <span class="pill-ic">☰</span><span class="pill-tx">My Commutes</span>
      </button>
      <button class="pill-btn ghost" id="exploreBtn">Explore</button>
    </div>
    <div class="featured-label">Featured journey · <strong>${featuredName}</strong></div>`;
  el('commutesBtn').addEventListener('click', openCommutesDrawer);
  el('exploreBtn').addEventListener('click', openExploreDrawer);
}

// ---- My Commutes / Explore drawers -----------------------------------------

function openDrawer() { el('drawer').classList.add('open'); }
function closeDrawer() { el('drawer').classList.remove('open'); }

function activateCommute(id) {
  activeCommuteId = id;
  activeLegIndex = 0;
  legBoarded = [];
  closeDrawer();
  renderAll();
}

function openCommutesDrawer() {
  el('drawerTitle').textContent = 'My Commutes';
  renderCommutesDrawer();
  openDrawer();
}

function renderCommutesDrawer() {
  const body = el('drawerBody');
  const list = commutes.filter(c => !isDemoCommute(c));
  const rows = list.map(c => {
    const active = c.id === activeCommuteId;
    const days = (c.recurringDays || []).map(d => DAY_LABELS[d]).join(' ') || 'No days';
    return `
      <div class="cmx ${active ? 'on' : ''}" data-id="${esc(c.id)}">
        <div class="cmx-main" data-view="${esc(c.id)}">
          <div class="cmx-name">${esc(c.name)}${active ? ' <span class="cmx-badge">Featured</span>' : ''}</div>
          <div class="cmx-route">${commuteRouteLabel(c)}</div>
          <div class="cmx-meta">${esc(modeLabel(c))} · ${days}</div>
        </div>
        <div class="cmx-actions">
          <button class="link-btn" data-edit="${esc(c.id)}">Edit</button>
          <button class="link-btn danger" data-del="${esc(c.id)}">Delete</button>
        </div>
        <div class="cmx-confirm" data-confirm="${esc(c.id)}" hidden>
          Delete “${esc(c.name)}”? <button class="link-btn danger" data-delyes="${esc(c.id)}">Yes, delete</button>
          <button class="link-btn" data-delno="${esc(c.id)}">Cancel</button>
        </div>
      </div>`;
  }).join('');
  body.innerHTML = `
    ${rows || '<p class="hint">No saved journeys yet.</p>'}
    <button class="btn" id="drawerAddBtn">+ New commute</button>`;

  body.querySelectorAll('[data-view]').forEach(elm => elm.addEventListener('click', () => activateCommute(elm.getAttribute('data-view'))));
  body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const cc = commutes.find(x => x.id === b.getAttribute('data-edit'));
    if (cc) { closeDrawer(); openEditCommute(cc); }
  }));
  body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const row = body.querySelector(`[data-confirm="${b.getAttribute('data-del')}"]`);
    if (row) row.hidden = false;
  }));
  body.querySelectorAll('[data-delno]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const row = body.querySelector(`[data-confirm="${b.getAttribute('data-delno')}"]`);
    if (row) row.hidden = true;
  }));
  body.querySelectorAll('[data-delyes]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteCommute(b.getAttribute('data-delyes'));
  }));
  el('drawerAddBtn').addEventListener('click', () => { closeDrawer(); openOnboarding(); });
}

// Remove a saved commute. Non-destructive to other data; the seeded-once guard
// means a deleted sample is NOT re-added on reload.
function deleteCommute(id) {
  commutes = commutes.filter(c => c.id !== id);
  saveCommutes();
  if (activeCommuteId === id) { activeCommuteId = suggestCommuteId(new Date()); activeLegIndex = 0; legBoarded = []; }
  renderCommutesDrawer();
  renderAll();
}

function openExploreDrawer() {
  el('drawerTitle').textContent = 'Explore · Demos';
  const demos = commutes.filter(isDemoCommute);
  const rows = demos.map(c => `
      <div class="cmx" data-id="${esc(c.id)}">
        <div class="cmx-main" data-view="${esc(c.id)}">
          <div class="cmx-name">${esc(c.name)} <span class="cmx-badge live">LIVE</span></div>
          <div class="cmx-route">${commuteRouteLabel(c)}</div>
          <div class="cmx-meta">Real MTA GTFS-Realtime feed · technical demo</div>
        </div>
      </div>`).join('');
  el('drawerBody').innerHTML = `
    <p class="hint">A real-data proof of concept powered by the official MTA GTFS-Realtime feed (public, no key). Clearly labeled LIVE; not part of your commutes.</p>
    ${rows || '<p class="hint">No demos available.</p>'}`;
  el('drawerBody').querySelectorAll('[data-view]').forEach(elm => elm.addEventListener('click', () => activateCommute(elm.getAttribute('data-view'))));
  openDrawer();
}

function renderCountdown() {
  const box = el('countdown');
  const c = activeCommute();
  const userCommutes = commutes.filter(c => !isDemoCommute(c));
  
  // Welcome screen countdown area (matches dashboard)
  if (userCommutes.length === 0) {
    box.innerHTML = `<div class="cd-empty"><p class="hint">Create a commute to see the countdown</p></div>`;
    return;
  }
  
  if (!c || !c.legs.length) {
    box.innerHTML = `<div class="cd-empty"><p class="hint">Select a commute to start</p></div>`;
    return;
  }
  if (activeLegIndex >= c.legs.length) activeLegIndex = c.legs.length - 1;

  const leg = c.legs[activeLegIndex];
  const info = ScheduleService.describeService(leg.serviceId);
  const now = new Date();
  const status = legStatus(leg);
  const isLive = ScheduleService.isLive(leg.serviceId);
  const isScheduled = ScheduleService.isScheduled(leg.serviceId);
  const isDemo = ScheduleService.isDemo(leg.serviceId);
  // Offer an opt-in migration when a published-schedule equivalent exists for
  // this commute and it isn't already on scheduled data.
  const migratable = commuteHasScheduledEquivalent(c);

  // Keep the live cache warm; re-render when fresh data lands.
  if (isLive) maybeRefreshLive(leg, renderCountdown);

  const legHdr = `Leg ${activeLegIndex + 1} of ${c.legs.length} · ${esc(c.name)}`;

  // LIVE leg still loading its first response.
  if (status === 'LOADING') {
    box.innerHTML = `
      <div class="cd-card state-none">
        <div class="cd-leg">${legHdr}</div>
        <div class="cd-op" style="--op:${info ? info.operatorColor : '#8b5cf6'}"><span class="cd-op-dot"></span>${info ? esc(info.operatorName) : ''}</div>
        <div class="cd-status loading">FETCHING LIVE DATA…</div>
        <p class="hint">Contacting the official MTA GTFS-Realtime feed for ${info ? esc(info.originName) : 'this station'}…</p>
      </div>`;
    return;
  }

  // A leg that could not be used reliably — honest UNAVAILABLE state. Applies to
  // both a failing LIVE feed and an expired/missing SCHEDULED timetable.
  if (status === 'UNAVAILABLE') {
    const reason = isLive
      ? (ScheduleService.liveState(leg.serviceId).reason || 'live data unavailable')
      : (ScheduleService.scheduledState(leg.serviceId).reason || 'schedule data unavailable');
    const footnote = isLive
      ? 'The live MTA feed couldn’t be used right now. No departure is shown rather than guessing.'
      : 'The published timetable couldn’t be used (e.g. expired or not loaded). No departure is shown rather than guessing.';
    box.innerHTML = `
      <div class="cd-card state-none">
        <div class="cd-leg">${legHdr}</div>
        <div class="cd-op" style="--op:${info ? info.operatorColor : '#8b5cf6'}"><span class="cd-op-dot"></span>${info ? esc(info.operatorName) : ''}</div>
        <div class="cd-status unavailable">UNAVAILABLE</div>
        <div class="cd-details" style="margin-top:14px">
          <div class="cd-row"><span class="cd-k">Station</span><span class="cd-v">${info ? esc(info.originName) : '—'}</span></div>
          ${info && info.line ? `<div class="cd-row"><span class="cd-k">Line</span><span class="cd-v">${esc(info.line)}${isLive ? ' train' : ''}</span></div>` : ''}
          <div class="cd-row"><span class="cd-k">Reason</span><span class="cd-v">${esc(reason)}</span></div>
        </div>
        ${isLive ? '<div class="cd-actions"><button class="btn btn-ghost" id="retryLiveBtn">Retry live feed</button></div>' : ''}
        <p class="cd-note">${footnote}</p>
      </div>`;
    const r = document.getElementById('retryLiveBtn');
    if (r) r.addEventListener('click', () => { delete ScheduleService._liveCache[leg.serviceId]; renderCountdown(); });
    return;
  }

  const sel = selectLegDepartures(c, activeLegIndex, now);
  const deps = sel.deps;
  const transfer = sel.transfer;
  const plan = sel.plan;

  // Arrive-by (or any leg-1 mode) with no feasible journey -> honest explanation,
  // never an invented or unrelated early-morning recommendation.
  if (activeLegIndex === 0 && plan && !plan.feasible) {
    box.innerHTML = `
      <div class="cd-card state-none">
        <div class="cd-leg">${legHdr}</div>
        <div class="cd-op" style="--op:${info ? info.operatorColor : '#8b5cf6'}"><span class="cd-op-dot"></span>${info ? esc(info.operatorName) : ''}</div>
        <div class="cd-status unavailable">UNAVAILABLE</div>
        <div class="cd-details" style="margin-top:14px">
          ${c.arrivalGoal && plan.mode === 'arrive_by' ? `<div class="cd-row"><span class="cd-k">Target arrival</span><span class="cd-v">${esc(c.arrivalGoal)}</span></div>` : ''}
          <div class="cd-row"><span class="cd-k">Reason</span><span class="cd-v">${esc(plan.reason || 'no feasible journey')}</span></div>
        </div>
        <p class="cd-note">No recommendation is shown rather than suggesting a train that doesn’t meet your arrival goal.</p>
      </div>`;
    return;
  }

  // Honest UNAVAILABLE when a CONNECTING leg has no departure that clears the
  // minimum transfer buffer (e.g. the last feasible train has gone / service ended).
  if (transfer && !deps.length) {
    const soon = transfer.soonest;
    box.innerHTML = `
      <div class="cd-card state-none">
        <div class="cd-leg">${legHdr}</div>
        <div class="cd-op" style="--op:${info ? info.operatorColor : '#8b5cf6'}"><span class="cd-op-dot"></span>${info ? esc(info.operatorName) : ''}</div>
        <div class="cd-status unavailable">UNAVAILABLE</div>
        <div class="cd-details" style="margin-top:14px">
          <div class="cd-row"><span class="cd-k">Transfer at</span><span class="cd-v">${info ? esc(info.originName) : '—'}</span></div>
          <div class="cd-row"><span class="cd-k">You arrive</span><span class="cd-v">${fmtClock(transfer.prevArr)}</span></div>
          <div class="cd-row"><span class="cd-k">Reason</span><span class="cd-v">No onward departure is at least ${transfer.buffer} min after you arrive.</span></div>
          ${soon ? `<div class="cd-row"><span class="cd-k">Soonest</span><span class="cd-v">${fmtClock(soon.when)} — only ${transfer.soonestWindowMin} min after arrival</span></div>` : ''}
        </div>
        <div class="cd-actions">${activeLegIndex > 0 ? '<button class="btn btn-ghost" id="prevLegBtn">\u2190 Previous leg</button>' : ''}</div>
        <p class="cd-note">No connection is shown rather than suggesting one you can’t make. Minimum transfer buffer: ${transfer.buffer} min.</p>
      </div>`;
    const pv = document.getElementById('prevLegBtn');
    if (pv) pv.addEventListener('click', () => { activeLegIndex -= 1; legBoarded.length = activeLegIndex; renderCountdown(); });
    return;
  }

  if (!info || !deps.length) {
    box.innerHTML = `
      <div class="cd-card state-none">
        <div class="cd-leg">Leg ${activeLegIndex + 1} of ${c.legs.length}</div>
        <div class="cd-route">${info ? esc(info.originName) : 'Unknown service'}</div>
        <p class="hint">No upcoming departures found for this leg in the next few days.</p>
      </div>`;
    return;
  }

  // Fire a PostHog event the first time a live-powered countdown is shown.
  if (status === 'LIVE') capturedLiveView(c.id, leg.serviceId);

  const primary = deps[0];
  const following = deps[1] || null;
  const msAway = primary.when - now;
  const minsAway = msAway / 60000;

  // Urgency states (safety-conscious wording — never "run").
  let state, headline;
  if (minsAway <= 1) { state = 'go'; headline = 'Go now'; }
  else if (minsAway <= 4) { state = 'soon'; headline = 'Leaving soon'; }
  else { state = 'comfy'; headline = 'Comfortable'; }

  const legPills = c.legs.map((lg, i) => {
    const li = ScheduleService.describeService(lg.serviceId);
    return `<span class="leg-pill ${i === activeLegIndex ? 'on' : ''}">${i + 1}. ${li ? esc(li.operatorShort) : '?'}</span>`;
  }).join('');

  // Journey framing (leg 1): a "Next commute" line + a prominent at-a-glance
  // arrive-by summary + the full timeline. Summary = glance; panel = detail
  // (collapsed). Nothing is duplicated across the two.
  const destLabel = c.destinationLabel || (ScheduleService.describeService(c.legs[c.legs.length - 1].serviceId) || {}).destinationName || 'destination';
  const mapHtml = c.legs.length >= 2 ? journeyMapSvg(c, activeLegIndex, legBoarded) : '';
  let nextCommuteLine = '', summaryHtml = '', journeyPanel = '';
  if (activeLegIndex === 0 && plan && plan.feasible) {
    if (!plan.isToday) {
      nextCommuteLine = `<div class="cd-next">Next commute: <strong>${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][plan.date.getDay()]} at ${fmtClock(plan.board)}</strong></div>`;
    }
    if (plan.mode === 'arrive_by') {
      const bd = journeyBreakdown(c, plan, plan.walk);
      if (bd) {
        const early = bd.arriveEarlyMin >= 0 ? `${bd.arriveEarlyMin} min early` : `${Math.abs(bd.arriveEarlyMin)} min late`;
        summaryHtml = `
          <div class="jsum">
            <div class="jsum-i"><div class="jsum-k">Depart</div><div class="jsum-v">${fmtClock(bd.departure)}</div></div>
            <div class="jsum-i jsum-hero"><div class="jsum-k">Total → ${esc(destLabel)}</div><div class="jsum-v">${bd.totalMin}<span class="jsum-u">min</span></div></div>
            <div class="jsum-i"><div class="jsum-k">Arrive ${esc(destLabel)}</div><div class="jsum-v">${fmtClock(bd.destArrive)}</div></div>
            <div class="jsum-i"><div class="jsum-k">Class ${fmtClock(bd.targetDate)}</div><div class="jsum-v jsum-early">${early}</div></div>
          </div>`;
        journeyPanel = journeyPanelHtml(bd, destLabel, isDemo ? 'demo' : 'scheduled');
      }
    }
  }

  // Single source badge + concise footnote (shown once; no repeated SCHEDULED chips).
  let statusPill, note, freshness = '';
  if (isLive) {
    statusPill = '<span class="cd-status live">\u25cf LIVE</span>';
    const ts = ScheduleService.liveState(leg.serviceId).feedTs;
    if (ts) freshness = `<div class="cd-fresh">MTA feed updated ${Math.max(0, Math.round(Date.now() / 1000 - ts))}s ago</div>`;
    note = 'LIVE data from the official MTA GTFS-Realtime feed (public, no API key). Not affiliated with the MTA.';
  } else if (isScheduled) {
    const meta = ScheduleService.scheduledMeta(leg.serviceId) || {};
    statusPill = '<span class="cd-status scheduled">SCHEDULED</span>';
    note = 'SCHEDULED published timetable' + (meta.source ? ' (' + esc(meta.source) + ')' : '') +
      ' — a scheduled departure time, not live vehicle tracking.';
  } else if (isDemo) {
    statusPill = '<span class="cd-status demo">DEMO</span>';
    note = 'Simulated data for demonstration — not real PATH / NJ TRANSIT schedules or live data.';
  } else {
    statusPill = '<span class="cd-status mock">MOCK</span>';
    note = 'Illustrative MOCK departure data — not live or verified schedule information.';
  }

  // Current leg's departure + (scheduled) arrival, and collapsible detail rows.
  const curArr = primary.arr ? ` <span class="cd-arr">\u2192 arrives ${fmtClock(primary.arr)}</span>` : '';
  const tight = transfer && transfer.windowMin != null && transfer.windowMin < RECOMMENDED_COMFORT_MIN;
  const transferRow = transfer
    ? `<div class="cd-row cd-row-transfer"><span class="cd-k">Transfer · ${info ? esc(info.originName) : ''}</span><span class="cd-v">arrive ${fmtClock(transfer.prevArr)} · ${transfer.windowMin} min to board <span class="cd-buf">(min ${transfer.buffer})</span>${tight ? ' <span class="tight">Tight</span>' : ''}</span></div>`
    : '';
  const nextDepRow = following ? `<div class="cd-row"><span class="cd-k">Next departure on this line</span><span class="cd-v">${fmtClock(following.when)}</span></div>` : '';

  box.innerHTML = `
    <div class="cd-card state-${state}">
      <div class="cd-leg">Leg ${activeLegIndex + 1} of ${c.legs.length} · ${esc(c.name)} ${statusPill}</div>
      <div class="cd-op" style="--op:${info.operatorColor}">
        <span class="cd-op-dot"></span>${esc(info.operatorName)}${info.line ? ' · ' + esc(info.line) : ''}
      </div>
      ${nextCommuteLine}
      ${summaryHtml}
      <div class="cd-headline">${headline}</div>
      <div class="cd-timer${fmtCountdown(msAway).length >= 7 ? ' long' : ''}" id="cdTimer" aria-live="polite">${fmtCountdown(msAway)}</div>
      <div class="cd-sub">boards <strong>${fmtClock(primary.when)}</strong>${curArr}</div>
      ${freshness}
      ${mapHtml}

      <details class="cd-more">
        <summary>Trip timeline &amp; details</summary>
        ${journeyPanel}
        <div class="cd-details">
          <div class="cd-row"><span class="cd-k">Board at</span><span class="cd-v">${esc(info.originName)}</span></div>
          <div class="cd-row"><span class="cd-k">Toward</span><span class="cd-v">${esc(info.destinationName)}</span></div>
          <div class="cd-row"><span class="cd-k">Direction</span><span class="cd-v">${esc(info.direction)}</span></div>
          ${transferRow}
          ${nextDepRow}
        </div>
        <p class="cd-note">${note}</p>
      </details>

      <div class="cd-legs">${legPills}</div>

      <div class="cd-actions">
        <button class="btn" id="onTrainBtn">${activeLegIndex < c.legs.length - 1 ? "I'm on this train \u2192 Next leg" : "I'm on this train \u2713"}</button>
        ${activeLegIndex > 0 ? '<button class="btn btn-ghost" id="prevLegBtn">\u2190 Previous leg</button>' : ''}
      </div>
      <div class="cd-foot">
        ${migratable ? '<button class="link-btn" id="migrateBtn">Use real schedule</button>' : ''}
        <button class="link-btn" id="editCommuteBtn">Edit journey</button>
      </div>
    </div>`;

  el('onTrainBtn').addEventListener('click', () => {
    // Record the train the rider is boarding for THIS leg so the next leg can be
    // chosen from its scheduled arrival (transfer-aware), not the device clock.
    legBoarded[activeLegIndex] = { when: primary.when, arr: primary.arr || null };
    if (activeLegIndex < c.legs.length - 1) {
      activeLegIndex += 1;
      renderCountdown();
    } else {
      activeLegIndex = 0;              // commute complete — reset to first leg
      legBoarded = [];
      renderCountdown();
    }
  });
  const prev = document.getElementById('prevLegBtn');
  if (prev) prev.addEventListener('click', () => { activeLegIndex -= 1; legBoarded.length = activeLegIndex; renderCountdown(); });
  const mg = document.getElementById('migrateBtn');
  if (mg) mg.addEventListener('click', () => {
    const idx = commutes.findIndex(x => x.id === c.id);
    if (idx < 0) return;
    const r = migrateCommuteToScheduled(commutes[idx]);
    commutes[idx] = r.commute;          // preserves id, name, days, preferred times
    saveCommutes();
    legBoarded = [];
    activeLegIndex = 0;
    renderAll();
  });
  const ed = document.getElementById('editCommuteBtn');
  if (ed) ed.addEventListener('click', () => openEditCommute(c));
}

// The 1-second heartbeat. Updates just the timer text + urgency class in place
// (cheap), and re-renders fully when a departure passes so it rolls forward.
function startTicking() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(() => {
    const c = activeCommute();
    if (!c || !c.legs.length) return;
    const leg = c.legs[activeLegIndex];
    if (!leg) return;
    if (ScheduleService.isLive(leg.serviceId)) maybeRefreshLive(leg, renderCountdown); // keep live data warm
    const now = new Date();
    const deps = selectLegDepartures(c, activeLegIndex, now).deps; // transfer-aware for connecting legs
    const timer = document.getElementById('cdTimer');
    if (!deps.length || !timer) { renderCountdown(); return; }

    const msAway = deps[0].when - now;
    if (msAway <= 0) { renderCountdown(); return; } // departure passed -> roll to next

    const txt = fmtCountdown(msAway);
    timer.textContent = txt;
    timer.classList.toggle('long', txt.length >= 7); // shrink long h:mm:ss timers

    // Keep urgency state in sync without a full re-render.
    const card = timer.closest('.cd-card');
    const minsAway = msAway / 60000;
    let state = 'comfy', headline = 'Comfortable';
    if (minsAway <= 1) { state = 'go'; headline = 'Go now'; }
    else if (minsAway <= 4) { state = 'soon'; headline = 'Leaving soon'; }
    if (card && !card.classList.contains('state-' + state)) {
      card.className = 'cd-card state-' + state;
      const h = card.querySelector('.cd-headline');
      if (h) h.textContent = headline;
    }
  }, 1000);
}

function renderAll() {
  renderDashboard();
  renderCountdown();
  startTicking();
}

// ===========================================================================
//  Minimal onboarding — create & name a commute with multiple legs.
// ===========================================================================

function serviceOptions(selectedId) {
  return ScheduleService.services.map(s => {
    const info = ScheduleService.describeService(s.id);
    const label = `${info.operatorShort}: ${info.originName} \u2192 ${info.destinationName}`;
    return `<option value="${s.id}" ${s.id === selectedId ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

// Draft held in memory while the sheet is open.
let draft = null;

function openOnboarding() {
  draft = {
    _editId: null,
    name: '',
    recurringDays: [1, 2, 3, 4, 5],
    scheduleMode: 'arrive_by',
    arrivalGoal: '09:00',
    arrivalBuffer: 10,
    walkMinutes: 0,
    legs: [{ serviceId: ScheduleService.services[0].id, preferredTime: 'next' }]
  };
  renderOnboarding();
  el('sheet').classList.add('open');
}

// Edit an existing commute in place (preserves its id when saved). Pre-fills the
// sheet from the commute's current settings; nothing is changed until the user saves.
function openEditCommute(c) {
  draft = {
    _editId: c.id,
    name: c.name || '',
    recurringDays: (c.recurringDays || []).slice(),
    scheduleMode: commuteMode(c),
    arrivalGoal: c.arrivalGoal || '09:00',
    arrivalBuffer: commuteArrivalBuffer(c),
    walkMinutes: commuteWalkMinutes(c),
    legs: c.legs.map(l => ({ serviceId: l.serviceId, preferredTime: l.preferredTime }))
  };
  renderOnboarding();
  el('sheet').classList.add('open');
}
function closeOnboarding() {
  el('sheet').classList.remove('open');
  draft = null;
}

function renderOnboarding() {
  const body = el('sheetBody');
  const title = document.getElementById('sheetTitle');
  if (title) title.textContent = draft._editId ? 'Edit commute' : 'New commute';
  const dayToggles = DAY_LABELS.map((lbl, i) =>
    `<button type="button" class="day-toggle ${draft.recurringDays.includes(i) ? 'on' : ''}" data-day="${i}">${lbl}</button>`
  ).join('');

  const legRows = draft.legs.map((leg, i) => `
    <div class="leg-edit" data-leg="${i}">
      <div class="leg-edit-head">
        <span>Leg ${i + 1}</span>
        ${draft.legs.length > 1 ? `<button type="button" class="link-btn danger" data-remove="${i}">Remove</button>` : ''}
      </div>
      <label class="fld">
        <span class="fld-k">Service</span>
        <select data-field="serviceId" data-leg="${i}">${serviceOptions(leg.serviceId)}</select>
      </label>
      <label class="fld">
        <span class="fld-k">Departure</span>
        <select data-field="preferredTime" data-leg="${i}">
          <option value="next" ${leg.preferredTime === 'next' ? 'selected' : ''}>Next available train</option>
          ${departureTimeOptions(leg.serviceId, leg.preferredTime, draft.recurringDays)}
        </select>
      </label>
    </div>`).join('');

  body.innerHTML = `
    <label class="fld">
      <span class="fld-k">Commute name</span>
      <input id="draftName" type="text" placeholder="e.g. Morning to NYU" value="${esc(draft.name)}" />
    </label>

    <div class="fld">
      <span class="fld-k">Repeats on</span>
      <div class="day-row">${dayToggles}</div>
    </div>

    <div class="fld">
      <span class="fld-k">How to schedule</span>
      <select id="draftMode">
        <option value="arrive_by" ${draft.scheduleMode === 'arrive_by' ? 'selected' : ''}>Arrive by a target time</option>
        <option value="fixed" ${draft.scheduleMode === 'fixed' ? 'selected' : ''}>Fixed departure train</option>
        <option value="next_available" ${draft.scheduleMode === 'next_available' ? 'selected' : ''}>Next available (immediate)</option>
      </select>
    </div>
    ${draft.scheduleMode === 'arrive_by' ? `
    <div class="fld fld-inline">
      <label class="fld-sub"><span class="fld-k">Target arrival</span><input id="draftGoal" type="time" value="${esc(draft.arrivalGoal || '09:00')}" /></label>
      <label class="fld-sub"><span class="fld-k">Arrive buffer (min)</span><input id="draftBuffer" type="number" min="0" max="120" value="${Number(draft.arrivalBuffer)}" /></label>
      <label class="fld-sub"><span class="fld-k">Walking time (min)</span><input id="draftWalk" type="number" min="0" max="120" value="${Number(draft.walkMinutes)}" /></label>
    </div>
    <p class="fld-hint">We plan backward from your target so you arrive at least the buffer early. Walking time is from the final station to your destination — <strong>0 means none entered</strong>, not that no walk is needed.</p>` : ''}
    ${draft.scheduleMode === 'fixed' ? '<p class="fld-hint">Pick each leg’s specific departure below (leg 1 is the train you board).</p>' : ''}
    ${draft.scheduleMode === 'next_available' ? '<p class="fld-hint">Shows the soonest departure from now — best for an immediate, one-off trip.</p>' : ''}

    <div class="legs-edit">${legRows}</div>
    <button type="button" class="btn btn-ghost" id="addLegBtn">+ Add leg</button>

    <div class="sheet-actions">
      <button type="button" class="btn" id="saveCommuteBtn">Save commute</button>
      <button type="button" class="btn btn-ghost" id="cancelCommuteBtn">Cancel</button>
    </div>
    <p class="cd-note">PATH / Hudson-Bergen Light Rail legs use <strong>SCHEDULED</strong> published times when available; other legs use illustrative <strong>MOCK</strong> data. Not live transit information.</p>`;

  // Wire up inputs.
  el('draftName').addEventListener('input', e => { draft.name = e.target.value; });

  const modeSel = document.getElementById('draftMode');
  if (modeSel) modeSel.addEventListener('change', e => { draft.scheduleMode = e.target.value; renderOnboarding(); });
  const goalEl = document.getElementById('draftGoal');
  if (goalEl) goalEl.addEventListener('input', e => { draft.arrivalGoal = e.target.value; });
  const bufEl = document.getElementById('draftBuffer');
  if (bufEl) bufEl.addEventListener('input', e => { const v = parseInt(e.target.value, 10); draft.arrivalBuffer = Number.isFinite(v) ? v : 0; });
  const walkEl = document.getElementById('draftWalk');
  if (walkEl) walkEl.addEventListener('input', e => { const v = parseInt(e.target.value, 10); draft.walkMinutes = Number.isFinite(v) ? v : 0; });

  body.querySelectorAll('[data-day]').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = +btn.getAttribute('data-day');
      const idx = draft.recurringDays.indexOf(d);
      if (idx >= 0) draft.recurringDays.splice(idx, 1); else draft.recurringDays.push(d);
      draft.recurringDays.sort();
      renderOnboarding();
    });
  });

  body.querySelectorAll('select[data-field]').forEach(sel => {
    sel.addEventListener('change', e => {
      const i = +sel.getAttribute('data-leg');
      const field = sel.getAttribute('data-field');
      draft.legs[i][field] = e.target.value;
      if (field === 'serviceId') { draft.legs[i].preferredTime = 'next'; renderOnboarding(); }
    });
  });

  body.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      draft.legs.splice(+btn.getAttribute('data-remove'), 1);
      renderOnboarding();
    });
  });

  el('addLegBtn').addEventListener('click', () => {
    draft.legs.push({ serviceId: ScheduleService.services[0].id, preferredTime: 'next' });
    renderOnboarding();
  });

  el('saveCommuteBtn').addEventListener('click', saveDraft);
  el('cancelCommuteBtn').addEventListener('click', closeOnboarding);
}

function departureTimeOptions(serviceId, selected, days) {
  const svc = ScheduleService.service(serviceId);
  // SCHEDULED services: list actual published departure times that run on the
  // chosen days (so weekend-only drafts don't show weekday trains, etc.).
  if (svc && (svc.dataBasis === 'scheduled' || svc.dataBasis === 'demo')) {
    const times = ScheduleService.scheduledDepartureTimes(serviceId, days && days.length ? days : [0, 1, 2, 3, 4, 5, 6]);
    if (!times.length) {
      return `<option value="next" disabled>No scheduled trains on the selected days</option>`;
    }
    return times.map(t => {
      const [h, m] = t.split(':').map(Number);
      const d = new Date(); d.setHours(h, m, 0, 0);
      const overnight = (h < 4) ? ' (overnight)' : '';
      return `<option value="${t}" ${t === selected ? 'selected' : ''}>Scheduled ${fmtClock(d)}${overnight}</option>`;
    }).join('');
  }
  if (!svc || !Array.isArray(svc.departures)) return '';
  return svc.departures.map(t => {
    const [h, m] = t.split(':').map(Number);
    const d = new Date(); d.setHours(h, m, 0, 0);
    return `<option value="${t}" ${t === selected ? 'selected' : ''}>Usually ${fmtClock(d)}</option>`;
  }).join('');
}

function saveDraft() {
  if (!draft.name.trim()) { draft.name = 'My commute'; }
  if (!draft.legs.length) { closeOnboarding(); return; }
  const commute = {
    id: draft._editId || randId('cmt_'),
    name: draft.name.trim(),
    recurringDays: draft.recurringDays.slice().sort(),
    scheduleMode: draft.scheduleMode,
    arrivalBuffer: Number.isFinite(draft.arrivalBuffer) ? draft.arrivalBuffer : 10,
    walkMinutes: Number.isFinite(draft.walkMinutes) ? draft.walkMinutes : 0,
    legs: draft.legs.map(l => ({ serviceId: l.serviceId, preferredTime: l.preferredTime }))
  };
  if (draft.scheduleMode === 'arrive_by') commute.arrivalGoal = (draft.arrivalGoal || '09:00');
  // Preserve a destination label (e.g. "NYU") set on an existing/flagship commute.
  if (draft._editId) {
    const existing = commutes.find(x => x.id === draft._editId);
    if (existing && existing.destinationLabel) commute.destinationLabel = existing.destinationLabel;
  }
  if (draft._editId) {
    const idx = commutes.findIndex(x => x.id === draft._editId);
    if (idx >= 0) commutes[idx] = commute; else commutes.push(commute);
  } else {
    commutes.push(commute);
  }
  saveCommutes();
  activeCommuteId = commute.id;
  activeLegIndex = 0;
  legBoarded = [];
  closeOnboarding();
  renderAll();
}

// ===========================================================================
//  Boot
// ===========================================================================

async function init() {
  let res;
  try {
    res = await fetch('data/mock_schedule.json?v=' + Date.now(), { cache: 'no-store' });
  } catch (e) {
    throw new Error('Could not fetch mock_schedule.json (are you serving over http, not file://?).');
  }
  if (!res.ok) throw new Error(`mock_schedule.json returned HTTP ${res.status}.`);
  try {
    SCHEDULE = await res.json();
  } catch (e) {
    throw new Error('mock_schedule.json is not valid JSON.');
  }
  if (!SCHEDULE || !Array.isArray(SCHEDULE.services) || !Array.isArray(SCHEDULE.operators)) {
    throw new Error('mock_schedule.json is missing "services" or "operators".');
  }

  ScheduleService.init(SCHEDULE);

  // Load preprocessed SCHEDULED timetables (PATH / HBLR) if present. These are
  // generated locally by tools/build_schedules.mjs and are git-ignored pending
  // redistribution approval, so a fresh clone simply has none (Build 2 behavior).
  // Any fetch/parse failure is ignored: the app keeps working with MOCK + LIVE.
  for (const f of ['data/path_schedule.json', 'data/hblr_schedule.json']) {
    try {
      const r = await fetch(f + '?v=' + Date.now(), { cache: 'no-store' });
      if (r.ok) ScheduleService.addScheduledDoc(await r.json());
    } catch (e) { /* optional dataset — ignore when absent */ }
  }

  // Public fallback: if NO real SCHEDULED services loaded (the git-ignored PATH/
  // HBLR files are absent, e.g. on GitHub Pages), load the committed, clearly
  // labeled synthetic DEMO dataset so the full arrive-by workflow still works.
  // When real scheduled data IS present (authorized local testing), we skip the
  // demo so SCHEDULED behavior is preserved and never shadowed.
  if (!ScheduleService.services.some(s => s.dataBasis === 'scheduled')) {
    try {
      const r = await fetch('data/demo_schedule.json?v=' + Date.now(), { cache: 'no-store' });
      if (r.ok) ScheduleService.addScheduledDoc(await r.json());
    } catch (e) { /* demo dataset optional — ignore on failure */ }
  }

  loadCommutes();

  // Open on the commute suggested for right now.
  activeCommuteId = suggestCommuteId(new Date());
  activeLegIndex = 0;
  legBoarded = [];

  renderAll();

  // Close the onboarding sheet by tapping the backdrop.
  el('sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeOnboarding(); });

  // Close the My Commutes / Explore drawer by tapping the backdrop or Close.
  el('drawer').addEventListener('click', e => { if (e.target.id === 'drawer') closeDrawer(); });
  el('drawerCloseBtn').addEventListener('click', closeDrawer);
}

init().catch(showFatalError);
