# BiteHub + Supabase development setup

This folder contains BiteHub's Supabase database setup. The schema migration has been applied to **BiteHub-Dev** and **MakuKira's Project** (Production). The synthetic demo seed was applied only to BiteHub-Dev. No local SQLite data was uploaded, Production has no demo orders, and existing Supabase `public` tables were left untouched.

## What this prepares

- A private `bitehub_app` PostgreSQL baseline schema matching the BiteHub backend: PNS schools, owner/admin accounts, sessions, stalls, products, guest and legacy account orders, order items, feedback, delivery positions, push subscriptions, settings, and view counts. The baseline contains 13 tables with RLS enabled on every table.
- The `202610300002_guest_sessions.sql` migration, applied successfully to BiteHub-Dev and Production. It creates temporary guest sessions with generated IDs, private hashed cookie tokens, and links from guest orders, with RLS enabled.
- An optional `202610300001_email_auth.sql` migration for future email verification and password reset. It is not required for stall owners to sign in; BiteHub currently accepts any properly formatted email without sending a verification email.
- A separate schema because the existing Supabase `public` schema already contains older `stalls`, `orders`, `order_items`, `menu_items`, `payments`, and `profiles` tables. Those use UUID IDs and Supabase Auth policies; the current Python app uses SQLite integer IDs, its own owner sessions, and guest orders. The draft leaves all existing public tables untouched.
- A copy of the unused `school_requests` table found in the local SQLite database, so its rows can be preserved if they matter during a later import.
- Row Level Security enabled on each `bitehub_app` table. Browser `anon`, `authenticated`, and `service_role` have no access to these BiteHub tables. A limited `bitehub_catalog_reader` group can read only approved catalog rows; a separate `bitehub_backend` group is for the Python API. Keep `bitehub_app` out of the Data API's exposed schemas.
- A synthetic menu in `seed.sql`: two demo stalls and six test products, including one sold-out item. The two demo owner accounts use unusable password hashes and cannot sign in. No fake order or real person is added.

## Current application status

`server.py` now supports PostgreSQL through Psycopg while retaining SQLite as the default for local development. Set the private `BITEHUB_DATABASE_URL` environment variable on the Python backend to use Supabase. The connection must use a login role that inherits `bitehub_backend`; the migration's group role itself cannot log in. No connection string or database password is stored in this repository.

Stall accounts are stored in `bitehub_app.users`; passwords are salted and hashed by the Python backend, never stored as plain text. Active sign-in sessions are in `bitehub_app.sessions`. Guest browsing creates a `bitehub_app.guest_sessions` row with a generated ID and name; the HTTP-only session token is hashed before storage. Guest orders are linked to that session. Password-reset email delivery is deferred until an email domain and provider are configured.

The original Production project contains older public tables. Their access model does not directly match BiteHub's Python cookie sessions or guest orders. The new `bitehub_app` schema stays separate and does not alter those tables.

The Python routes remain the authorization boundary and must continue enforcing account roles and order ownership. The backend group policy allows the trusted server full access by design. The customer-facing website and mobile app must never receive a database password or connect directly to PostgreSQL.

## Supabase project setup status

1. **Done:** created and verified separate development and Production Supabase projects.
2. **Done:** applied the schema to both projects. The SQL Editor verified the Production schema, 13 tables, and the two no-login permission roles; existing `public` tables remain untouched.
3. **Done:** loaded synthetic demo stalls/products into BiteHub-Dev only. Production has no demo orders or imported student records.
4. **Done:** created `bitehub_api_login` and granted it `bitehub_backend` in each project. Keep each project's password private; it is not stored in Git or this repository.
5. **Done:** applied `202610300002_guest_sessions.sql` to BiteHub-Dev and Production; Supabase SQL Editor returned success for both.
6. **In progress:** `BITEHUB_DATABASE_URL` and `BITEHUB_REQUIRE_POSTGRES=true` are present in Render's Production service. The masked database URL still needs confirmation that it points to MakuKira's Production project.
7. Deploy the prepared code after verifying the Render database URL. Confirm the service starts on PostgreSQL, then test owner signup and login, guest continuation, guest order creation, and role/ownership checks; verify rows in `users`, `sessions`, `guest_sessions`, and `orders`.
8. Back up the SQLite file and decide which real records to migrate only after a field mapping and duplicate review. Keep photos in private/policy-controlled object storage long term.

## Data model notes

- Money remains integer cents to avoid rounding errors.
- Guest name, school role, grade, and section live on the order; guest orders do not need a customer account.
- Each guest browse session has its own generated ID and a temporary database row. The guest cookie token is not stored in plaintext.
- Owner accounts keep the current backend-managed password hash fields for this first compatibility step. A later auth decision can move owner authentication to Supabase Auth.
- Photos stay as `bytea` for compatibility in this schema draft; Supabase Storage is the better next step for menu and profile images.
- `available` is a PostgreSQL boolean. The adapter maps the app's current SQLite SQL and boolean values to PostgreSQL.
- Times use `timestamptz` except session expiry (Unix seconds) and daily view dates. The adapter converts timestamps to ISO strings for the existing JSON responses.
- The schema does not process or verify payments.

## Validation limits

The initial migration and demo seed have been run through Supabase SQL Editor and verified with a read-only catalog query. The local development server connects to BiteHub-Dev through `start-supabase-dev.py`; the Render service needs its own private `BITEHUB_DATABASE_URL` setting.

## Connect the Python backend

The database is ready, but the app will remain on SQLite until the Python server gets a private PostgreSQL connection string. The role password is a credential: create it directly in Supabase and save it only in the backend host's private environment. Do not paste it into BiteHub source files, Git, or chat.

```sql
CREATE ROLE bitehub_api_login LOGIN PASSWORD '<choose a strong private password>' NOSUPERUSER NOBYPASSRLS;
GRANT bitehub_backend TO bitehub_api_login;
```

In Supabase, open **Connect** and choose a database connection string. For direct mode, use `bitehub_api_login` as the username. For session-pooler mode, use `bitehub_api_login.<project-ref>` as the username and keep the pooler host and port shown by Supabase. URL-encode reserved password characters if the string requires it. Supabase recommends a direct connection for a persistent backend on IPv6 (or with the IPv4 add-on), and session mode when the host is IPv4-only.

Add the resulting string as `BITEHUB_DATABASE_URL` in the private environment settings of the Render service that runs `server.py`. Use BiteHub-Dev only for a development or staging service; use a production Supabase project for the public service. The app uses the `bitehub_app` schema automatically. Restart or redeploy that backend after saving the variable. Do not expose this variable to Vercel frontend code, the website, or the mobile app. The Render Blueprint declares this as an unsynced secret and sets `BITEHUB_REQUIRE_POSTGRES=true`, so the deployed service fails clearly if the database connection is missing instead of using its local SQLite file.
