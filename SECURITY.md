# Security Policy & Assessment — LinkWise

_Build 3 · Beginner lane · branch `build-3-schedules`._ This document records the
security posture, the tests performed, findings, fixes, and the controls that do
or do not apply to LinkWise.

## 1. What LinkWise is (threat-model context)

LinkWise is a **static, client-side browser application** (HTML + CSS + vanilla
JavaScript) served from `docs/` on **GitHub Pages**.

- **No sign-in / accounts.** No user authentication.
- **No backend server, no application database, no server-side code.**
- **No paid APIs, no server secrets.** The only runtime network calls are:
  1. the official **MTA GTFS-Realtime** feed — public, **key-free**, CORS-enabled;
  2. same-origin static JSON (`mock_schedule.json`, optional `demo_schedule.json`,
     and — only on an authorized local machine — git-ignored `path_schedule.json` /
     `hblr_schedule.json`);
  3. **PostHog** analytics/session-replay using a **public project token** (designed
     to be exposed in client code).

Because there is no backend, database, or privileged API, the attack surface is
almost entirely **client-side**: HTML/DOM injection (XSS) and accidental secret
exposure in the published static assets.

## 2. Data storage and its limitations

All user data lives in the visitor's own browser **`localStorage`** (same-origin):

| Key | Contents |
| --- | --- |
| `linkwise_commutes_v1` | Saved commutes (name, legs, days, arrive-by settings). |
| `linkwise_seeded_samples_v1` | Ids of sample commutes already seeded (dup/resurrection guard). |
| `linkwise_replay_optout`, `linkwise_analytics_notice` | Analytics opt-out + notice-dismissed flags. |

**Limitations (documented, accepted for this MVP):**
- `localStorage` is **not encrypted** and is readable by any script on the same
  origin; we therefore store **no credentials and no sensitive personal data** —
  only user-chosen commute definitions. A commute *name* is free text and could
  contain personal info, so it is **masked in session replay** (see §5).
- Data is per-device/per-browser; there is no sync and no server copy.
- No server-side validation is possible; all rendering sanitizes input (§4).

## 3. Secret-key scan (tracked code **and** publicly served assets)

**Reproducible search (clean result expected):**

```bash
# From the repo root — scans all tracked files, excluding the placeholder example.
git grep -nE "api[_-]?key|secret|password|bearer|sk-or-|sk-[A-Za-z0-9]{20}|AKIA|-----BEGIN|token *[:=]" \
  -- . ':(exclude).env.example'
```

**Result:** no credentials in tracked source or in the published `docs/` assets.
The only matches are:
- the **public PostHog project token** in `docs/app/index.html` (safe by design to
  ship in client code), and
- the **placeholder** `OPENROUTER_API_KEY=sk-or-v1-replace-with-your-key` in
  `.env.example` (an example, not a real key).

Real secrets are excluded by `.gitignore` (`.env`, `.env.*` except the example,
`*.pem`, `*.key`, `secrets.*`, `credentials.json`). **No `.env` is tracked.**

> This secret-scan command + its clean output is the **required security-test
> screenshot** for submission. The XSS test below is supplementary evidence.

## 4. Stored-XSS / DOM-injection testing

**Test category (matches the architecture):** client-side **HTML/DOM injection**
via user-controlled fields — the only user free-text input is the **commute name**
(plus `arrivalGoal` time and numeric buffer/walk inputs).

**Method:** create/edit a commute and set its **name** to a script payload, then
render the dashboard, My Commutes drawer, and countdown.

```
Payload:  <img src=x onerror=alert('xss')>
```

**Result — PASS.** All user-controlled values are routed through a central
`esc()` helper (escapes `& < > " '`) before interpolation into `innerHTML`. The
payload renders as **inert escaped text** (`&lt;img …&gt;`), no `onerror` fires,
no element is injected. Verified both manually in-browser (no alert) and by an
automated check in `tests/schedule_logic.test.js`.

**Defensive hardening applied:** `data-*` attributes that interpolate a commute
`id` are now also `esc()`-escaped (ids are system-generated, but escaped as
defense-in-depth).

