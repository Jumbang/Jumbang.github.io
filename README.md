# Akari Suite Booking System

A phone-installable booking app (PWA) for a small suite/room rental business. All staff share one live database: a booking, payment or check-in made on one phone appears on every other phone within a second.

## Features
- **Today** – arrivals, departures, who's staying tonight, available rooms, unpaid balance, missed check-ins / late check-outs, guests arriving in 3 days who haven't paid.
- **Calendar** – rooms × days timeline; bars coloured by payment (green paid, amber partial, red unpaid). Tap an empty day to book it.
- **Bookings** – search by name/phone/booking #, filter Upcoming / Checked in / Unpaid / Past / Cancelled.
- **Booking details** – payments (cash, GCash, Maya, bank…) with partial/down payments, balance, check in/out, cancel, no-show, call/SMS/WhatsApp guest, share confirmation text.
- **Double-booking protection** – warns before saving overlapping dates for the same room.
- **Staff accounts** – owner (admin) adds staff logins; activity log shows who did what.
- **Reports** – cash collected, booked revenue, occupancy %, nights per room, booking sources.
- **Export** – CSV for Excel / Google Sheets.

## Run locally
Requires only Python 3.10+ (no dependencies).

```bash
python3 server.py            # http://localhost:8000
PORT=9000 DB_PATH=/path/to/suite.db python3 server.py
```

First visit shows a setup screen to create the owner account and rooms.

## Deploy
Any host that can run a Python process or a Docker container **with a persistent disk** for the SQLite file (`DB_PATH`). Must be served over **HTTPS** so phones can install it.

```bash
docker build -t suite-bookings .
docker run -p 8000:8000 -v suite-data:/data suite-bookings
```

Back up the database by copying the `DB_PATH` file.

## Install on a phone
Open the site → iPhone: Share → *Add to Home Screen*; Android: ⋮ → *Install app*.

## Hosting on Render (free) with a Neon database

The server uses SQLite by default. Set `DATABASE_URL` to a PostgreSQL connection string (e.g. from Neon) to store data there instead; this needs `pip install -r requirements.txt`.

`render.yaml` defines a free Render web service (`python3 server.py`). Set `DATABASE_URL` in the Render dashboard, then add the custom domain (e.g. `akarisuites.com`) under the service's Settings → Custom Domains.

## Hosting on GitHub Pages + Supabase (free, always on)

This is the recommended setup. The website is plain files served by GitHub Pages; all data, logins and live sync
live in a free Supabase project.

1. Create a Supabase project (region: Singapore). In **SQL Editor**, run `supabase/schema.sql`.
   It creates the tables in a private `akari` schema and a single function `public.api(...)` that the app calls.
2. In `static/config.js`, set `supabaseUrl` (Project URL) and `anonKey` (the public anon / publishable key).
   Both are safe to publish; the data tables are not reachable with them, only through `public.api`.
3. Push to the `main` branch of a public GitHub repo. `.github/workflows/pages.yml` publishes the `static/` folder.
   In the repo's **Settings → Pages**, choose **GitHub Actions** as the source and set the custom domain.
4. Open the site and create the owner account on the first screen.

Live sync uses Supabase Realtime on the `public.sync_version` table, with a slow poll as a fallback.
If `config.js` is left empty, the app talks to `server.py` instead (handy for local development).
