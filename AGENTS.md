# AGENTS.md — Coding Agent Operating Manual

> Give this file to your coding agent and check that it is using these instructions. Keep the stack, commands, and ground rules current.

## 1. Project Overview
- **What this repo builds:** LinkWise, a personalized commuter assistant — “Smarter connections, every day.” It helps NJ→NYC commuters catch their transit connections (PATH, NJ Transit Rail, Hudson-Bergen Light Rail) through a large, colorful departure countdown. Build 1 is a local slice: save multi-leg commutes, get the right one suggested by day/time, and watch a live-style countdown to the next train. All departure data is clearly labeled MOCK.
- **Primary user & core workflow:** NJ-resident NYC commuters who ride the same routes daily. Core workflow: dashboard suggests (or user switches to) a saved commute → large per-second departure countdown shows boarding station, destination, direction, and operator → rider taps “I'm on this train → Next leg” to advance through legs → the countdown rolls to the next eligible departure when one passes. Commutes persist in `localStorage`. See the living PRD in `docs/index.html`.
- **Tech stack:** Static HTML/CSS/vanilla JS (no build step, no backend). The app lives in `docs/app/` so GitHub Pages (`main` → `/docs`) publishes it alongside the Product Page. Data flows through a single `ScheduleService` seam in `docs/app/app.js`: MOCK legs read `docs/app/data/mock_schedule.json`; one `"live": true` service calls the official **MTA GTFS-Realtime** feed (key-free, CORS-enabled) via a dependency-free protobuf decoder (`parseMtaDepartures`). Deterministic tests in `tests/schedule_logic.test.js` (run with `node`), including a real-feed adapter test against `tests/fixtures/mta_gtfs_123.pb`.
- **Hard constraints:** No fabricated real-time information. The only live data is the clearly-labeled MTA demo (LIVE / MOCK / UNAVAILABLE states; never show a guessed “live” train). All PATH / NJ Transit / HBLR times are illustrative MOCK and labeled as such. No paid services, no credentials in the app, no fare payments/checkout/ticket wallets.

## 2. Commands
- **Install dependencies:** none (static app).
- **Run locally:** `cd docs/app && python3 -m http.server 8000` then open `http://localhost:8000/` (serving via http is required so the browser can `fetch` the JSON).
- **Live URLs (GitHub Pages, publicly accessible now):** app at `https://building-with-ai-f26.github.io/ip2618-LinkWise/app/`, Product Page at `https://building-with-ai-f26.github.io/ip2618-LinkWise/`. Repo: `https://github.com/building-with-ai-f26/ip2618-LinkWise`.
- **Run deterministic tests:** `node tests/schedule_logic.test.js` (pure logic — ScheduleService, countdown formatting, next-departure selection, weekday validity, day/time commute suggestion, the MTA GTFS-Realtime adapter against a captured feed fixture, and Build 3 SCHEDULED timetable logic: calendars/exceptions, overnight GTFS times, SCHEDULED/UNAVAILABLE states, transfer-window-vs-buffer, and the Port Imperial→Hoboken→PATH→9th journey) **and** `node tests/build_schedules.test.mjs` (pure GTFS-preprocessor functions). No browser or network.
- **Rebuild real schedules (Build 3, local only):** `node tools/build_schedules.mjs` downloads the official PATH + NJ TRANSIT (HBLR) GTFS, filters to the LinkWise corridor, and writes `docs/app/data/{path,hblr}_schedule.json`. These generated files and the `tools/.gtfs_cache/` download are **git-ignored** pending redistribution approval (NJ TRANSIT requires a registered developer account; PATH/PANYNJ permission unconfirmed). The app loads them when present and otherwise falls back to MOCK/LIVE (Build 2 behavior).
- **Run model evals:** none yet (no model in Build 1).