## 5. PostHog session-replay masking — regression, fix, verification

**Finding (medium, privacy):** The Build 3 UI redesign renamed the DOM, but the
session-replay mask still targeted the **old** class `.cc-name`, which no longer
exists. User-entered commute names now render in `.cmx-name`, `.featured-label`,
and `.cd-leg`, so they would have been **captured in session replays**.

**Fix:** the mask selector now covers every place commute names / destinations
appear across the redesigned dashboard, drawer, countdown, and journey details:

```
maskAllInputs: true,
maskTextSelector: '.mask-pii, .cmx-name, .cmx-route, .cmx-confirm,
                   .featured-label strong, .cd-leg, .jsum-k, .jp-leg, .cd-map'
```

**Verified:** `maskAllInputs` masks form fields while typing; the selector masks
the rendered names/destinations in the dashboard, drawer, countdown, journey
panel, and the schematic map text. The **analytics opt-out** ("Decline recording")
and existing event capture (e.g. `viewed_live_countdown`) remain functional.

## 6. Third-party calls, dependency audit, and cost review

- **Dependency audit:** **Not applicable in the usual sense — there are no
  installed dependencies.** No `package.json`, no `node_modules` shipped, no npm
  supply chain. (The repo contains dev-only test files run with Node's built-ins.)
- **Third-party runtime calls & cost:**
  - MTA GTFS-Realtime feed — **$0**, key-free, CORS, public.
  - PostHog (US cloud) — **$0** on the free tier; public token; privacy controls on.
  - GitHub Pages hosting — **$0**.
- **No paid APIs, no credentialed APIs** are used at runtime.

## 7. Remaining security & privacy limitations

- `localStorage` is unencrypted and device-local (no sensitive data stored there).
- Client-only trust model: there is no server to enforce authorization — anyone
  can view the public site; there is nothing private to protect server-side.
- PostHog captures product-usage analytics and masked session replays; users can
  decline recording. Commute names are masked but analytics still records that the
  app is used.
- The public site uses **DEMO** (synthetic) schedule data for the flagship; it is
  clearly labeled and must never be presented as real. Real GTFS-derived schedules
  stay local and git-ignored (see §8).

## 8. Production protection & "Ask me first" rules

To keep the deployment safe and compliant:

- **Never commit or publish** generated `path_schedule.json` / `hblr_schedule.json`
  or raw GTFS (`tools/.gtfs_cache/`). They are git-ignored pending **NJ TRANSIT
  developer registration** and **PATH/PANYNJ redistribution permission**.
- **Never label** synthetic DEMO or MOCK data as `SCHEDULED` or `LIVE`, and never
  fabricate "live" times. Honest states: `LIVE` (MTA only), `SCHEDULED` (real
  local GTFS), `DEMO` (synthetic public), `MOCK` (illustrative), `UNAVAILABLE`.
- **Ask the human before:** deploying/enabling GitHub Pages; publishing any
  transit-operator-derived data; adding a dependency, backend, database, auth, or
  any paid/credentialed API; rotating or exposing the PostHog token; changing
  `localStorage` keys/schema or analytics configuration.

## 9. Controls that are **not applicable** (and why)

| Control | Applicable? | Why |
| --- | --- | --- |
| Database security / row-level security | **No** | No database; data is per-browser `localStorage`. |
| Authentication / authorization / sessions | **No** | No sign-in, no accounts, no server. |
| Server-side input validation / SQL injection | **No** | No server, no SQL. Client-side output is escaped. |
| API rate limiting / quota controls | **No (server)** | We expose no API. The MTA feed is polled gently (~25s) while its one demo is open; PostHog manages its own ingest. |
| Secret management / key rotation | **Minimal** | No server secrets; only a public PostHog token and a git-ignored dev `.env`. |
| Dependency/CVE scanning | **N/A** | No runtime dependencies. |
| CSRF protection | **No** | No authenticated state-changing server endpoints. |

## 10. Reporting

This is a course project with no production users or private data. For any
security concern, open a GitHub issue on the repository.
