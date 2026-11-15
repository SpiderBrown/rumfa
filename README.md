# Rumfa

Election-day situation room, results verification against IReV, field agent app, and voice outreach, run as a multi-client service.
*Rumfa* is Hausa for the polling booth (*rumfar zaɓe*, the polling unit), the level the whole system works at.

| Name | What |
|---|---|
| **Rumfa** | The platform |
| **Rumfa Agent** | Mobile app for polling agents, volunteers and coordinators (`ng.rumfa.agent`) |
| **Rumfa Room** | Situation-room dashboard |

Each client (tenant) has its own short name in `tenants.settings.brand`, for example `ALAWA`. That name is shown in the apps after sign-in and starts every SMS, so a client's people see their own organisation, not the platform.

Each client's admins also choose how field users can call from a chat in the agent app (dashboard → Settings, stored in `tenants.settings.calls`):

| Option | Setting | Default | How it works |
|---|---|---|---|
| Rumfa call | `bridged` | on | Africa's Talking rings the caller, then connects the other person. The client pays; numbers stay hidden. |
| Internet call | `webrtc` | off | The caller speaks over mobile data through the Africa's Talking WebRTC client (`atWebrtcScript` in the agent's `config.js`); the other person gets a normal call. |
| Phone call | `phone` | on | The phone's own dialler, on the caller's airtime. |
| App call (free) | `inapp` | off | Voice over the internet between two people using the Rumfa apps (agent app ↔ agent app, or ↔ dashboard), through LiveKit. It rings in the other person's app (live update plus push notification). There's no phone network, so no per-minute charge. Applies to the dashboard too. |

The API enforces these switches (`POST /channels/:id/call`, `/calls/token` and `/calls/bridge` for field roles, `/calls/app/*` for everyone). Dashboard staff phone calling is not affected. App calls need `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`: the same LiveKit server that live video uses. LiveKit is open source: self-hosting it on your own server (`livekit-server`, a single binary or Docker image) has no licence or per-minute fees, only your server's bandwidth. LiveKit Cloud is the paid hosted alternative.

Africa's Talking **voice has no sandbox**. Rumfa calls, internet calls and voice outreach need the live app (`AT_USERNAME`, `AT_API_KEY`) and a voice number (`AT_VOICE_NUMBER`). Until those are set, the API answers with a clear message and the worker skips outreach dialling. SMS works in the sandbox. For development, use the phone-call option.

Design: *Rumfa Platform: Software Design Document* (Claude Docs). Sections 9 and 16 describe the backend.

## Architecture

**One NestJS API (`apps/api`) is the only way in.** The apps never talk to Supabase; Supabase is the Postgres host (and private file storage) behind the API, as in the dares-pue backend.

- **Database:** NestJS (TypeORM, `pg`) connects through the Supabase Session pooler `DATABASE_URL`, or a local Postgres. The SQL in `db/migrations/` is applied as TypeORM migrations when the API starts.
- **Business rules stay in SQL,** as tested database functions (case merging, routing, assignment, escalation, three-source verification, callbacks, contacts, top-ups). The API validates input, checks the role, then calls them inside the request's transaction.
- **Tenant isolation:** the tenant comes from the sign-in token. Every user request runs in a transaction that sets `app.user_id` / `app.tenant_id` and switches to the `rumfa_api` role, which cannot bypass row-level security; the API also scopes its queries. Webhooks and sign-in run as the owner and check things in code.
- **Supabase locked down:** `anon` and `authenticated` get no grants; Supabase Auth, Realtime, Edge Functions and pg_cron are not used. Storage buckets are private and reached only through short-lived links the API issues.
- **Sign-in:** field users activate each phone once (SMS code, WhatsApp code or coordinator activation code, chosen per client), then use phone + PIN. Staff use email + password, with an authenticator code for supervisors and admins. One identity can work for several clients; each token carries one.
- **Per-client dashboards:** the same Angular build on each client's domain with its own config; one Rumfa Agent app for all clients.
- **Live updates:** apps connect to Socket.IO at `/live` with their access token. Database triggers announce changes on `rumfa_changes`; each API instance forwards an event (ids and status only) to the connections allowed to see it: area rooms for room staff and coordinators, the person's own room, and a case or conversation after an access check. Apps then re-read through the REST API.
- **Worker:** the same codebase run as `node dist/worker.main`. Deadlines, notifications, top-ups, OCR, the voice dialer, trend checks and IReV jobs. Work is queued in Postgres tables (IReV jobs claimed with `SKIP LOCKED`, top-ups claimed per row) and each timer takes an advisory lock, so several workers can run safely; no extra queue system is needed.

Migration status:

| Part | Status |
|---|---|
| Database: identities, sign-in tables, `rumfa_api` role, lockdown | Done (`db/`) |
| API: sign-in, people, cases, field reports, results, IReV, callbacks, contacts, messages, shifts, top-ups, voice, live view, calls, file links | Done (`apps/api`) |
| Webhooks: SMS fallback, voice, WhatsApp, VTpass, LiveKit | Done (`/api/v1/webhooks/...`); Edge Functions removed |
| Live updates: Socket.IO at `/live`, fed by Postgres `NOTIFY` (works across API instances, no Redis) | Done |
| Worker as a second NestJS entry point (`node dist/worker.main`), all jobs on SQL | Done; `worker/` removed |
| Both apps switched from the Supabase client to the API and live updates | Done |

