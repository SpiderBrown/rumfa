# Rumfa

Election-day situation room, results verification against IReV, field agent app, and voice outreach, run as a multi-client service.
*Rumfa* is Hausa for the polling booth (*rumfar zaɓe*, the polling unit), the level the whole system works at.

| Name | What |
|---|---|
| **Rumfa** | The platform |
| **Rumfa Agent** | Mobile app for polling agents, volunteers and coordinators (`ng.rumfa.agent`) |
| **Rumfa Room** | Situation-room dashboard |

Each client (tenant) has its own short name in `tenants.settings.brand`, for example `ALAWA`. That name is shown in the apps after sign-in and starts every SMS, so a client's people see their own organisation, not the platform.

Design: *Rumfa Platform: Software Design Document* (Claude Docs). Sections 9 and 16 describe the backend.

## Architecture

**One NestJS API (`apps/api`) is the only way in.** The apps never talk to Supabase; Supabase is the Postgres host (and private file storage) behind the API, as in the dares-pue backend.

- **Database:** NestJS (TypeORM, `pg`) connects through the Supabase Session pooler `DATABASE_URL`, or a local Postgres. The SQL in `db/migrations/` is applied as TypeORM migrations when the API starts.
- **Business rules stay in SQL,** as tested database functions (case merging, routing, assignment, escalation, three-source verification, callbacks, contacts, top-ups). The API validates input, checks the role, then calls them inside the request's transaction.
- **Tenant isolation:** the tenant comes from the sign-in token. Every user request runs in a transaction that sets `app.user_id` / `app.tenant_id` and switches to the `rumfa_api` role, which cannot bypass row-level security; the API also scopes its queries. Webhooks and sign-in run as the owner and check things in code.
- **Supabase locked down:** `anon` and `authenticated` get no grants; Supabase Auth, Realtime, Edge Functions and pg_cron are not used. Storage buckets are private and reached only through short-lived links the API issues.
- **Sign-in:** field users activate each phone once (SMS code, WhatsApp code or coordinator activation code, chosen per client), then use phone + PIN. Staff use email + password, with an authenticator code for supervisors and admins. One identity can work for several clients; each token carries one.
- **Per-client dashboards:** the same Angular build on each client's domain with its own config; one Rumfa Agent app for all clients.

Migration status:

| Part | Status |
|---|---|
| Database: identities, sign-in tables, `rumfa_api` role, lockdown | Done (`db/`) |
| API: sign-in, people, cases, field reports, results, IReV, callbacks, contacts, messages, shifts, top-ups, voice, live view, calls, file links | Done (`apps/api`) |
| Webhooks: SMS fallback, voice, WhatsApp, VTpass, LiveKit | Done (`/api/v1/webhooks/...`); Edge Functions removed |
| Live updates (Socket.IO + Postgres `NOTIFY`) | Not yet |
| Worker as a NestJS entry point with pg-boss (`worker/` still uses the Supabase client) | Not yet |
| Apps switched from the Supabase client to the API | Not yet: **the apps do not work until this is done** |

## Layout

| Folder | What it is |
|---|---|
| `shared/` | Dependency-free TypeScript used everywhere: SMS fallback codec, incident categories, deadlines, result checks, phone and polling-unit code helpers (copied into the API by `scripts/sync-shared.sh`) |
| `db/migrations/` | Postgres schema, row-level security, sign-in tables and all business rules as SQL functions |
| `db/tests/` | Database scenario tests on plain local Postgres |
| `apps/api/` | NestJS API: sign-in, guards, REST endpoints (docs at `/api/docs`), webhooks, file links |
| `worker/` | Node service: IReV fetch jobs, duplicate-sheet detection, OCR, trend check, notifications, top-ups, voice dialer, import scripts |
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

This runs the shared codec tests, the worker tests (including duplicate-sheet detection on the real IReV samples in `samples/`), the database scenario tests (`db/tests/run.sh`) and the API end-to-end tests (`apps/api`, a fresh `rumfa_e2e` database per run). The last two need a local Postgres with `createdb`.

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

## Load reference data and people

```bash
cd worker
cp .env.example .env    # fill in
npm run import:geography -- --states 18,19          # LGAs, wards, units from IReV (default: 19 northern states + FCT)
npm run import:inec-contacts                          # INEC state offices, RECs, LGA offices, hotlines
npm run import:liaison -- --tenant <id> --file liaison.csv
npm run import:people -- --tenant <id> --file agents.csv --dry-run   # then without --dry-run
npm run build:sample -- --tenant <id> --election <id> --size 1500
npm start                                             # the worker itself
```

The first tenant (with `settings.brand`), its queues (national, security, legal, helpdesk, one per state) and its admins are created with SQL; `db/seed.sql` shows the shape (it is development data, do not run it in production).

## Run the apps

Set `public/config.js` in each app (Supabase URL, anon key; for the agent app also the SMS number).

```bash
cd apps/dashboard && npm install && npm start          # http://localhost:4200
cd apps/agent && npm install && npm start              # browser preview
cd apps/agent && npx cap add android && npm run android   # Android build
```

## What is verified and what is not

Verified here:
- 20 API end-to-end tests pass on a fresh database: every sign-in flow, two clients sharing one person, refresh-token reuse, activation codes, PIN lockout, staff sign-in with authenticator, the case flow (including critical cases waiting for a supervisor), EC8A photo upload and view links, callbacks, people, coded SMS routed by agent code, bridged voice calls, case messages, top-up approval, and client B seeing nothing of client A.
- 20 groups of database scenario tests pass (merging, routing, auto-assignment by language, acknowledgement and resolution escalation, supervisor merge and undo, three-source mismatch alerts, callback escalation chain, contact approval rules, two-admin top-up approval, row-level security, service-only functions, dashboard read APIs, two clients sharing one person, and the lockdown of credentials and Supabase's roles).
- Shared and worker unit tests pass, including the SMS codec and duplicate detection on real 2023 IReV sheets (units 19-28-02-003 and 19-28-02-005 carry the same photo).
- The API builds and boots on an empty database, applying all migrations.

Not yet verified (needs real accounts or a Supabase project):
- The API against a live Supabase project (Session pooler, Storage signed links).
- Africa's Talking calls, SMS and airtime; LiveKit live view; FCM push; VTpass; WhatsApp; OCR providers.
- The EC8A OCR parser against real 2027 sheets (tune once INEC releases the form).
- The Android build (Capacitor platform not added yet) and testing on low-end phones.
- Load tests (k6) at election-day volume.

## Decisions still open

See section 13.2 of the design document: calling provider capacity, OCR provider choice, SMS fallback on Play Store vs direct APK, Supabase region and data residency, final 2027 party list, call-recording approval, IReV terms review. Hausa text in `apps/agent/src/app/core/i18n.ts` needs review by a native speaker.
