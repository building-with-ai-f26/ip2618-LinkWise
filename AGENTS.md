# AGENTS.md — Coding Agent Operating Manual

> Give this file to your coding agent and check that it is using these instructions. Keep the stack, commands, and ground rules current.

## 1. Project Overview
- **What this repo builds:** LinkWise helps commuters plan recurring trips and catch their next transit connection. Save multi-leg NJ→NYC commutes (PATH, NJ Transit Rail, Hudson-Bergen Light Rail), see per-second countdowns to your next departure, and plan arrive-by journeys with transfer buffer enforcement. All departure data is clearly labeled by source (LIVE, SCHEDULED, DEMO, MOCK, UNAVAILABLE).
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
10. **Honest data labeling.** Never label MOCK or DEMO data as `SCHEDULED` or `LIVE`, and never fabricate "live" times. States: `LIVE` (MTA only) · `SCHEDULED` (real local GTFS) · `DEMO` (synthetic public) · `MOCK` (illustrative) · `UNAVAILABLE`.
11. **Brand consistency.** Use Inter font throughout. Primary brand color: electric violet #6D28D9. Keep button/countdown gradients for personality; avoid decorative gradients elsewhere. Warm cream background preserved.
12. **Clear, short UI copy.** Aim for <50 chars in UI hints where practical. No chatbot language ("Your personal...", "I can help..."). Short, specific, actionable instructions. Example: "Select a commute to start" not "Open My Commutes to pick a journey and start the countdown."
13. **No unsupported product claims.** Only provable features: multi-leg trip planning, per-second countdown, arrive-by planning with transfer buffer, browser-based storage. Never claim "AI-powered", "real-time" (MTA LIVE is demo-only), "never miss a train", or other unprovable guarantees.
14. **Privacy: Public infrastructure vs personal information.** Public transit station names (Port Imperial, Hoboken Terminal, 33rd Street) are allowed in demo data. Personal information (NYU destination, specific class schedules, personalized Mon-Fri patterns) must NOT appear in public files. Demo data must be marked `demo:true` and clearly labeled DEMO/SIMULATED.
15. **Accessibility.** Touch targets ≥45px. Font size ≥16px for body text. Mobile viewport with `viewport-fit=cover`. Safe-area insets for notched screens. `aria-live="polite"` on countdown timer.

## 3a. Automated Checks (Run Before Commit)
```bash
# Full test suite (330 tests)
node tests/persistence.test.js && \
node tests/privacy_regression.test.js && \
node tests/schedule_logic.test.js && \
node tests/build_schedules.test.mjs && \
node tests/final_validation.test.js

# Privacy: No NYU or personal samples in public files
grep -ri "nyu" docs/app/data/*.json && echo "❌ NYU found" || echo "✓ Privacy OK"

# Brand: No hardcoded colors (use CSS vars)
grep "#[0-9a-f]\{6\}" docs/app/index.html | grep -v "var(--" && echo "❌ Hardcoded color" || echo "✓ CSS vars OK"

# PostHog masking: Verify selectors exist
grep "maskTextSelector" docs/app/index.html && echo "✓ Masking configured"
```

## 4. Shipping (GitHub Pages)
- **What publishes:** GitHub Pages serves the repo's **`/docs`** folder on `main`. The app is at `/app/`, the Product Page/PRD at `/`. Enable via **Settings → Pages → Deploy from a branch → `main` → `/docs` → Save**.
- **No build step.** Static files only; committing to `main` under `/docs` is the deploy. `docs/.nojekyll` keeps Pages from mangling asset paths.
- **What works in production (no restricted data):** the redesigned dashboard + **My Commutes** drawer, the **Explore** MTA **LIVE** demo, the large countdown, fixed/next-available modes, the journey map, and the arrive-by demo journey (Port Imperial → Hoboken Terminal → 33rd Street → Destination) using the clearly-labeled synthetic DEMO dataset (`docs/app/data/demo_schedule.json`, committed). PostHog + privacy controls work.
- **What stays local:** the **real SCHEDULED** PATH/HBLR arrive-by experience (needs the git-ignored generated files). The app auto-loads DEMO only when no real SCHEDULED data is present, so authorized local testing keeps SCHEDULED behavior.
- **Pre-deploy checklist:** run all 330 tests (`persistence.test.js` + `privacy_regression.test.js` + `schedule_logic.test.js` + `build_schedules.test.mjs` + `final_validation.test.js`, all green); run the secret scan in `SECURITY.md §3` (clean); confirm no `path_schedule.json`/`hblr_schedule.json`/`.gtfs_cache`/`.env` are staged; verify the DEMO demo shows a **DEMO** badge (not SCHEDULED/LIVE), uses real public station names (Port Imperial, Hoboken Terminal, 33rd Street), has no NYU or personal destinations, and the MTA LIVE demo loads.
- **Verify on a phone** after deploy: open the Pages `/app/` URL, confirm the welcome screen ("Try a live example" opens MTA LIVE directly), demo journey shows real public station names with DEMO badge, advance a leg, verify Inter font loads.

## 5. Ask me first (require human approval before)
- Enabling/triggering a **deploy** or changing GitHub Pages settings.
- **Publishing any operator-derived transit data** (PATH/NJ TRANSIT), or un-ignoring the generated schedule files.
- Adding a **dependency, backend, database, authentication, or any paid/credentialed API**.
- Changing **`localStorage` keys/schema**, the analytics configuration, or **rotating/exposing** the PostHog token.
- Merging to `main`, force-pushing, or rewriting history.
