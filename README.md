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

### Phone GPS over local HTTPS

GPS and push notifications are restricted by phone browsers to HTTPS. The regular `py server.py` command listens only on this computer. To use a phone, create a local certificate for the computer's current school-network address and start the HTTPS launcher:

1. Connect the computer and phone to the same trusted school Wi-Fi. In PowerShell, run `ipconfig` and note the computer's IPv4 address for that Wi-Fi adapter (for example, `192.168.1.25`).
2. Install the certificate dependency with `py -m pip install -r requirements.txt` if needed.
3. From the FOODHUB folder, run `py generate_local_cert.py --host-ip 192.168.1.25`, replacing the sample address with the address you noted. If you will browse by the PC name, add `--host-name YOUR-PC-NAME` too. Run this again if the computer gets a different LAN IP; the local CA remains the same and only the server certificate is renewed.
4. Transfer `.local-certs/root-ca.crt` to the phone and install it as a trusted certificate authority using the phone's certificate settings. On iPhone/iPad, after installing the profile, enable full trust for the root certificate in Certificate Trust Settings. On Android, install it as a CA certificate and allow the browser to trust user-installed certificates if that setting is available. Windows browsers on the server PC also need the root certificate installed in the current user's Trusted Root Certification Authorities store if they are opened by LAN IP.
5. Keep `.local-certs/root-ca.key` private. Transfer only `root-ca.crt` to devices; it is the public certificate used to verify the server.
6. Run `start-secure.cmd` on the computer. If Windows Firewall asks, allow access only on the Private network profile. On the phone, open `https://192.168.1.25:8000` using the same IP on the certificate. Replace the sample IP with your own. The browser should show a secure connection without a certificate warning before you sign in or enable GPS.

The phone and computer must stay on the same trusted network. Do not allow the server through the Public firewall profile or use this local prototype on an untrusted/public Wi-Fi network. The launcher uses HTTPS and binds to the computer's network interfaces; the normal server command stays limited to localhost. The server rejects a direct all-interface HTTP bind. Render uses `--behind-proxy` because its platform terminates HTTPS before forwarding requests to the app.

## Account types

- **Campus customer:** browse a stall-balanced rotating catalog, see daily featured campus picks, explore one stall at a time, filter dietary labels and allergens, view item details, choose capacity-limited 30-minute pickup windows or campus delivery, receive status alerts and ready-time estimates, and review completed orders.
- **Stall owner:** create a stall account, set opening hours, typical prep time, per-window pickup limits, and stock counts, feature one available item for 24 hours, upload optional JPG/PNG/WebP menu photos (up to 2 MB each), disclose dietary/allergen information, edit items, accept orders, assign delivery orders to a runner, read customer feedback, and review anonymous stall and product detail views alongside item order counts.
- **Campus runner:** see assigned runs and update pickup and delivery progress.
- **Administrator:** pause or resume stalls, review campus activity, and pause or resume ordering.

Customers can open public stall links and browse menus before signing in; a customer account is required to place an order. Stall owners can copy or share a direct link to their public stall page from the stall workspace. View statistics count each browser once per stall or product per day, with request limits to discourage fake submissions; they do not store account identifiers. Admins can open **Data & reports**, filter daily activity to 7, 30, or 90 days or all recorded dates, and download aggregate CSV data without buyer names, emails, or delivery locations. Completed order value includes orders marked completed; payment is not separately verified. Stall and product comparisons are all-time totals. Customers, stall owners, and runners can create accounts from the role chooser. Stall owners can self-register; their stalls appear to customers as soon as signup is complete. Administrators can pause a stall if needed, and paused stalls stay hidden until resumed. Administrator accounts are deliberately not available through public signup. Create one from PowerShell with:

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