## Layout

| Folder | What it is |
|---|---|
| `shared/` | Dependency-free TypeScript used everywhere: SMS fallback codec, incident categories, deadlines, result checks, phone and polling-unit code helpers (copied into the API by `scripts/sync-shared.sh`) |
| `db/migrations/` | Postgres schema, row-level security, sign-in tables and all business rules as SQL functions |
| `db/tests/` | Database scenario tests on plain local Postgres |
| `apps/api/` | NestJS API: sign-in, guards, REST endpoints (docs at `/api/docs`), webhooks, file links, live updates (`src/live`), the worker (`src/worker`, started by `worker.main.ts`) and import scripts (`src/scripts`) |
| `apps/dashboard/` | Angular Material situation room (Rumfa Room) |
| `apps/agent/` | Ionic + Capacitor mobile app (Rumfa Agent) |
| `legacy/` | Earlier prototype server, not used |

## Requirements

- Node 24.15 or newer (Angular 22). On macOS 13, set `NG_BUILD_SASS_EMBEDDED=0` (already in the app `build`/`start` scripts) because the native Dart Sass binary needs macOS 14.
- A Supabase project (Postgres 15+) as the database host, or any Postgres. Local development and tests use a local Postgres.
- Accounts: Africa's Talking (SMS sender ID, short code or long number, voice number), Firebase (push), LiveKit or Agora (live view), VTpass (top-ups), WhatsApp Business (notifications), an OCR provider (Google Vision or Azure Document Intelligence).

## Run the API (NestJS)

```bash
cd apps/api
cp .env.example .env      # local Postgres, or DATABASE_URL = Supabase Session pooler
npm install
npm run start:dev         # applies db/migrations on start; docs at http://localhost:3000/api/docs
```

For local sign-in without SMS set `OTP_MODE=console` (codes appear in the log) or `OTP_MODE=fixed`.
The first admin gets an invite created with SQL or the `inviteStaff` service; after that, admins invite staff and coordinators issue activation codes from the API.

## Run the tests

```bash
npm test
```

This runs the shared codec tests, the database scenario tests (`db/tests/run.sh`), the API and worker unit tests (including duplicate-sheet detection on the real IReV samples in `samples/`) and the end-to-end tests (`apps/api/test`: API, live updates and worker jobs, on a fresh `rumfa_e2e` database per run). The database and end-to-end tests need a local Postgres with `createdb`.

## Set up Supabase as the database host

1. Create the project; copy the **Session pooler** connection string into the API's `DATABASE_URL`, and the project URL and service-role key into `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (server only).
2. Start the API once: it applies `db/migrations/` (roles, schema, lockdown, storage buckets).
3. In the Supabase dashboard: under Data API remove `public` from the exposed schemas; under Authentication disable sign-ups. Nothing else of Supabase is used.

Provider callback URLs (all carry the webhook key):