## 3. Non-Negotiable Engineering Rules
1. **Plan before coding:** Before touching multiple files, propose a brief plan and wait for approval.
2. **Small batches:** Make small, focused changes that can be reviewed and explained by a human in a single Pull Request.
3. **Explainability:** Avoid unnecessary abstractions or dependencies. Help the human builder understand the main components, what changed, why it matters, what could break, and how it was checked.
4. **Verify changes:** Run relevant checks. For a reproducible logic bug, use a failing test to demonstrate the fix when practical. Record manual checks and known limitations; follow the selected Build 4 evaluation track.
5. **Zero secrets in code:** Never hardcode API keys, tokens, or credentials. Always read from environment variables (`.env`) and update `.env.example` when new variables are needed.
6. **Stop when looping:** If a fix fails twice in a row, stop, summarize what failed, and ask the human before trying a third approach.
7. **Keep UI selectors and analytics masking in sync.** When renaming/removing DOM classes, update any dependent config in the same change — especially the PostHog `maskTextSelector` that masks user-entered commute names/destinations. (Build 3 regression: a redesign left the mask pointing at the old `.cc-name` class, briefly exposing names in session replay. Always re-verify masking after UI changes.)
8. **Verify GTFS service dates before using a feed.** A GTFS feed is only valid for its `calendar`/`calendar_dates` window; an expired or not-yet-effective feed must render **UNAVAILABLE**, never stale times. Check `feed_start/end` (or min/max `start_date`/`end_date`) against “now” when ingesting, and re-run `tools/build_schedules.mjs` to refresh.
9. **Never publish unapproved transit data.** Do not commit, deploy, or otherwise expose generated `path_schedule.json` / `hblr_schedule.json` or raw GTFS (`tools/.gtfs_cache/`). They stay git-ignored until **NJ TRANSIT developer approval** and **PATH redistribution permission** are confirmed. The public site uses only the clearly-labeled synthetic **DEMO** dataset, MOCK data, and the keyless MTA LIVE demo.
10. **Honest data labeling.** Never label MOCK or DEMO data as `SCHEDULED` or `LIVE`, and never fabricate “live” times. States: `LIVE` (MTA only) · `SCHEDULED` (real local GTFS) · `DEMO` (synthetic public) · `MOCK` (illustrative) · `UNAVAILABLE`.

## 4. Shipping (GitHub Pages)
- **What publishes:** GitHub Pages serves the repo's **`/docs`** folder on `main`. The app is at `/app/`, the Product Page/PRD at `/`. Enable via **Settings → Pages → Deploy from a branch → `main` → `/docs` → Save**.
- **No build step.** Static files only; committing to `main` under `/docs` is the deploy. `docs/.nojekyll` keeps Pages from mangling asset paths.
- **What works in production (no restricted data):** the redesigned dashboard + **My Commutes** drawer, the **Explore** MTA **LIVE** demo, the large countdown, fixed/next-available modes, the journey map, and the arrive-by **Monday → NYU flagship on the clearly-labeled synthetic DEMO dataset** (`docs/app/data/demo_schedule.json`, committed). PostHog + privacy controls work.
- **What stays local:** the **real SCHEDULED** PATH/HBLR arrive-by experience (needs the git-ignored generated files). The app auto-loads DEMO only when no real SCHEDULED data is present, so authorized local testing keeps SCHEDULED behavior.
- **Pre-deploy checklist:** run `node tests/schedule_logic.test.js` **and** `node tests/build_schedules.test.mjs` (both green); run the secret scan in `SECURITY.md §3` (clean); confirm no `path_schedule.json`/`hblr_schedule.json`/`.gtfs_cache`/`.env` are staged; verify the DEMO flagship shows a **DEMO** badge (not SCHEDULED/LIVE) and the MTA LIVE demo loads.
- **Verify on a phone** after deploy: open the Pages `/app/` URL, confirm the featured Monday DEMO journey, advance a leg, and open the MTA LIVE demo.

## 5. Ask me first (require human approval before)
- Enabling/triggering a **deploy** or changing GitHub Pages settings.
- **Publishing any operator-derived transit data** (PATH/NJ TRANSIT), or un-ignoring the generated schedule files.
- Adding a **dependency, backend, database, authentication, or any paid/credentialed API**.
- Changing **`localStorage` keys/schema**, the analytics configuration, or **rotating/exposing** the PostHog token.
- Merging to `main`, force-pushing, or rewriting history.
