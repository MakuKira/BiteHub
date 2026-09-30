# BiteHub local prototype

BiteHub now runs as a Python web server with a persistent SQLite database. The browser does not store accounts, menu data, or orders in `localStorage`.

## Start the server

Open PowerShell in this folder and run:

```powershell
.\start.ps1
```

The launcher uses Python 3 from your system, or the Python runtime bundled with Codex when available. Open [http://127.0.0.1:8000](http://127.0.0.1:8000). Keep the terminal open while using the site; press `Ctrl+C` to stop it.

The database is created as `bitehub.sqlite3` in this folder. It survives server restarts and is excluded from source control. To put the database somewhere else, set the `BITEHUB_DB` environment variable before starting the server.

## Account types

- **Campus customer:** browse menus, place pickup or delivery orders, and track updates.
- **Stall owner:** create a stall, post menu items, change availability, accept orders, and assign delivery orders to a runner.
- **Campus runner:** see assigned runs and update pickup and delivery progress.
- **Administrator:** review campus activity and pause or resume ordering.

Customers, stall owners, and runners can create accounts from the sign-in page. Administrator accounts are deliberately not available through public signup. Create one from PowerShell with:

```powershell
.\start.ps1 --create-admin
```

The command prompts for an email, name, and password. Admin passwords and all account passwords are salted and hashed by the server. To start using the site afterward, run `.\start.ps1` in a separate PowerShell window.

## Prototype notes

The database schema is created automatically the first time the server starts. New installations start with an empty menu: register an owner account, add menu items, then register customer and runner accounts to work through the order flow. There are no seeded accounts or sample orders.

This is intended for a trusted local prototype. The built-in HTTP server is not an internet-facing production deployment; use a production application server, HTTPS, backups, and an institutional identity provider before exposing real accounts or student data.

## Free Render deployment

The included `render.yaml` can deploy BiteHub on Render's free web service. Push this folder to GitHub, create a new Render Blueprint, and select the repository. The free service does not include a persistent disk, so the SQLite database may reset when the service restarts or redeploys. Use a paid persistent disk or a hosted PostgreSQL database before relying on it for real accounts or orders.
