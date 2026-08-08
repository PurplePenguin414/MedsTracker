# Med Refill Tracker

Self-hosted medication refill tracker. Tracks each medication's refill interval,
last pickup date, and pharmacy refills remaining — and tells you when to call it
in next and whether that call goes to the pharmacy or the doctor.

## How it works

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