- Africa's Talking incoming SMS: `https://<api-host>/api/v1/webhooks/at/sms?key=<WEBHOOK_KEY>`
- Africa's Talking voice callback: `https://<api-host>/api/v1/webhooks/at/voice?key=<WEBHOOK_KEY>`
- WhatsApp: `https://<api-host>/api/v1/webhooks/whatsapp?key=<WEBHOOK_KEY>` (also checks `X-Hub-Signature-256`)
- VTpass: `https://<api-host>/api/v1/webhooks/vtpass?key=<WEBHOOK_KEY>`
- LiveKit: `https://<api-host>/api/v1/webhooks/livekit?key=<WEBHOOK_KEY>` (also checks LiveKit's signature)

## Run the worker and load data

```bash
cd apps/api && npm run build
npm run start:worker                                   # deadlines, notifications, top-ups, OCR, dialer, IReV jobs
npm run import:geography -- --states 18,19             # LGAs, wards, units from IReV (default: 19 northern states + FCT)
npm run import:boundaries -- --level state --file nga_admin1.geojson   # map outlines (see "Situation map")
npm run import:boundaries -- --level lga --file nga_admin2.geojson
npm run import:boundaries -- --level ward --file nga_wards.geojson
npm run import:inec-contacts                           # INEC state offices, RECs, LGA offices, hotlines
npm run import:liaison -- --tenant <id> --file liaison.csv
npm run import:people -- --tenant <id> --file agents.csv --dry-run   # then without --dry-run
npm run build:sample -- --tenant <id> --election <id> --size 1500
```

### Situation map

Room staff open **Situation map** in the dashboard. Coordinators open **My area map** in the agent app.
- **What it shows:** each person's own area split into its sub-areas (states → LGAs → wards → polling units). Click an area to go down a level.
- **Three views:**
  - **Issues:** heat bands by open cases, weighted by severity. Any open critical case shows darkest.
  - **Votes:** each area in its leading party's colour, stronger for a wider lead. Each unit counts its agent's EC8A result, else the IReV sheet, else the quick count.
  - **Reporting:** the share of units with a result.
- **Panel:** totals, vote bars and each sub-area's coordinator.
- **Updates:** live, as cases and verifications change.
- **Access:** the API (`GET /map`) limits each person to their own area and organisation.

**Outlines** come from free open boundary data that you download as GeoJSON and load with `import:boundaries`:
- states and LGAs: OCHA's Nigeria administrative boundaries on HDX;
- wards: GRID3 Nigeria.

Shapes are matched to our codes by name, simplified, and stored once for all clients in `area_shapes`. Names that don't match are listed for review. Load the geography (`import:geography`) first.

**Polling units** are points:
- `polling_units.lat/lng` when known;
- otherwise the average location where agents checked in.

**Background tiles** are set by `mapTiles` in each app's `config.js`:
- the default is OpenStreetMap's free tiles, which suit a small team;
- set `url: ''` for outlines only, or point it at your own tile server.

**Party colours** are neutral and given out in ballot order. Override them per client with `tenants.settings.party_colours`, for example `{"APC": "#1b7a3a"}`.

The worker and scripts use the API's `.env`. The first tenant (with `settings.brand`), its queues (national, security, legal, helpdesk, one per state) and its admins are created with SQL; `db/seed.sql` shows the shape (development data, do not run it in production).

## Run the apps

Each app has a `public/config.js` with no secrets; it only says where the API is.

- **Rumfa Room** (`apps/dashboard`): `apiUrl`, the `tenantId` of the client this site belongs to, and its `brand`. Host the same build on each client's domain with its own `config.js`. Staff sign in with email + password (+ authenticator code where required); admins send invite links from the People page.
- **Rumfa Agent** (`apps/agent`): `apiUrl`, the SMS fallback number and the helpline. One app for every client: a phone is activated once (SMS code, WhatsApp code, or a coordinator's activation code from the People or My team page) and then opened with the 6-digit PIN; people working for several clients pick one, and can switch from Help.

```bash
cd apps/dashboard && npm install && npm start          # http://localhost:4200
cd apps/agent && npm install && npm start              # browser preview
cd apps/agent && npx cap add android && npm run android   # Android build
```

For a local run, start the API with `OTP_MODE=fixed` and `STORAGE_DRIVER=local` (the `api-dev` entry in `.claude/launch.json` does this against a `rumfa_dev` database), load `db/seed.sql`, and give a staff member an email and password (or an invite) to use the dashboard.

## What is verified and what is not

Verified here:
- 25 end-to-end tests pass on a fresh database (API, live updates, worker jobs with providers faked). Live updates: a new case reaches that client's room staff only, events carry ids and status only, and a case timeline reaches only connections allowed to subscribe. Worker: SMS sent in the client's name with retries, IReV sheet download and storage with duplicate-photo alerts on real sheets, top-ups sent once and confirmed by SMS. API: every sign-in flow, two clients sharing one person, refresh-token reuse, activation codes, PIN lockout, staff sign-in with authenticator, the case flow (including critical cases waiting for a supervisor), EC8A photo upload and view links, callbacks, people, coded SMS routed by agent code, bridged voice calls, case messages, top-up approval, and client B seeing nothing of client A.
- 20 groups of database scenario tests pass (merging, routing, auto-assignment by language, acknowledgement and resolution escalation, supervisor merge and undo, three-source mismatch alerts, callback escalation chain, contact approval rules, two-admin top-up approval, row-level security, service-only functions, dashboard read APIs, two clients sharing one person, and the lockdown of credentials and Supabase's roles).
- Shared and worker unit tests pass, including the SMS codec and duplicate detection on real 2023 IReV sheets (units 19-28-02-003 and 19-28-02-005 carry the same photo).
- The API and the worker build and start on an empty database (the API applies all migrations).
- Both apps build, and were run end to end against the API: a phone activated with a code and a new PIN, a check-in and an incident report sent from the agent app, the case auto-assigned and shown in the dashboard (supervisor signed in with email and password), and a second report from the phone merged into the open case and appearing on the dashboard's case page without a reload.

Not yet verified (needs real accounts or a Supabase project):
- The API against a live Supabase project (Session pooler, Storage signed links).
- Africa's Talking calls, SMS and airtime; LiveKit live view; FCM push; VTpass; WhatsApp; OCR providers.
- The EC8A OCR parser against real 2027 sheets (tune once INEC releases the form).
- The Android build (Capacitor platform not added yet) and testing on low-end phones.
- Load tests (k6) at election-day volume.

## Decisions still open

See section 13.2 of the design document: calling provider capacity, OCR provider choice, SMS fallback on Play Store vs direct APK, Supabase region and data residency, final 2027 party list, call-recording approval, IReV terms review. Hausa text in `apps/agent/src/app/core/i18n.ts` needs review by a native speaker.
