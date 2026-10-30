# BiteHub · Palawan National School

BiteHub is a food ordering hub for the Palawan National School (PNS) community. Students, teachers, staff, and other PNS community members can order as guests; stall owners register their PNS stall. The Python server uses SQLite locally by default, or Supabase PostgreSQL when `BITEHUB_DATABASE_URL` is configured on the server.

## Start the server

Open PowerShell in this folder and run:

```powershell
.\start.ps1
```

The launcher uses Python 3 from your system, or the Python runtime bundled with Codex when available. Open [http://127.0.0.1:8000](http://127.0.0.1:8000). Keep the terminal open while using the site; press `Ctrl+C` to stop it.

The database is created as `bitehub.sqlite3` in this folder. It survives server restarts and is excluded from source control. To put the database somewhere else, set the `BITEHUB_DB` environment variable before starting the server. New signups and the customer facing menu are limited to Palawan National School.

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

- **Guest customer:** browse a stall-balanced rotating catalog, see daily featured PNS picks, explore one stall at a time, filter dietary labels and allergens, view item details, choose pickup or PNS delivery, receive status alerts and ready-time estimates, and review completed orders through a private guest link. A customer account is not required.
- **PNS stall owner:** create a stall account for a named stall, set opening hours, typical prep time, pickup limits, and stock counts, feature one available item for 24 hours, upload optional JPG/PNG/WebP menu photos (up to 2 MB each), disclose dietary/allergen information, edit items, accept orders, assign delivery orders by typing a runner’s name, offer pickup when no runner is available, read customer feedback, and review anonymous stall and product detail views alongside item order counts.
- **PNS administrator:** pause or resume PNS stalls, review PNS activity, and pause or resume ordering.

Delivery assignments do not require a runner account. The stall owner enters the runner’s name, marks the order on the way, and confirms delivery. If no runner is available, the customer can choose pickup at the stall or cancel the order. Existing runner accounts from earlier versions can still finish orders already assigned to them.

PNS community members can browse and order as guests; delivery orders collect the guest's name, school role, grade, and section. Stall owners can copy or share a direct link to their public PNS stall page from the stall workspace. View statistics count each browser once per stall or product per day, with request limits to discourage fake submissions; they do not store account identifiers. Admins can open **Data & reports**, filter daily activity to 7, 30, or 90 days or all recorded dates, and download aggregate CSV data without buyer names, emails, or delivery locations. Completed order value includes orders marked completed; payment is not separately verified. Stall and product comparisons are all-time totals. Stall owners can self-register; their PNS stalls appear to guests as soon as signup is complete. Administrators can pause a stall if needed, and paused stalls stay hidden until resumed. Administrator accounts are deliberately not available through public signup. Create one from PowerShell with:

```powershell
.\start.ps1 --create-admin
```

The command prompts for an email, name, and password. Admin passwords and all account passwords are salted and hashed by the server. To start using the site afterward, run `.\start.ps1` in a separate PowerShell window.

### Stall account sign-in and guest records

Stall owners can sign up with any properly formatted email address and sign in right away; BiteHub does not send a verification email. The account row is stored in Supabase `users`, its salted password hash is stored instead of the raw password, and the active sign-in session is stored in `sessions`.

Choosing **Browse stalls** as a guest creates a temporary `guest_sessions` row with a generated ID and the guest's name. A private, HTTP-only cookie identifies that guest session; PostgreSQL stores only the cookie's hash. Guest orders keep their existing guest details and link to that guest session. Expired guest sessions are cleaned up after 30 days.

To send these records to Supabase, Render must use `BITEHUB_REQUIRE_POSTGRES=true` and a private `BITEHUB_DATABASE_URL` pointing to the intended Supabase project. The baseline `bitehub_app` schema and `202610300002_guest_sessions.sql` migration are applied to BiteHub-Dev and Production. Render's database URL is masked and still needs its target project verified before deployment. The email provider and optional `202610300001_email_auth.sql` migration are deferred; password-reset emails are not available yet.

## Supabase development database

The `supabase/` folder contains BiteHub's PostgreSQL baseline and guest-session migration, applied to both **BiteHub-Dev** and **MakuKira's Project** (Production). Both have a separate private `bitehub_app` schema with row-level security; the synthetic test catalog is loaded into BiteHub-Dev only. Production has no demo orders or imported student records, and the older Supabase `public` tables remain untouched.

The app now has a PostgreSQL adapter, but it continues to use SQLite until the backend environment contains `BITEHUB_DATABASE_URL`. Never put this connection string in `app.js`, HTML, mobile code, or any other browser-delivered file. Create the private `bitehub_api_login` role in Supabase by following `supabase/README.md`, then put its connection string in the Python backend's private environment. Use Supabase's direct connection if the host supports IPv6, or the shared **session** pooler for an IPv4-only host. The app uses the `bitehub_app` schema and keeps the existing SQLite mode as the local fallback.

No local SQLite accounts or orders have been copied to Supabase. Keep the connection string and role password out of Git, screenshots, and chat.

## Prototype notes

Local SQLite installations create their schema automatically and start with an empty menu. The Supabase **development** project has synthetic demo stalls and products so the catalog can be explored once the Python server is connected. The demo owner records cannot sign in, and no sample orders are present.

This is intended for a trusted local prototype. The built-in HTTP server is not an internet-facing production deployment; use a production application server, HTTPS, backups, and an institutional identity provider before exposing real accounts or student data.

## Capacity and production readiness

The SQLite schema can store 20,000 accounts, but this prototype is not certified for 20,000 simultaneous users. Background order checks are staggered and fetch only order data, but 20,000 active sessions would still generate hundreds of requests per second. Supabase PostgreSQL support is prepared for development; before a campus-wide launch, connect the backend with its private database role, review account/order authorization on the PostgreSQL path, add backups and monitoring, then run a staged load test at the expected peak. The free Render service is not a production capacity target.

## Free Render deployment

The included `render.yaml` can deploy BiteHub on Render's free web service. Push this folder to GitHub, create a new Render Blueprint, and select the repository. The free service does not include a persistent disk, so local SQLite data may reset when the service restarts or redeploys. Configure `BITEHUB_DATABASE_URL` as a private environment variable on the Python backend to use Supabase; do not expose it to the website or mobile app.
