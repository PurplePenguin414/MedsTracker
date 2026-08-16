# Med & Appointment Tracker

Self-hosted medication refill tracker, now merged with an appointment tracker
for Therapy/EMDR, Dietitian, Doctor, and Other visits. One login, one app,
two modes — switch between them via the "Medications" / "Appointments" tabs
under the header.

## Medications module

Tracks each medication's refill interval,
last pickup date, and pharmacy refills remaining — and tells you when to call it
in next and whether that call goes to the pharmacy or the doctor.

### How it works

For each medication you enter:
- **Refill interval (days)** — how often you're allowed to call it in
- **Last picked up** — the date of your last pickup
- **Refills remaining at pharmacy** — how many refills the pharmacy has on file

The app computes:
- **Next call-in date** = last picked up + refill interval
- **Status**: On track / Due soon (within 3 days, adjustable via `ALERT_LEAD_DAYS`) / Overdue
- **Next action**: "Call pharmacy to refill" if refills remain, or "Call doctor for
  new prescription" if refills are at 0 — shown alongside the refill count

Clicking **Mark picked up** logs the pickup, resets the last-picked-up date to today,
and decrements the refill count by one. Full pickup history is kept per medication.

### As-needed medications

Check "As needed — no fixed refill schedule" in the add/edit form to skip the
date/interval tracking entirely. These meds never show up as due soon or
overdue. They still track refills remaining, and if that count hits 0
they're flagged as "Refills needed" (in the app and in Discord reminders) —
since even an as-needed med eventually needs a new prescription.

### Pause / resume

The **Pause** button on a medication stops it from being tracked or alerted
on, without deleting it or losing its pickup history. Useful if a
prescription was discontinued but you might revisit it, or you're taking a
break. **Resume** brings it back into normal tracking, picking up right
where it left off. Paused medications never appear in Discord reminders.

## Appointments module

Tabs for **Therapy/EMDR**, **Dietitian**, **Doctor**, and **Other**, each with
their own relevant fields (e.g. Therapy tracks topics covered, homework
assigned, and target memory; Doctor tracks reason for visit, diagnosis,
prescriptions/referrals, and follow-up needed). A **Dashboard** view shows
all four types' upcoming appointments at a glance.

Each type has its own **Upcoming** / **History** (last 5 days, most recent
first) / and, for Therapy only, a **Prep Checklist** view — a reusable EMDR
question bank you can check off before an appointment, managed via "Manage
Questions."

Appointments support file attachments (PDF, PNG, JPEG, WEBP, HEIC, TXT, up
to 25MB) and a separate Discord reminder channel from medications — set
`DISCORD_APPT_WEBHOOK_URL` in `.env` to a **different** webhook than
`DISCORD_WEBHOOK_URL`. Reminders fire 1 and 3 days before an appointment by
default (`APPT_REMINDER_LEAD_DAYS`), check once immediately on app startup
to catch anything missed while the app was off, and won't double-send for
an appointment that's already been reminded at a given lead time.

## iPhone home screen

**Quick option — app icon (no code changes needed):**
Open `https://meds.megangibbs.net` in Safari on your iPhone, tap the Share
icon, then "Add to Home Screen." It opens full-screen with no browser bar,
and since login persists for 30 days you'll rarely need to sign in again.

**Real widget — live status on your home screen:**
Uses the free **Scriptable** app (App Store) to show overdue/due-soon counts
directly on your home screen, no opening the app required. Setup:

1. Set `WIDGET_API_KEY` in `.env` to a random value (e.g. `openssl rand -hex 16`)
2. Install Scriptable from the App Store
3. Open `ios-widget/MedTrackerWidget.js` from this repo, copy its contents
   into a new script in Scriptable
4. Edit the `WIDGET_KEY` constant at the top to match your `.env` value
5. Long-press your home screen → tap + → search "Scriptable" → add the
   widget → edit it and set "Script" to the one you just created

The widget refreshes on iOS's own schedule and shows a green dot for
on-track meds and red/amber dots for anything needing attention. Tapping it
opens the app directly.

## Symptom / side-effect log

Each medication's History view has a **Symptoms** tab. Log the date,
severity (Mild/Moderate/Severe), and a description whenever you notice
something — especially useful in the first few weeks of a new medication to
spot patterns before your next doctor visit. Entries are listed newest
first and can be deleted individually.

## Titration tracking

The **Titration** tab in History logs dose changes over time — date, new
dosage, and optional notes (e.g. "doctor increased dose after 2-week
check-in"). Logging a dose change here also updates the medication's
current dosage shown on its card, so you always see the latest.

## Cost tracking

Set an optional **cost per fill** when adding or editing a medication. Each
time you mark it picked up, that cost is automatically logged, and the
medication card shows a running **total spent to date**. The PDF export
includes both figures per medication.

## Printable medication list (PDF)

The **Export PDF** button in the top bar generates a clean, doctor-visit-ready
PDF of all your current medications — name, dosage, schedule, refills
remaining, cost, and notes — with paused medications listed separately at
the bottom so it's clear what you're not currently taking.

## Discord reminders

Set `DISCORD_WEBHOOK_URL` in `.env` to enable a daily check (default 8:00 AM
`America/Detroit`, both configurable via `REMINDER_CRON_SCHEDULE` and
`REMINDER_TIMEZONE`). If anything is due soon or overdue, it posts a summary
to that Discord channel. If nothing needs attention that day, it stays quiet
— no daily noise for meds that are on track.

To get a webhook URL: in Discord, go to the target channel's Settings →
Integrations → Webhooks → New Webhook, copy the URL.

Use the **Test Discord reminder** button in the app to fire an immediate
check (great for confirming the webhook works right after deploying, without
waiting for the scheduled time).

## Local setup

```bash
npm install
cp .env.example .env
node hash-password.js "yourPassword"
# paste the printed hash into .env as APP_PASSWORD_HASH
node server.js
```

## Deploy on MLG-VPS01 (matches Rover Tracker / Homepage pattern)

1. Push this repo to GitHub (e.g. `PurplePenguin414/MedTracker`)
2. SSH into MLG-VPS01
3. `git clone` it into `/opt/med-tracker`
4. `cd /opt/med-tracker && cp .env.example .env`
5. `node hash-password.js "yourPassword"` (or run via `docker run --rm -it node:20-alpine node hash-password.js "yourPassword"` if Node isn't installed on the host) and paste the hash into `.env`
6. `docker-compose build && docker-compose up -d`
7. Add an Apache vhost proxying `meds.megangibbs.net` (or your subdomain of choice) to `127.0.0.1:3030`
8. `certbot --apache -d meds.megangibbs.net`
9. Add the Cloudflare DNS record (grey cloud / DNS-only before certbot, can switch to proxied after)
10. Optional: add a Homepage bookmark/service entry pointing at the new subdomain

## Update workflow

Same as Rover Tracker:
```bash
git pull
docker-compose build
docker rm -f med-tracker
docker-compose up -d
```

## Notes

- Port `3030` is used in `docker-compose.yml` to avoid clashing with Homepage (3020).
  Change it if that's already taken on MLG-VPS01.
- Data is stored in SQLite at `./data/meds.db`, bind-mounted so it survives rebuilds.
- Back this up the same way as your other MLG-VPS01 apps (borgmatic already covers
  everything under its configured paths — just confirm `/opt/med-tracker/data` is included).
