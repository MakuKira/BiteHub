# BiteHub local prototype

BiteHub now runs as a Python web server with a persistent SQLite database. The browser does not store accounts, menu data, or orders in `localStorage`.

## Start the server

Open PowerShell in this folder and run:

```powershell
.\start.ps1
```

The launcher uses Python 3 from your system, or the Python runtime bundled with Codex when available. Open [http://127.0.0.1:8000](http://127.0.0.1:8000). Keep the terminal open while using the site; press `Ctrl+C` to stop it.

The database is created as `bitehub.sqlite3` in this folder. It survives server restarts and is excluded from source control. To put the database somewhere else, set the `BITEHUB_DB` environment variable before starting the server.

### Device order notifications

Install the push encryption dependency once with `python -m pip install -r requirements.txt` (or use the same Python runtime that starts BiteHub). The server creates a VAPID key under `.local-certs/` automatically; keep that folder when moving the app so existing device subscriptions continue to work. Customers and stall owners enable alerts with the **Enable alerts** button. Customers receive order status changes; the stall owner receives new order alerts.

Push notifications require a secure browser origin: `localhost` works for development, and phones on the campus network need the HTTPS launcher with a certificate trusted by that phone. Set `BITEHUB_VAPID_SUBJECT` to a valid `mailto:` contact or HTTPS contact URL before deployment. Notifications are best-effort when a device is offline or its push subscription has expired.

## Account types

- **Campus customer:** browse a stall-balanced rotating catalog, see daily featured campus picks, explore one stall at a time, filter dietary labels and allergens, view item details, choose capacity-limited 30-minute pickup windows or campus delivery, receive status alerts and ready-time estimates, and review completed orders.
- **Stall owner:** create a stall account, set opening hours, typical prep time, per-window pickup limits, and stock counts, feature one available item for 24 hours, upload optional JPG/PNG/WebP menu photos (up to 2 MB each), disclose dietary/allergen information, edit items, accept orders, assign delivery orders to a runner, and read customer feedback.
- **Campus runner:** see assigned runs and update pickup and delivery progress.
- **Administrator:** pause or resume stalls, review campus activity, and pause or resume ordering.

Customers, stall owners, and runners can create accounts from the role chooser. Stall owners can self-register; their stalls appear to customers as soon as signup is complete. Administrators can pause a stall if needed, and paused stalls stay hidden until resumed. Administrator accounts are deliberately not available through public signup. Create one from PowerShell with:

```powershell
.\start.ps1 --create-admin
```

The command prompts for an email, name, and password. Admin passwords and all account passwords are salted and hashed by the server. To start using the site afterward, run `.\start.ps1` in a separate PowerShell window.

## Prototype notes

The database schema is created automatically the first time the server starts. New installations start with an empty menu: register an owner account, add menu items, then register customer and runner accounts to work through the order flow. There are no seeded accounts or sample orders.

This is intended for a trusted local prototype. The built-in HTTP server is not an internet-facing production deployment; use a production application server, HTTPS, backups, and an institutional identity provider before exposing real accounts or student data.

## Capacity and production readiness

The SQLite schema can store 20,000 student accounts, but this prototype is not certified for 20,000 simultaneous users. Background order checks are staggered and fetch only order data, but 20,000 active sessions would still generate hundreds of requests per second. Before a campus-wide launch, move to managed PostgreSQL and a production ASGI/WSGI application server with horizontal scaling, then run a staged load test at the expected peak. Keep the SQLite database for local development only; the free Render service is not a production capacity target.

## Free Render deployment

The included `render.yaml` can deploy BiteHub on Render's free web service. Push this folder to GitHub, create a new Render Blueprint, and select the repository. The free service does not include a persistent disk, so the SQLite database may reset when the service restarts or redeploys. Use a paid persistent disk or a hosted PostgreSQL database before relying on it for real accounts or orders.
