# My Health

A small, self-hosted personal health tracker. One login, one SQLite file, no cloud.

| Tab | What it does |
|---|---|
| **Medications** | Tracks refill intervals and pharmacy refills, and tells you when to call and who to call (pharmacy or doctor). Symptom log, dose changes, costs, PDF export. |
| **Appointments** | Therapy, dietitian, doctor and other visits with type-specific fields, attachments, prep checklist and Discord reminders. |
| **Period** | Cycle tracking with predictions and a doctor-ready PDF/CSV report. |
| **Therapy Notes** | A guided before/after journal for each therapy session, exportable to Markdown (works well with Obsidian). |
| **Emergency Info** | A printable card with allergies, conditions, contacts and your current medications, plus an optional no-login share link. |

It is built for **one person** (a single shared password, not multi-user accounts). It stores sensitive data, so run it behind HTTPS and keep backups — see [Security](#security).

---

## Quick start (Docker)

```bash
git clone https://github.com/<you>/<your-repo>.git my-health
cd my-health
cp .env.example .env
```

Generate your password hash and paste it into `.env` as `APP_PASSWORD_HASH`:

```bash
docker run --rm -it -v "$PWD":/app -w /app node:20-alpine \
  sh -c "npm install --silent bcryptjs && node hash-password.js 'yourPassword'"
```

> If you use `docker compose`, escape every `$` in the hash as `$$` in `.env`.

Also set `SESSION_SECRET` (`openssl rand -hex 32`), `APP_URL` and `REMINDER_TIMEZONE`, then start it:

```bash
docker compose up -d --build
```

The app listens on `127.0.0.1:3030`. Put a reverse proxy in front of it (below) and open your URL.

### Without Docker

Requires Node 20+.

```bash
npm install
cp .env.example .env      # fill it in
node hash-password.js "yourPassword"
node server.js
```

---

## Reverse proxy and HTTPS

Never expose port 3030 directly. Examples for `health.example.com`:

**Caddy** (automatic HTTPS):
```
health.example.com {
    reverse_proxy 127.0.0.1:3030
}
```

**Apache** (then `certbot --apache -d health.example.com`):
```apache
<VirtualHost *:80>
    ServerName health.example.com
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:3030/
    ProxyPassReverse / http://127.0.0.1:3030/
    RequestHeader set X-Forwarded-Proto "https"
</VirtualHost>
```
(needs `a2enmod proxy proxy_http headers`)

**nginx**:
```nginx
location / {
    proxy_pass http://127.0.0.1:3030;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

If another container needs to reach this one by name (for example a dashboard calling the appointments API), attach it to the shared Docker network with a `docker-compose.override.yml` instead of editing the tracked compose file:

```yaml
services:
  med-tracker:
    networks: [shared-net]
networks:
  shared-net:
    external: true
```

---

## Configuration

All settings live in `.env` (see `.env.example` for comments).

| Variable | Required | Purpose |
|---|---|---|
| `APP_PASSWORD_HASH` | yes | bcrypt hash of your login password |
| `SESSION_SECRET` | yes | long random string for session cookies |
| `PORT` | no | internal port (default 3000) |
| `APP_URL` | recommended | public URL, used for links in Discord messages |
| `REMINDER_TIMEZONE` | recommended | IANA timezone, e.g. `America/Chicago`. Controls "today" and reminder times |
| `ALERT_LEAD_DAYS_WITH_REFILL` / `ALERT_LEAD_DAYS_NO_REFILL` | no | when a med becomes "due soon" (defaults 3 / 5) |
| `DISCORD_WEBHOOK_URL` | no | daily medication reminders |
| `REMINDER_CRON_SCHEDULE` | no | cron for the med reminder (default `0 8 * * *`) |
| `DISCORD_APPT_WEBHOOK_URL` | no | appointment reminders (use a different channel than meds) |
| `APPT_REMINDER_LEAD_DAYS` | no | days before an appointment to remind (default `1,3`) |
| `WIDGET_API_KEY` | no | enables the iOS widget endpoint |
| `APPT_API_KEY` | no | enables the read-only appointments API |
| `EMERGENCY_SHARE_KEY` | no | enables the no-login Emergency Info share link |

---

## Features

### Medications
For each medication you enter the **refill interval**, **last picked up** date and **refills remaining at the pharmacy**. The app computes the next call-in date from the last pickup date and tells you the next action: *call the pharmacy* if refills remain, or *call the doctor for a new prescription* if none do.

- **Status** is On track, Due soon (3 days before if a refill is on file, 5 if you need a new prescription) or Overdue.
- **Call in / Picked up** are tracked separately; the next date is always counted from the last pickup.
- **As needed** meds have no schedule but are flagged when refills hit 0.
- **Pause / Resume** stops tracking and alerts without losing history.
- **Symptom log**, **titration** (dose changes update the current dose) and **cost tracking** (running total per medication).
- **Export PDF** of the current medication list, or of the full history.

### Appointments
Tabs for Therapy, Dietitian, Doctor and Other, each with relevant fields (Other supports custom fields). Includes a dashboard, upcoming/history views, file attachments (PDF, PNG, JPEG, WEBP, HEIC, TXT up to 25 MB) and a reusable **prep question checklist** for therapy visits.

### Period
Log period start/end, past periods and per-day flow, symptoms and notes. The next period is predicted from the median of your last 6 cycles. **Export for doctor** produces a PDF or CSV. Nothing here is exposed through the public Emergency link or API keys.

### Therapy Notes
A guided note for each session: how you feel before and after, what you talked about, what stood out, what you didn't get to say, takeaways, things to practice, and what to bring next time. Fill in the "before" part ahead of the session and finish the rest afterwards. Export one session or all of them as Markdown.

### Emergency Info
Name, date of birth, blood type, allergies, conditions, notes and contacts. Current medications are pulled live from the Medications tab so the card cannot go stale. Print it, or set `EMERGENCY_SHARE_KEY` to get a no-login link you can put in a QR code.

### Discord reminders
Set a webhook URL to get a daily message when meds are due soon or overdue (silent when nothing needs attention), and reminders before appointments. Use **Test Discord reminder** in the menu to verify a webhook.

### iPhone
- **App icon:** open the site in Safari → Share → Add to Home Screen.
- **Widget:** install the free *Scriptable* app, create a script from `ios-widget/MedTrackerWidget.js`, set `WIDGET_URL` to your domain and `WIDGET_KEY` to your `WIDGET_API_KEY`, then add a Scriptable widget to your home screen.

### Appointments API (optional)
With `APPT_API_KEY` set, other apps can read upcoming appointments:
`GET /api/external/appointments?key=<key>&start=YYYY-MM-DD&end=YYYY-MM-DD`

---

## Updating

```bash
git pull
docker compose build
docker rm -f med-tracker
docker compose up -d
```

After an update, fully close and reopen the page (or hard refresh) so your browser loads the new CSS and JavaScript.

## Backups

Everything is in `./data` (the SQLite database `meds.db` plus uploaded appointment attachments), and your settings are in `.env`. Back up both. A simple option is to stop the container and copy the folder, or use a tool like borgmatic, restic or rsync on `data/`.

## Security

- Single-user password login; sessions last 30 days.
- Health data is sensitive: serve it only over HTTPS, use a strong password, and keep `.env` out of git (it is in `.gitignore`).
- Anyone with the Emergency share link or an API key can read what that feature exposes. Rotate the key by changing it in `.env` and restarting.
- There is no rate limiting built in; a reverse proxy or Cloudflare rule is a good idea if the site is public.

## Development

```bash
npm install
npm test        # period-tracking logic tests
node server.js
```

Stack: Node 20, Express, better-sqlite3, express-session, node-cron, pdfkit, multer. No build step; the frontend is plain HTML/CSS/JS in `public/`.

## Disclaimer

This is a personal tracking tool, not medical advice or a medical device. Always confirm refill and dosing information with your pharmacist or clinician.
