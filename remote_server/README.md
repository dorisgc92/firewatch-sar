# FireWatch SAR — Remote Infrastructure Server

Moves the world infrastructure crawl (hospitals, fire stations, police,
power, schools, etc.) off GitHub and onto your own always-on machine.
GitHub keeps holding the lighter layers (hotspots, perimeters, FWI,
weather) exactly as before — only infrastructure moves.

**Why:** `data/infrastructure.geojson` kept growing until it crossed
GitHub's 100MB per-file push limit, which silently broke the crawl (every
push since was rejected). Running it here removes that ceiling entirely
— you're limited by your own disk, not GitHub.

## What's here

| File | Purpose |
|---|---|
| `store.py` | SQLite storage — the database this whole thing is built on |
| `crawler.py` | Long-running process, fetches the world 5 tiles at a time (parallel, not one-per-20-minutes like GitHub Actions was) |
| `api.py` | Small FastAPI server exposing `/infrastructure?bbox=...` for the frontend to query |
| `migrate_existing_data.py` | One-time import of what's already in `data/infrastructure.geojson` so the crawl doesn't start from zero |

## 1. Install

```bash
cd remote_server
python -m venv venv
# Windows:
venv\Scripts\activate
# Linux/Mac:
source venv/bin/activate

pip install -r requirements.txt
```

## 2. Migrate what you already have

Run this once, pointing at whatever's currently checked into your repo:

```bash
python migrate_existing_data.py ../data/infrastructure.geojson
```

This imports the existing hospitals/fire stations/police/power/airports
into `infrastructure.db` (created automatically in this folder). The
crawler will still revisit every tile afterward — it now also fetches
schools, clinics, fuel stations, towers, and water bodies (the categories
that used to be GitHub-only-per-zone), which the old file never had.

## 3. Start the crawler

```bash
python crawler.py
```

Leave this running. It prints one line per tile as it goes. A full lap
over all ~650 tiles at the default 5-parallel setting should take a few
hours rather than the ~week the old GitHub Actions schedule needed. After
finishing a lap it pauses (6h by default) before starting the next —
tune with environment variables if you want it faster/slower:

```bash
# Windows PowerShell
$env:CRAWLER_WORKERS=8; $env:CRAWLER_LAP_PAUSE_HOURS=0; python crawler.py

# Linux/Mac
CRAWLER_WORKERS=8 CRAWLER_LAP_PAUSE_HOURS=0 python crawler.py
```

Don't push `CRAWLER_WORKERS` too high — this hits the shared public
Overpass API, and being a considerate user of it (not hundreds of
concurrent requests) is what keeps it usable for everyone, including you
tomorrow.

## 4. Start the API server

In a second terminal (same venv):

```bash
uvicorn api:app --host 0.0.0.0 --port 8000
```

Sanity check it's working:

```bash
curl "http://localhost:8000/health"
curl "http://localhost:8000/infrastructure?bbox=-103.5,20.5,-103.2,20.8"
```

## 5. Expose it to the internet with Cloudflare Tunnel

No router configuration, no static IP needed, works even if your ISP
changes your IP.

1. Create a free Cloudflare account if you don't have one (cloudflare.com).
2. Install `cloudflared`:
   - Windows: download the installer from
     https://github.com/cloudflare/cloudflared/releases (the `.msi`)
   - Linux: `curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && sudo dpkg -i cloudflared.deb`
   - Mac: `brew install cloudflared`
3. Log in (opens a browser to authorize):
   ```bash
   cloudflared tunnel login
   ```
4. Create the tunnel:
   ```bash
   cloudflared tunnel create firewatch-infra
   ```
5. Point it at your local API (create `config.yml` next to where
   `cloudflared` looks for it, or pass `--url` directly for a quick test):
   ```bash
   cloudflared tunnel --url http://localhost:8000 run firewatch-infra
   ```
   This prints a public URL like `https://random-words.trycloudflare.com`
   (quick-tunnel mode) — or, if you own a domain on Cloudflare already,
   you can route a real subdomain (e.g. `infra.your-domain.com`) to this
   tunnel instead; ask me and I'll walk through that version too.
6. **Keep this running alongside the crawler and the API** — three
   processes total on this machine (crawler, API, tunnel).

## 6. Point Vercel at it

In your Vercel project → Settings → Environment Variables, add:

```
INFRA_API_URL = https://whatever-cloudflared-gave-you
```

Redeploy. `frontend/api/infrastructure.js` (the new Vercel proxy) reads
this and forwards zone queries to your machine — falling back to a
direct Overpass query if your machine is ever unreachable, so the app
degrades gracefully instead of breaking if this PC is off.

## 7. Keeping it running automatically (Ubuntu)

Three systemd services, so all of this survives reboots and restarts
itself if something crashes: the crawler, the API, and Cloudflare Tunnel.

### 7a. Crawler and API

Unit files are in `systemd/` — edit both to replace
`REPLACE_WITH_YOUR_USERNAME` with your actual Ubuntu username (run
`whoami` if unsure), and double check the paths match where you actually
cloned the repo.

```bash
sudo cp systemd/firewatch-crawler.service /etc/systemd/system/
sudo cp systemd/firewatch-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now firewatch-crawler
sudo systemctl enable --now firewatch-api
```

Check they're actually running:

```bash
sudo systemctl status firewatch-crawler
sudo systemctl status firewatch-api
```

Watch logs live:

```bash
journalctl -u firewatch-crawler -f
# or, since the units also append to plain log files:
tail -f crawler.log
tail -f api.log
```

### 7b. Cloudflare Tunnel as a service

The `cloudflared tunnel --url ... run` command from step 5 only lasts as
long as that terminal is open — for something that survives a reboot,
install it as a named tunnel + systemd service instead:

```bash
# 1. Create a config file (adjust the tunnel ID -- shown when you ran
#    `cloudflared tunnel create firewatch-infra` in step 5):
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: firewatch-infra
credentials-file: /home/REPLACE_WITH_YOUR_USERNAME/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: infra.YOUR-CHOSEN-SUBDOMAIN.com   # only if you have a domain on Cloudflare
    service: http://localhost:8000
  - service: http_status:404
EOF

# 2. If you don't have your own domain on Cloudflare, use a quick tunnel
#    URL instead (no hostname needed) -- ingress becomes just:
#    ingress:
#      - service: http://localhost:8000

# 3. Install and start as a system service:
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

Whatever public URL this ends up giving you (either your own subdomain,
or the `trycloudflare.com` one from the quick-tunnel step) is what goes
into Vercel's `INFRA_API_URL`.

### 7c. Confirm everything survives a reboot

```bash
sudo reboot
```

Wait a minute, SSH back in, then:

```bash
sudo systemctl status firewatch-crawler firewatch-api cloudflared
curl "https://your-tunnel-url/health"
```

All three should show `active (running)`, and the curl should return your
feature counts.

## Backup

`infrastructure.db` in this folder is now the single source of truth for
infrastructure data — nothing else needs to change for the app to keep
working, but if this machine's disk ever fails, that data (weeks of
crawling) is gone. Recommended minimum: copy `infrastructure.db`
somewhere else periodically (an external drive, a synced cloud folder
you already use, etc.). Ask if you want a small script that does this on
a schedule automatically.
