# ALAWA platform

Election-day situation room, results verification against IReV, field agent app, and voice outreach.
Design: *ALAWA Platform: Software Design Document* (Claude Docs). This repository implements it.

## Layout

| Folder | What it is |
|---|---|
| `shared/` | Dependency-free TypeScript used everywhere: SMS fallback codec, incident categories, deadlines, result checks, phone and polling-unit code helpers |
| `supabase/migrations/` | Postgres schema, row-level security, and all business rules as SQL functions (case merging, routing, assignment, escalation, three-source verification, callbacks, contacts, top-ups, dashboard read APIs) |
| `supabase/functions/` | Edge Functions (Deno): `sms-inbound` (SMS fallback webhook), `calls` (click-to-call, bridged callbacks), `voice-events` (Africa's Talking voice webhook, robocall playback and opt-out), `live-view` (LiveKit tokens), `media-url` (signed URLs) |
| `supabase/tests/` | Database tests that run on plain local Postgres |
| `worker/` | Node service: IReV fetch jobs, duplicate-sheet detection, OCR, trend check, notifications (push, SMS, WhatsApp), top-ups (VTpass, Africa's Talking), voice dialer, import scripts |
| `apps/dashboard/` | Angular Material situation room: queue, cases, callbacks, live results, IReV data manager, sheet review, contacts, people, shifts, top-ups, voice outreach |
| `apps/agent/` | Ionic + Capacitor mobile app: check-in, checklist, incidents and SOS, quick count, EC8A result with photo, offline queue with SMS fallback, callback requests, messages, live view, coordinator tools |
| `legacy/` | Earlier prototype server, not used |

## Requirements

- Node 24.15 or newer (Angular 22). On macOS 13, set `NG_BUILD_SASS_EMBEDDED=0` (already in the app `build`/`start` scripts) because the native Dart Sass binary needs macOS 14.
- A Supabase project (Postgres 15+). For local development, the Supabase CLI with Docker.
- Accounts: Africa's Talking (SMS sender ID, short code or long number, voice number), Firebase (push), LiveKit or Agora (live view), VTpass (top-ups), WhatsApp Business (notifications), an OCR provider (Google Vision or Azure Document Intelligence).

## Run the tests

```bash
npm test
```

This runs the shared codec tests, the worker tests (including duplicate-sheet detection on the real IReV samples in `samples/`) and the database scenario tests (`supabase/tests/run.sh`, which needs a local Postgres with `createdb`).

## Set up a Supabase project

```bash
supabase link --project-ref <ref>
supabase db push
supabase secrets set --env-file supabase/functions/.env
supabase functions deploy sms-inbound voice-events calls live-view media-url
```

Then in the Supabase dashboard: enable phone sign-in with an SMS provider, and enable the `pg_cron` extension (the timers in migration `…0800_platform.sql` are scheduled only when it exists; the worker also runs them every 20 seconds).

Africa's Talking callback URLs:

- Incoming SMS: `https://<ref>.supabase.co/functions/v1/sms-inbound?key=<WEBHOOK_KEY>`
- Voice callback: `https://<ref>.supabase.co/functions/v1/voice-events?key=<WEBHOOK_KEY>`

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

The first tenant, its queues (national, security, legal, helpdesk, one per state) and its admins are created with SQL; `supabase/seed.sql` shows the shape (it is development data, do not run it in production).

## Run the apps

Set `public/config.js` in each app (Supabase URL, anon key; for the agent app also the SMS number).

```bash
cd apps/dashboard && npm install && npm start          # http://localhost:4200
cd apps/agent && npm install && npm start              # browser preview
cd apps/agent && npx cap add android && npm run android   # Android build
```

## What is verified and what is not

Verified here:
- 18 groups of database scenario tests pass (merging, routing, auto-assignment by language, acknowledgement and resolution escalation, supervisor merge and undo, three-source mismatch alerts, callback escalation chain, contact approval rules, two-admin top-up approval, row-level security, service-only functions, dashboard read APIs).
- Shared and worker unit tests pass, including the SMS codec and duplicate detection on real 2023 IReV sheets (units 19-28-02-003 and 19-28-02-005 carry the same photo).
- Both Angular apps build; Edge Functions pass `deno check`.
- Agent app in a phone-sized browser: sign-in, PIN lock, home, EC8A result entry and review, offline queue with "Send by SMS".

Not yet verified (needs real accounts or a Supabase project):
- Supabase Auth OTP, Realtime, Storage policies and pg_cron on a live project.
- Africa's Talking calls, SMS and airtime; LiveKit live view; FCM push; VTpass; WhatsApp; OCR providers.
- The EC8A OCR parser against real 2027 sheets (tune once INEC releases the form).
- The Android build (Capacitor platform not added yet) and testing on low-end phones.
- Load tests (k6) at election-day volume.

## Decisions still open

See section 13.2 of the design document: calling provider capacity, OCR provider choice, SMS fallback on Play Store vs direct APK, Supabase region and data residency, final 2027 party list, call-recording approval, IReV terms review. Hausa text in `apps/agent/src/app/core/i18n.ts` needs review by a native speaker.
