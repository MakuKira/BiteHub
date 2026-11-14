#!/usr/bin/env python3
"""BiteHub server with local SQLite and optional Supabase PostgreSQL support."""
from __future__ import annotations

import argparse
import atexit
import base64
import binascii
import gzip
import hashlib
import hmac
from html import escape as html_escape
import json
import math
import mimetypes
import os
import re
import secrets
import sqlite3
import ssl
import sys
import time
import threading
from collections import deque
import urllib.error
import urllib.request
from datetime import date, datetime, time as clock_time, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, unquote, urlparse

BASE = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("BITEHUB_DB", BASE / "bitehub.sqlite3"))
DATABASE_URL = os.environ.get("BITEHUB_DATABASE_URL", "").strip()
REQUIRE_POSTGRES = os.environ.get("BITEHUB_REQUIRE_POSTGRES", "").strip().lower() in {"1", "true", "yes"}
REQUIRE_VAPID_SECRET = os.environ.get("BITEHUB_REQUIRE_VAPID_SECRET", "").strip().lower() in {"1", "true", "yes"}
ORDER_MESSAGES_AVAILABLE = not bool(DATABASE_URL)
GUEST_PUSH_AVAILABLE = not bool(DATABASE_URL)
ORDER_CANCELLATION_AVAILABLE = not bool(DATABASE_URL)
GUEST_FEEDBACK_AVAILABLE = not bool(DATABASE_URL)
NOTIFICATION_INBOX_AVAILABLE = not bool(DATABASE_URL)
WEEKLY_MENU_AVAILABLE = not bool(DATABASE_URL)
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "").strip()
BITEHUB_EMAIL_FROM = os.environ.get("BITEHUB_EMAIL_FROM", "").strip()
BITEHUB_PUBLIC_URL = (os.environ.get("BITEHUB_PUBLIC_URL", "") or
                      os.environ.get("RENDER_EXTERNAL_URL", "")).strip().rstrip("/")
EMAIL_VERIFY_SECONDS = 60 * 60 * 24
PASSWORD_RESET_SECONDS = 60 * 60
SESSION_SECONDS = 60 * 60 * 24 * 14
GUEST_SESSION_SECONDS = 60 * 60 * 24 * 30
PBKDF2_ROUNDS = 310_000
ROLES = {"buyer", "owner", "runner", "admin"}
MAX_BODY = 3 * 1024 * 1024
MAX_PRODUCT_PHOTO_BYTES = 2 * 1024 * 1024
PICKUP_SLOT_MINUTES = 30
# Manila stays on UTC+8 year-round. Use the fixed offset so Windows Python
# installations do not need a separate IANA time-zone database package.
CAMPUS_ZONE = timezone(timedelta(hours=8), "Asia/Manila")
DIETARY_TAGS = {"vegetarian", "vegan", "halal", "gluten-free", "dairy-free", "nut-free"}
ALLERGEN_TAGS = {"peanuts", "tree-nuts", "milk", "eggs", "soy", "wheat", "fish", "shellfish", "sesame"}
PHILIPPINES_BOUNDS = {"south": 4.0, "north": 22.5, "west": 115.0, "east": 128.0}
DEFAULT_DELIVERY_RADIUS_METERS = 1500
PILOT_SCHOOLS = {
    "pns": {"name": "Palawan National School", "type": "Secondary school", "region": "MIMAROPA Region", "province": "Palawan", "city": "Puerto Princesa City", "latitude": 9.738599, "longitude": 118.738974, "radius": DEFAULT_DELIVERY_RADIUS_METERS},
}
# Geographic bounds printed on the georeferenced PNS campus map raster.
PNS_MAP_BOUNDS = {"south": 9.736753, "north": 9.740445, "west": 118.737108, "east": 118.740839}
REACH_COOKIE_SECONDS = 60 * 60 * 24 * 365
_rate_limit_lock = threading.Lock()
_rate_limit_events = {}
_rate_limit_calls = 0
_postgres_pool = None
_postgres_pool_lock = threading.Lock()
try:
    import psycopg as _psycopg
except ImportError:
    _psycopg = None

try:
    from webauthn import (
        base64url_to_bytes,
        generate_authentication_options,
        generate_registration_options,
        options_to_json,
        verify_authentication_response,
        verify_registration_response,
    )
    from webauthn.helpers.structs import (
        AuthenticatorSelectionCriteria,
        PublicKeyCredentialDescriptor,
        ResidentKeyRequirement,
        UserVerificationRequirement,
    )
    WEBAUTHN_AVAILABLE = True
except ImportError:
    WEBAUTHN_AVAILABLE = False

PASSKEYS_AVAILABLE = WEBAUTHN_AVAILABLE and not bool(DATABASE_URL)
WEBAUTHN_RP_ID = os.environ.get("BITEHUB_WEBAUTHN_RP_ID", "").strip().lower()
WEBAUTHN_ORIGIN = os.environ.get("BITEHUB_WEBAUTHN_ORIGIN", "").strip().rstrip("/")


class _PostgresRow:
    """Small row adapter that keeps SQLite's name and numeric indexing behavior."""

    def __init__(self, columns, values):
        self._columns = tuple(columns)
        self._values = tuple(_legacy_db_value(value) for value in values)
        self._mapping = dict(zip(self._columns, self._values))

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        return self._mapping[key]

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)

    def keys(self):
        return self._mapping.keys()

    def get(self, key, default=None):
        return self._mapping.get(key, default)


def _legacy_db_value(value):
    if isinstance(value, datetime):
        return value.isoformat(timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    return value


def _postgres_parameter(value):
    if isinstance(value, str) and re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})",
        value,
    ):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value
    return value


def _postgres_sql(sql):
    sql = re.sub(
        r"\bdate\(\s*o\.created_at\s*,\s*'\+8 hours'\s*\)",
        "(o.created_at AT TIME ZONE 'Asia/Manila')::date",
        sql,
        flags=re.IGNORECASE,
    )
    sql = re.sub(
        r"\b([A-Za-z_][A-Za-z0-9_]*\.)?available\s*=\s*1\b",
        lambda match: f"{match.group(1) or ''}available = TRUE",
        sql,
        flags=re.IGNORECASE,
    )
    sql = re.sub(
        r"\bproduct_id\s+IS\s+\?",
        "product_id IS NOT DISTINCT FROM %s",
        sql,
        flags=re.IGNORECASE,
    )
    sql = re.sub(r"\bBEGIN\s+IMMEDIATE\b", "BEGIN", sql, flags=re.IGNORECASE)
    sql = sql.replace("?", "%s")
    sql = re.sub(
        r"\bMIN\(\s*1000000\s*,\s*stock_count\s*\+\s*%s\s*\)",
        "LEAST(1000000, stock_count + %s)",
        sql,
        flags=re.IGNORECASE,
    )
    return sql


class _PostgresCursor:
    def __init__(self, cursor):
        self._cursor = cursor

    @property
    def rowcount(self):
        return self._cursor.rowcount

    def _row(self, values):
        if values is None:
            return None
        columns = [column.name for column in self._cursor.description]
        return _PostgresRow(columns, values)

    def fetchone(self):
        return self._row(self._cursor.fetchone())

    def fetchall(self):
        return [self._row(values) for values in self._cursor.fetchall()]

    def __iter__(self):
        for values in self._cursor:
            yield self._row(values)


class _PostgresConnection:
    def __init__(self, pool):
        self._pool = pool
        self._context = None
        self._connection = None

    def __enter__(self):
        self._context = self._pool.connection()
        self._connection = self._context.__enter__()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return self._context.__exit__(exc_type, exc_value, traceback)

    def execute(self, sql, params=()):
        sql = _postgres_sql(sql)
        values = tuple(_postgres_parameter(value) for value in params) if params else None
        try:
            cursor = self._connection.execute(sql, values)
        except Exception as error:
            if _psycopg is not None and isinstance(error, _psycopg.IntegrityError):
                self._connection.rollback()
                raise sqlite3.IntegrityError(str(error)) from error
            raise
        return _PostgresCursor(cursor)


def _get_postgres_pool():
    global _postgres_pool, _psycopg
    if _postgres_pool is not None:
        return _postgres_pool
    with _postgres_pool_lock:
        if _postgres_pool is not None:
            return _postgres_pool
        try:
            import psycopg as driver
            from psycopg_pool import ConnectionPool
        except ImportError as error:
            raise RuntimeError(
                "BITEHUB_DATABASE_URL is set, but PostgreSQL support is missing. "
                "Install the dependencies in requirements.txt."
            ) from error
        _psycopg = driver
        pool_size = max(1, min(12, int(os.environ.get("BITEHUB_DB_POOL_SIZE", "5"))))
        pool = ConnectionPool(
            conninfo=DATABASE_URL,
            min_size=1,
            max_size=pool_size,
            max_lifetime=300,
            max_idle=60,
            timeout=10,
            open=True,
            check=ConnectionPool.check_connection,
            kwargs={
                "autocommit": False,
                "connect_timeout": 10,
                "sslmode": "require",
                "keepalives": 1,
                "keepalives_idle": 10,
                "keepalives_interval": 5,
                "keepalives_count": 3,
                "options": "-c search_path=bitehub_app,public -c statement_timeout=15000",
            },
        )
        try:
            pool.wait(timeout=10)
        except Exception:
            pool.close()
            raise
        _postgres_pool = pool
        atexit.register(pool.close)
        return _postgres_pool


def insert_id(db, sql, params):
    if DATABASE_URL:
        row = db.execute(sql + " RETURNING id", params).fetchone()
        return row[0] if row else None
    return db.execute(sql, params).lastrowid


def connect():
    if DATABASE_URL:
        return _PostgresConnection(_get_postgres_pool())
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA journal_mode = WAL")
    return db


STALL_REGISTRATION_MODES = {"allow_all", "stop_all", "limited"}


def get_stall_registration_mode(db):
    row = db.execute("SELECT value FROM settings WHERE key='stall_registration_mode'").fetchone()
    mode = row["value"] if row else "allow_all"
    return mode if mode in STALL_REGISTRATION_MODES else "allow_all"


def initialize_postgres():
    global ORDER_MESSAGES_AVAILABLE, GUEST_PUSH_AVAILABLE, ORDER_CANCELLATION_AVAILABLE, GUEST_FEEDBACK_AVAILABLE
    global NOTIFICATION_INBOX_AVAILABLE, WEEKLY_MENU_AVAILABLE
    global PASSKEYS_AVAILABLE
    required_tables = (
        "schools", "users", "sessions", "guest_sessions", "stalls", "products", "reach_views",
        "settings", "orders", "order_items", "feedback", "delivery_positions",
        "push_subscriptions", "school_requests",
    )
    placeholders = ",".join("?" for _ in required_tables)
    with connect() as db:
        table_count = db.execute(
            f"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=? AND table_name IN ({placeholders})",
            ("bitehub_app", *required_tables),
        ).fetchone()[0]
        if table_count != len(required_tables):
            raise RuntimeError(
                "Supabase is missing BiteHub's database tables. Apply "
                "supabase/migrations/202610270001_initial_bitehub_schema.sql and "
                "supabase/migrations/202610300002_guest_sessions.sql first."
            )
        guest_session_column = db.execute(
            "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?",
            ("bitehub_app", "orders", "guest_session_id"),
        ).fetchone()[0]
        if not guest_session_column:
            raise RuntimeError(
                "Supabase is missing the guest-session order link. Apply "
                "supabase/migrations/202610300002_guest_sessions.sql first."
            )
        passkey_tables = db.execute(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=? AND table_name IN (?,?)",
            ("bitehub_app", "admin_passkeys", "webauthn_challenges"),
        ).fetchone()[0]
        PASSKEYS_AVAILABLE = WEBAUTHN_AVAILABLE and passkey_tables == 2
        ORDER_MESSAGES_AVAILABLE = bool(db.execute(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=? AND table_name=?",
            ("bitehub_app", "order_messages"),
        ).fetchone()[0])
        GUEST_PUSH_AVAILABLE = bool(db.execute(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=? AND table_name=?",
            ("bitehub_app", "guest_push_subscriptions"),
        ).fetchone()[0])
        ORDER_CANCELLATION_AVAILABLE = bool(db.execute(
            "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?",
            ("bitehub_app", "orders", "buyer_cancelled"),
        ).fetchone()[0])
        GUEST_FEEDBACK_AVAILABLE = bool(db.execute(
            "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=? AND is_nullable='YES'",
            ("bitehub_app", "feedback", "buyer_id"),
        ).fetchone()[0])
        NOTIFICATION_INBOX_AVAILABLE = bool(db.execute(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=? AND table_name=?",
            ("bitehub_app", "notifications"),
        ).fetchone()[0])
        WEEKLY_MENU_AVAILABLE = bool(db.execute(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=? AND table_name=?",
            ("bitehub_app", "weekly_menu_slots"),
        ).fetchone()[0])
        db.execute(
            "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
            ("reach_signing_secret", secrets.token_hex(32)),
        )
        db.execute(
            "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
            ("stall_registration_mode", "allow_all"),
        )
        db.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),))
        db.execute("DELETE FROM guest_sessions WHERE expires_at <= ?", (int(time.time()),))
        db.execute(
            "DELETE FROM delivery_positions WHERE order_id IN "
            "(SELECT id FROM orders WHERE status!='out' OR fulfillment!='delivery')"
        )
        db.execute(
            "UPDATE orders SET runner_tracking_token_hash=NULL,runner_tracking_expires_at=NULL "
            "WHERE status!='out' OR fulfillment!='delivery'"
        )
        db.execute("UPDATE orders SET delivery_lat=NULL,delivery_lon=NULL WHERE status='completed'")
        ensure_active_pickup_codes(db)


def initialize():
    global ORDER_MESSAGES_AVAILABLE, GUEST_PUSH_AVAILABLE, ORDER_CANCELLATION_AVAILABLE, GUEST_FEEDBACK_AVAILABLE
    global NOTIFICATION_INBOX_AVAILABLE, WEEKLY_MENU_AVAILABLE, PASSKEYS_AVAILABLE
    if REQUIRE_POSTGRES and not DATABASE_URL:
        raise RuntimeError(
            "This deployment requires Supabase PostgreSQL. Set the private "
            "BITEHUB_DATABASE_URL environment variable before starting BiteHub."
        )
    if DATABASE_URL:
        initialize_postgres()
        return
    with connect() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
          email_verified INTEGER NOT NULL DEFAULT 1 CHECK(email_verified IN (0,1)),
          role TEXT NOT NULL CHECK(role IN ('buyer','owner','runner','admin')),
          school_id TEXT NOT NULL DEFAULT 'pns', school_region TEXT NOT NULL DEFAULT 'MIMAROPA',
          school_province TEXT NOT NULL DEFAULT 'Palawan', school_city TEXT NOT NULL DEFAULT 'Puerto Princesa',
          school_zip TEXT NOT NULL DEFAULT '5300', grade_section TEXT NOT NULL DEFAULT '',
          profile_photo_data BLOB, profile_photo_type TEXT, profile_photo_version INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS schools (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, school_type TEXT NOT NULL,
          region TEXT NOT NULL, province TEXT NOT NULL, city TEXT NOT NULL,
          latitude REAL, longitude REAL,
          delivery_radius_m INTEGER NOT NULL DEFAULT 1500, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS guest_sessions (
          id INTEGER PRIMARY KEY, guest_name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS guest_sessions_expiry_idx ON guest_sessions(expires_at);
        CREATE TABLE IF NOT EXISTS email_auth_tokens (
          token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset')), expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS email_auth_tokens_user_purpose_idx
          ON email_auth_tokens(user_id,purpose,expires_at);
        CREATE TABLE IF NOT EXISTS stalls (
          id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'approved'
                                                CHECK(status IN ('pending','approved','paused')), opens_at TEXT NOT NULL DEFAULT '00:00',
                                        closes_at TEXT NOT NULL DEFAULT '23:59', prep_minutes INTEGER NOT NULL DEFAULT 15
                                            CHECK(prep_minutes BETWEEN 1 AND 180), pickup_slot_capacity INTEGER NOT NULL DEFAULT 4
                                            CHECK(pickup_slot_capacity BETWEEN 1 AND 100), pickup_lat REAL, pickup_lon REAL,
                                            logo_data BLOB, logo_type TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY, stall_id INTEGER NOT NULL REFERENCES stalls(id) ON DELETE CASCADE,
          name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', ingredients TEXT NOT NULL DEFAULT '', category TEXT NOT NULL,
          price_cents INTEGER NOT NULL CHECK(price_cents > 0), emoji TEXT NOT NULL DEFAULT '🍽️',
                    available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)), stock_count INTEGER
                        CHECK(stock_count IS NULL OR stock_count >= 0), dietary_tags TEXT NOT NULL DEFAULT '[]',
                    allergen_tags TEXT NOT NULL DEFAULT '[]', photo_data BLOB, photo_type TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reach_views (
          id INTEGER PRIMARY KEY, stall_id INTEGER NOT NULL REFERENCES stalls(id) ON DELETE CASCADE,
          product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
          viewed_on TEXT NOT NULL, viewer_key TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS reach_product_daily_viewer_idx
          ON reach_views(stall_id,product_id,viewed_on,viewer_key) WHERE product_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS reach_stall_daily_viewer_idx
          ON reach_views(stall_id,viewed_on,viewer_key) WHERE product_id IS NULL;
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY, value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS admin_passkeys (
          credential_id BLOB PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          credential_public_key BLOB NOT NULL,
          sign_count INTEGER NOT NULL DEFAULT 0,
          transports TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS admin_passkeys_user_idx ON admin_passkeys(user_id);
        CREATE TABLE IF NOT EXISTS webauthn_challenges (
          challenge_token_hash TEXT PRIMARY KEY,
          purpose TEXT NOT NULL CHECK(purpose IN ('register','login')),
          challenge BLOB NOT NULL,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          session_hash TEXT,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS webauthn_challenges_expiry_idx ON webauthn_challenges(expires_at);
        INSERT OR IGNORE INTO settings(key,value) VALUES('ordering_paused','false');
        INSERT OR IGNORE INTO settings(key,value) VALUES('stall_registration_mode','allow_all');
        CREATE TABLE IF NOT EXISTS orders (
          id INTEGER PRIMARY KEY, buyer_id INTEGER REFERENCES users(id),
          stall_id INTEGER NOT NULL REFERENCES stalls(id), runner_id INTEGER REFERENCES users(id),
          fulfillment TEXT NOT NULL CHECK(fulfillment IN ('pickup','delivery')),
          status TEXT NOT NULL CHECK(status IN ('placed','confirmed','preparing','ready','out','completed','declined')),
          total_cents INTEGER NOT NULL, buyer_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, estimated_ready_at TEXT, pickup_at TEXT,
          delivery_lat REAL, delivery_lon REAL, runner_name TEXT NOT NULL DEFAULT '',
          runner_tracking_token_hash TEXT, runner_tracking_expires_at TEXT,
          guest_session_id INTEGER REFERENCES guest_sessions(id) ON DELETE SET NULL,
          pickup_offer_status TEXT NOT NULL DEFAULT 'none' CHECK(pickup_offer_status IN ('none','pending','accepted','declined')),
          guest_name TEXT NOT NULL DEFAULT '', guest_school_role TEXT NOT NULL DEFAULT '',
          guest_grade TEXT NOT NULL DEFAULT '', guest_section TEXT NOT NULL DEFAULT '',
          guest_access_token_hash TEXT NOT NULL DEFAULT '',
          guest_pickup_code TEXT NOT NULL DEFAULT '',
          buyer_cancelled INTEGER NOT NULL DEFAULT 0 CHECK(buyer_cancelled IN (0,1))
        );
        CREATE TABLE IF NOT EXISTS order_items (
          id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
          name TEXT NOT NULL, price_cents INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 50), emoji TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS feedback (
                    order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
          buyer_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
                    comment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS order_messages (
          id INTEGER PRIMARY KEY,
          order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          sender_role TEXT NOT NULL CHECK(sender_role IN ('guest','buyer','owner')),
          sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          sender_name TEXT NOT NULL,
          message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 1000),
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS delivery_positions (
          order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
          latitude REAL NOT NULL, longitude REAL NOT NULL, accuracy REAL, heading REAL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          endpoint TEXT NOT NULL UNIQUE, subscription_json TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS guest_push_subscriptions (
          id INTEGER PRIMARY KEY, guest_session_id INTEGER NOT NULL REFERENCES guest_sessions(id) ON DELETE CASCADE,
          endpoint TEXT NOT NULL UNIQUE, subscription_json TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS notifications (
          id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          guest_session_id INTEGER REFERENCES guest_sessions(id) ON DELETE CASCADE,
          title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '/',
          tag TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, read_at TEXT,
          CHECK ((user_id IS NOT NULL AND guest_session_id IS NULL) OR
                 (user_id IS NULL AND guest_session_id IS NOT NULL))
        );
        CREATE TABLE IF NOT EXISTS weekly_menu_slots (
          id INTEGER PRIMARY KEY, stall_id INTEGER NOT NULL REFERENCES stalls(id) ON DELETE CASCADE,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
          service_period TEXT NOT NULL CHECK(service_period IN ('Morning break','Lunch','Afternoon break')),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(stall_id,product_id,weekday,service_period)
        );
        CREATE INDEX IF NOT EXISTS orders_buyer_idx ON orders(buyer_id, id DESC);
        CREATE INDEX IF NOT EXISTS orders_stall_idx ON orders(stall_id, id DESC);
        CREATE INDEX IF NOT EXISTS orders_runner_idx ON orders(runner_id, id DESC);
        CREATE INDEX IF NOT EXISTS order_messages_order_idx ON order_messages(order_id, id);
        CREATE INDEX IF NOT EXISTS guest_push_subscriptions_session_idx ON guest_push_subscriptions(guest_session_id);
        CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications(user_id,read_at,id DESC);
        CREATE INDEX IF NOT EXISTS notifications_guest_unread_idx ON notifications(guest_session_id,read_at,id DESC);
        CREATE INDEX IF NOT EXISTS weekly_menu_weekday_idx ON weekly_menu_slots(weekday,service_period,stall_id);
        CREATE INDEX IF NOT EXISTS products_stall_idx ON products(stall_id, available);
        CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
        """)
        school_columns = {row["name"]: row for row in db.execute("PRAGMA table_info(schools)")}
        if school_columns["latitude"]["notnull"] or school_columns["longitude"]["notnull"]:
            # School pins are optional during sign-up. Rebuild the legacy table
            # with nullable coordinates while preserving every existing school.
            db.execute("DROP TABLE IF EXISTS schools_optional_location_migration")
            db.execute("""CREATE TABLE schools_optional_location_migration (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, school_type TEXT NOT NULL,
                region TEXT NOT NULL, province TEXT NOT NULL, city TEXT NOT NULL,
                latitude REAL, longitude REAL,
                delivery_radius_m INTEGER NOT NULL DEFAULT 1500, created_at TEXT NOT NULL
            )""")
            db.execute("""INSERT INTO schools_optional_location_migration
                (id,name,school_type,region,province,city,latitude,longitude,delivery_radius_m,created_at)
                SELECT id,name,school_type,region,province,city,latitude,longitude,delivery_radius_m,created_at FROM schools""")
            db.execute("DROP TABLE schools")
            db.execute("ALTER TABLE schools_optional_location_migration RENAME TO schools")
        stall_columns = {row["name"] for row in db.execute("PRAGMA table_info(stalls)")}
        user_columns = {row["name"] for row in db.execute("PRAGMA table_info(users)")}
        for school_id, school in PILOT_SCHOOLS.items():
            db.execute("""INSERT OR IGNORE INTO schools(id,name,school_type,region,province,city,latitude,longitude,delivery_radius_m,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?)""", (school_id,school["name"],school["type"],school["region"],school["province"],school["city"],school["latitude"],school["longitude"],school["radius"],now()))
        for name, declaration in (
            ("school_id", "TEXT NOT NULL DEFAULT 'pns'"),
            ("school_region", "TEXT NOT NULL DEFAULT 'MIMAROPA'"),
            ("school_province", "TEXT NOT NULL DEFAULT 'Palawan'"),
            ("school_city", "TEXT NOT NULL DEFAULT 'Puerto Princesa'"),
            ("school_zip", "TEXT NOT NULL DEFAULT '5300'"),
            ("grade_section", "TEXT NOT NULL DEFAULT ''"),
            ("profile_photo_data", "BLOB"),
            ("profile_photo_type", "TEXT"),
            ("profile_photo_version", "INTEGER NOT NULL DEFAULT 0"),
            ("deleted_at", "TEXT"),
            ("email_verified", "INTEGER NOT NULL DEFAULT 1 CHECK(email_verified IN (0,1))"),
        ):
            if name not in user_columns:
                db.execute(f"ALTER TABLE users ADD COLUMN {name} {declaration}")
        if "status" not in stall_columns:
            db.execute("ALTER TABLE stalls ADD COLUMN status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('pending','approved','paused'))")
        # Stall signup no longer requires an administrator's approval. Make
        # stalls created by older versions visible after this upgrade.
        db.execute("UPDATE stalls SET status='approved' WHERE status='pending'")
        for name, declaration in (
            ("opens_at", "TEXT NOT NULL DEFAULT '00:00'"),
            ("closes_at", "TEXT NOT NULL DEFAULT '23:59'"),
            ("prep_minutes", "INTEGER NOT NULL DEFAULT 15 CHECK(prep_minutes BETWEEN 1 AND 180)"),
            ("pickup_slot_capacity", "INTEGER NOT NULL DEFAULT 4 CHECK(pickup_slot_capacity BETWEEN 1 AND 100)"),
        ):
            if name not in stall_columns:
                db.execute(f"ALTER TABLE stalls ADD COLUMN {name} {declaration}")
        for name, declaration in (("logo_data", "BLOB"), ("logo_type", "TEXT")):
            if name not in stall_columns:
                db.execute(f"ALTER TABLE stalls ADD COLUMN {name} {declaration}")
        for name in ("pickup_lat", "pickup_lon"):
            if name not in stall_columns:
                db.execute(f"ALTER TABLE stalls ADD COLUMN {name} REAL")
        order_columns = {row["name"] for row in db.execute("PRAGMA table_info(orders)")}
        if "estimated_ready_at" not in order_columns:
            db.execute("ALTER TABLE orders ADD COLUMN estimated_ready_at TEXT")
        if "pickup_at" not in order_columns:
            db.execute("ALTER TABLE orders ADD COLUMN pickup_at TEXT")
        if "runner_name" not in order_columns:
            db.execute("ALTER TABLE orders ADD COLUMN runner_name TEXT NOT NULL DEFAULT ''")
        if "runner_tracking_token_hash" not in order_columns:
            db.execute("ALTER TABLE orders ADD COLUMN runner_tracking_token_hash TEXT")
        if "runner_tracking_expires_at" not in order_columns:
            db.execute("ALTER TABLE orders ADD COLUMN runner_tracking_expires_at TEXT")
        if "pickup_offer_status" not in order_columns:
            db.execute("ALTER TABLE orders ADD COLUMN pickup_offer_status TEXT NOT NULL DEFAULT 'none' CHECK(pickup_offer_status IN ('none','pending','accepted','declined'))")
        if "buyer_cancelled" not in order_columns:
            db.execute("ALTER TABLE orders ADD COLUMN buyer_cancelled INTEGER NOT NULL DEFAULT 0 CHECK(buyer_cancelled IN (0,1))")
        for name in ("delivery_lat", "delivery_lon"):
            if name not in order_columns:
                db.execute(f"ALTER TABLE orders ADD COLUMN {name} REAL")
        order_info = {row["name"]: row for row in db.execute("PRAGMA table_info(orders)")}
        for name, declaration in (
            ("guest_name", "TEXT NOT NULL DEFAULT ''"),
            ("guest_school_role", "TEXT NOT NULL DEFAULT ''"),
            ("guest_grade", "TEXT NOT NULL DEFAULT ''"),
            ("guest_section", "TEXT NOT NULL DEFAULT ''"),
            ("guest_access_token_hash", "TEXT NOT NULL DEFAULT ''"),
            ("guest_pickup_code", "TEXT NOT NULL DEFAULT ''"),
            ("guest_session_id", "INTEGER REFERENCES guest_sessions(id) ON DELETE SET NULL"),
        ):
            if name not in order_info:
                db.execute(f"ALTER TABLE orders ADD COLUMN {name} {declaration}")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS orders_guest_pickup_code_idx ON orders(guest_pickup_code) WHERE guest_pickup_code != ''")
        if order_info["buyer_id"]["notnull"]:
            # Guest orders have no user row. Rebuild the legacy orders table so
            # buyer_id can be NULL while every existing order and child row stays.
            db.commit()
            db.execute("PRAGMA foreign_keys = OFF")
            try:
                db.executescript("""
                BEGIN IMMEDIATE;
                CREATE TABLE orders_guest_migration (
                  id INTEGER PRIMARY KEY, buyer_id INTEGER REFERENCES users(id),
                  stall_id INTEGER NOT NULL REFERENCES stalls(id), runner_id INTEGER REFERENCES users(id),
                  fulfillment TEXT NOT NULL CHECK(fulfillment IN ('pickup','delivery')),
                  status TEXT NOT NULL CHECK(status IN ('placed','confirmed','preparing','ready','out','completed','declined')),
                  total_cents INTEGER NOT NULL, buyer_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL, estimated_ready_at TEXT, pickup_at TEXT,
                  delivery_lat REAL, delivery_lon REAL, runner_name TEXT NOT NULL DEFAULT '',
                  runner_tracking_token_hash TEXT, runner_tracking_expires_at TEXT,
                  guest_session_id INTEGER REFERENCES guest_sessions(id) ON DELETE SET NULL,
                  pickup_offer_status TEXT NOT NULL DEFAULT 'none' CHECK(pickup_offer_status IN ('none','pending','accepted','declined')),
                  guest_name TEXT NOT NULL DEFAULT '', guest_school_role TEXT NOT NULL DEFAULT '',
                  guest_grade TEXT NOT NULL DEFAULT '', guest_section TEXT NOT NULL DEFAULT '',
                  guest_access_token_hash TEXT NOT NULL DEFAULT '',
                  guest_pickup_code TEXT NOT NULL DEFAULT '',
                  buyer_cancelled INTEGER NOT NULL DEFAULT 0 CHECK(buyer_cancelled IN (0,1))
                );
                INSERT INTO orders_guest_migration(
                  id,buyer_id,stall_id,runner_id,fulfillment,status,total_cents,buyer_note,created_at,
                  updated_at,estimated_ready_at,pickup_at,delivery_lat,delivery_lon,runner_name,
                  runner_tracking_token_hash,runner_tracking_expires_at,pickup_offer_status,
                  guest_name,guest_school_role,guest_grade,guest_section,guest_access_token_hash,guest_pickup_code,
                  buyer_cancelled
                ) SELECT id,buyer_id,stall_id,runner_id,fulfillment,status,total_cents,buyer_note,created_at,
                  updated_at,estimated_ready_at,pickup_at,delivery_lat,delivery_lon,runner_name,
                  runner_tracking_token_hash,runner_tracking_expires_at,pickup_offer_status,
                  guest_name,guest_school_role,guest_grade,guest_section,guest_access_token_hash,guest_pickup_code,
                  buyer_cancelled FROM orders;
                DROP TABLE orders;
                ALTER TABLE orders_guest_migration RENAME TO orders;
                CREATE INDEX orders_buyer_idx ON orders(buyer_id, id DESC);
                CREATE INDEX orders_stall_idx ON orders(stall_id, id DESC);
                CREATE INDEX orders_runner_idx ON orders(runner_id, id DESC);
                CREATE UNIQUE INDEX orders_guest_pickup_code_idx
                  ON orders(guest_pickup_code) WHERE guest_pickup_code != '';
                CREATE INDEX orders_guest_session_idx ON orders(guest_session_id);
                COMMIT;
                """)
            except Exception:
                db.rollback()
                raise
            finally:
                db.execute("PRAGMA foreign_keys = ON")
        db.execute("CREATE INDEX IF NOT EXISTS orders_guest_session_idx ON orders(guest_session_id)")
        product_columns = {row["name"] for row in db.execute("PRAGMA table_info(products)")}
        for name, declaration in (
            ("stock_count", "INTEGER CHECK(stock_count IS NULL OR stock_count >= 0)"),
            ("featured_until", "TEXT"),
            ("dietary_tags", "TEXT NOT NULL DEFAULT '[]'"),
            ("allergen_tags", "TEXT NOT NULL DEFAULT '[]'"),
            ("photo_data", "BLOB"),
            ("photo_type", "TEXT"),
            ("ingredients", "TEXT NOT NULL DEFAULT ''"),
        ):
            if name not in product_columns:
                db.execute(f"ALTER TABLE products ADD COLUMN {name} {declaration}")
        db.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),))
        db.execute("DELETE FROM email_auth_tokens WHERE expires_at <= ?", (int(time.time()),))
        db.execute("DELETE FROM guest_sessions WHERE expires_at <= ?", (int(time.time()),))
        db.execute("INSERT OR IGNORE INTO settings(key,value) VALUES('reach_signing_secret',?)", (secrets.token_hex(32),))
        # Remove any stale runner locations left by earlier server versions.
        db.execute("DELETE FROM delivery_positions WHERE order_id IN (SELECT id FROM orders WHERE status!='out' OR fulfillment!='delivery')")
        db.execute("UPDATE orders SET runner_tracking_token_hash=NULL,runner_tracking_expires_at=NULL WHERE status!='out' OR fulfillment!='delivery'")
        # Precise handoff coordinates are no longer needed after delivery.
        db.execute("UPDATE orders SET delivery_lat=NULL,delivery_lon=NULL WHERE status='completed'")
        feedback_info = {row["name"]: row for row in db.execute("PRAGMA table_info(feedback)")}
        if feedback_info.get("buyer_id") and feedback_info["buyer_id"]["notnull"]:
            # Guest reviews are still tied to a completed order and its private
            # order token; the nullable user link keeps anonymous reviews safe.
            db.execute("""CREATE TABLE feedback_guest_migration (
                order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
                buyer_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
                comment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
            )""")
            db.execute("""INSERT INTO feedback_guest_migration(order_id,buyer_id,rating,comment,created_at)
                SELECT order_id,buyer_id,rating,comment,created_at FROM feedback""")
            db.execute("DROP TABLE feedback")
            db.execute("ALTER TABLE feedback_guest_migration RENAME TO feedback")
        ensure_active_pickup_codes(db)

    # The SQLite development schema above creates these optional tables and
    # columns. Recompute the capabilities after a Dev process switches away
    # from a PostgreSQL-configured environment; otherwise stale startup flags
    # can leave working SQLite features returning 503.
    PASSKEYS_AVAILABLE = WEBAUTHN_AVAILABLE
    ORDER_MESSAGES_AVAILABLE = True
    GUEST_PUSH_AVAILABLE = True
    ORDER_CANCELLATION_AVAILABLE = True
    GUEST_FEEDBACK_AVAILABLE = True
    NOTIFICATION_INBOX_AVAILABLE = True
    WEEKLY_MENU_AVAILABLE = True


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_pickup_code(db):
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    for _ in range(10):
        code = "".join(secrets.choice(alphabet) for _ in range(8))
        if not db.execute("SELECT 1 FROM orders WHERE guest_pickup_code=?", (code,)).fetchone():
            return code
    raise ApiError(503, "Could not create a unique pickup code. Please try again.")


def ensure_active_pickup_codes(db):
    rows = db.execute("""SELECT id FROM orders
        WHERE fulfillment='pickup' AND status NOT IN ('completed','declined')
          AND COALESCE(guest_pickup_code,'')=''""").fetchall()
    for row in rows:
        code = new_pickup_code(db)
        db.execute("UPDATE orders SET guest_pickup_code=? WHERE id=? AND COALESCE(guest_pickup_code,'')=''",
            (code, row["id"]))


_vapid_cache = None
_vapid_lock = threading.Lock()


def vapid_keys():
    global _vapid_cache
    if _vapid_cache:
        return _vapid_cache
    with _vapid_lock:
        if _vapid_cache:
            return _vapid_cache
        try:
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.asymmetric import ec
            encoded_private_key = os.environ.get("BITEHUB_VAPID_PRIVATE_KEY_B64", "").strip()
            configured_private_path = os.environ.get("BITEHUB_VAPID_PRIVATE_KEY", "").strip()
            if encoded_private_key:
                pem = base64.urlsafe_b64decode(encoded_private_key + "=" * (-len(encoded_private_key) % 4))
                private_key = serialization.load_pem_private_key(pem, password=None)
            elif configured_private_path:
                private_path = Path(configured_private_path)
                private_key = serialization.load_pem_private_key(private_path.read_bytes(), password=None)
            elif REQUIRE_VAPID_SECRET:
                _vapid_cache = (None, None)
                return _vapid_cache
            else:
                private_path = BASE / ".local-certs" / "vapid_private.pem"
                private_path.parent.mkdir(parents=True, exist_ok=True)
                if private_path.exists():
                    private_key = serialization.load_pem_private_key(private_path.read_bytes(), password=None)
                else:
                    private_key = ec.generate_private_key(ec.SECP256R1())
                    private_path.write_bytes(private_key.private_bytes(serialization.Encoding.PEM,
                        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
            if not isinstance(private_key, ec.EllipticCurvePrivateKey) or not isinstance(private_key.curve, ec.SECP256R1):
                _vapid_cache = (None, None)
                print("BiteHub Web Push key must be an EC P-256 private key; device alerts are unavailable.", file=sys.stderr)
                return _vapid_cache
            public_bytes = private_key.public_key().public_bytes(serialization.Encoding.X962,
                serialization.PublicFormat.UncompressedPoint)
            _vapid_cache = (base64.urlsafe_b64encode(public_bytes).decode().rstrip("="), private_key)
        except (ImportError, OSError, TypeError, ValueError, binascii.Error):
            _vapid_cache = (None, None)
            if os.environ.get("BITEHUB_VAPID_PRIVATE_KEY_B64", "").strip() or os.environ.get("BITEHUB_VAPID_PRIVATE_KEY", "").strip():
                print("BiteHub Web Push key could not be loaded; check the Render VAPID secret configuration.", file=sys.stderr)
    return _vapid_cache


def vapid_public_key():
    return vapid_keys()[0]


def push_available():
    public_key, _ = vapid_keys()
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: F401
        return bool(public_key)
    except ImportError:
        return False


def safe_notification_url(value):
    if not isinstance(value, str):
        return "/"
    value = value.strip()
    if (not value.startswith("/") or value.startswith("//") or "\\" in value
            or any(ord(character) < 32 for character in value)):
        return "/"
    return value[:500]


def persist_inbox_notifications(user_ids=(), guest_session_ids=(), payload=None):
    if not NOTIFICATION_INBOX_AVAILABLE:
        return
    payload = payload if isinstance(payload, dict) else {}
    title = str(payload.get("title") or "BiteHub update").strip()[:120]
    body = str(payload.get("body") or "").strip()[:500]
    url = safe_notification_url(payload.get("url"))
    tag = str(payload.get("tag") or "").strip()[:120]
    users = set()
    guests = set()
    for value in user_ids:
        try:
            identifier = int(value)
        except (TypeError, ValueError):
            continue
        if identifier > 0:
            users.add(identifier)
    for value in guest_session_ids:
        try:
            identifier = int(value)
        except (TypeError, ValueError):
            continue
        if identifier > 0:
            guests.add(identifier)
    if not users and not guests:
        return
    try:
        created_at = now()
        with connect() as db:
            for user_id in users:
                db.execute("""INSERT INTO notifications(user_id,guest_session_id,title,body,url,tag,created_at)
                    VALUES(?,NULL,?,?,?,?,?)""", (user_id, title, body, url, tag, created_at))
            for guest_session_id in guests:
                db.execute("""INSERT INTO notifications(user_id,guest_session_id,title,body,url,tag,created_at)
                    VALUES(NULL,?,?,?,?,?,?)""", (guest_session_id, title, body, url, tag, created_at))
    except Exception as error:
        print(f"Could not save BiteHub notification to the inbox: {error}", file=sys.stderr)


def dispatch_push(user_ids, payload):
    user_ids = tuple(set(user_ids))
    persist_inbox_notifications(user_ids=user_ids, payload=payload)
    if not push_available():
        return
    threading.Thread(target=send_push, args=(user_ids, payload), daemon=True).start()


def dispatch_guest_push(guest_session_ids, payload):
    guest_session_ids = tuple(set(guest_session_ids))
    persist_inbox_notifications(guest_session_ids=guest_session_ids, payload=payload)
    if not GUEST_PUSH_AVAILABLE or not push_available():
        return
    threading.Thread(target=send_push, args=((), payload, guest_session_ids), daemon=True).start()


def dispatch_order_buyer_push(user_id, guest_session_id, payload):
    if user_id is not None:
        dispatch_push([user_id], payload)
    elif guest_session_id is not None:
        dispatch_guest_push([guest_session_id], payload)


def send_push(user_ids, payload, guest_session_ids=()):
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF, HKDFExpand
        from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
        _, private_key = vapid_keys()
        if private_key is None:
            return
        public_bytes = private_key.public_key().public_bytes(serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint)
        public_token = base64.urlsafe_b64encode(public_bytes).decode().rstrip("=")
        subject = os.environ.get("BITEHUB_VAPID_SUBJECT", "").strip() or BITEHUB_PUBLIC_URL or "mailto:bitehub-notifications@example.com"
        with connect() as db:
            subscriptions = [(row, "user") for row in db.execute(
                "SELECT id,endpoint,subscription_json FROM push_subscriptions WHERE user_id IN (%s)" %
                ",".join("?" for _ in user_ids), user_ids).fetchall()] if user_ids else []
            if guest_session_ids and GUEST_PUSH_AVAILABLE:
                subscriptions.extend((row, "guest") for row in db.execute(
                    "SELECT id,endpoint,subscription_json FROM guest_push_subscriptions WHERE guest_session_id IN (%s)" %
                    ",".join("?" for _ in guest_session_ids), guest_session_ids).fetchall())
        for subscription, subscription_kind in subscriptions:
            try:
                info = json.loads(subscription["subscription_json"])
                endpoint = info["endpoint"]
                parsed = urlparse(endpoint)
                ua_public = base64.urlsafe_b64decode(info["keys"]["p256dh"] + "=" * (-len(info["keys"]["p256dh"]) % 4))
                auth_secret = base64.urlsafe_b64decode(info["keys"]["auth"] + "=" * (-len(info["keys"]["auth"]) % 4))
                ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
                ephemeral = ec.generate_private_key(ec.SECP256R1())
                server_public = ephemeral.public_key().public_bytes(serialization.Encoding.X962,
                    serialization.PublicFormat.UncompressedPoint)
                shared = ephemeral.exchange(ec.ECDH(), ua_key)
                ikm = HKDF(algorithm=hashes.SHA256(), length=32, salt=auth_secret,
                    info=b"WebPush: info\x00" + ua_public + server_public).derive(shared)
                salt = secrets.token_bytes(16)
                prk = hmac.new(salt, ikm, hashlib.sha256).digest()
                cek = HKDFExpand(algorithm=hashes.SHA256(), length=16,
                    info=b"Content-Encoding: aes128gcm\x00").derive(prk)
                nonce = HKDFExpand(algorithm=hashes.SHA256(), length=12,
                    info=b"Content-Encoding: nonce\x00").derive(prk)
                encrypted = AESGCM(cek).encrypt(nonce, json.dumps(payload, separators=(",", ":")).encode() + b"\x02", None)
                body = salt + (4096).to_bytes(4, "big") + bytes([len(server_public)]) + server_public + encrypted
                audience = f"{parsed.scheme}://{parsed.netloc}"
                jwt_header = {"typ": "JWT", "alg": "ES256"}
                jwt_claims = {"aud": audience, "exp": int(time.time()) + 12 * 60 * 60, "sub": subject}
                encode_part = lambda value: base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")
                unsigned = f"{encode_part(jwt_header)}.{encode_part(jwt_claims)}"
                der = private_key.sign(unsigned.encode(), ec.ECDSA(hashes.SHA256()))
                r_value, s_value = decode_dss_signature(der)
                signature = r_value.to_bytes(32, "big") + s_value.to_bytes(32, "big")
                jwt = unsigned + "." + base64.urlsafe_b64encode(signature).decode().rstrip("=")
                request = urllib.request.Request(endpoint, data=body, method="POST", headers={
                    "Authorization": f"vapid t={jwt}, k={public_token}", "TTL": "60",
                    "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
                    "Content-Length": str(len(body))})
                with urllib.request.urlopen(request, timeout=10) as response:
                    response.read(1)
            except urllib.error.HTTPError as error:
                if error.code in (404, 410):
                    with connect() as db:
                        table = "guest_push_subscriptions" if subscription_kind == "guest" else "push_subscriptions"
                        db.execute(f"DELETE FROM {table} WHERE id=?", (subscription["id"],))
                else:
                    print(f"BiteHub Web Push delivery returned HTTP {error.code}.", file=sys.stderr)
            except Exception as error:
                print(f"BiteHub Web Push delivery failed ({type(error).__name__}).", file=sys.stderr)
    except ImportError:
        return


def cents(value):
    try:
        amount = Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        raise ValueError("Enter a valid price.")
    if amount <= 0 or amount > Decimal("1000000"):
        raise ValueError("Price must be greater than zero and no more than ₱1,000,000.")
    return int(amount * 100)


def password_digest(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS).hex()


def email_delivery_ready():
    return bool(RESEND_API_KEY and BITEHUB_EMAIL_FROM and BITEHUB_PUBLIC_URL)


def create_email_auth_token(db, user_id, purpose, lifetime):
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
    db.execute("DELETE FROM email_auth_tokens WHERE expires_at<=?", (int(time.time()),))
    db.execute("DELETE FROM email_auth_tokens WHERE user_id=? AND purpose=?", (user_id, purpose))
    db.execute("INSERT INTO email_auth_tokens(token_hash,user_id,purpose,expires_at,created_at) VALUES(?,?,?,?,?)",
               (token_hash, user_id, purpose, int(time.time()) + lifetime, now()))
    return token, token_hash


def send_account_email(recipient, subject, heading, message, button_label, query_key, token, token_hash):
    if not email_delivery_ready():
        raise ApiError(503, "Email delivery is not set up yet. Please try again later.")
    public_url = urlparse(BITEHUB_PUBLIC_URL)
    is_local_http = public_url.scheme == "http" and public_url.hostname in {"localhost", "127.0.0.1", "::1"}
    if not public_url.hostname or (public_url.scheme != "https" and not is_local_http):
        raise ApiError(503, "BiteHub's public website address must use HTTPS before account emails can be sent.")
    link = f"{BITEHUB_PUBLIC_URL}/?{urlencode({query_key: token})}"
    safe_heading = html_escape(heading)
    safe_message = html_escape(message)
    safe_button = html_escape(button_label)
    safe_link = html_escape(link, quote=True)
    html_body = ("<!doctype html><html><body style=\"margin:0;background:#fff8ee;font-family:Arial,sans-serif;color:#33251f\">"
        "<main style=\"max-width:520px;margin:32px auto;padding:30px;background:#fff;border:1px solid #f2d6a7;border-radius:18px\">"
        "<p style=\"margin:0 0 20px;color:#be3027;font-weight:700;letter-spacing:.08em\">BITEHUB · PNS FOOD MARKET</p>"
        f"<h1 style=\"font-size:26px;margin:0 0 12px\">{safe_heading}</h1>"
        f"<p style=\"font-size:16px;line-height:1.6\">{safe_message}</p>"
        f"<p style=\"margin:26px 0\"><a href=\"{safe_link}\" style=\"display:inline-block;padding:14px 22px;border-radius:10px;background:#c92c24;color:#fff;text-decoration:none;font-weight:700\">{safe_button}</a></p>"
        "<p style=\"font-size:13px;line-height:1.6;color:#6c625b\">If you did not request this, you can ignore this email. This link can only be used once and will expire.</p>"
        "</main></body></html>")
    text_body = f"{heading}\n\n{message}\n\n{button_label}: {link}\n\nIf you did not request this, you can ignore this email. The link can only be used once and will expire."
    payload = json.dumps({"from": BITEHUB_EMAIL_FROM, "to": [recipient], "subject": subject,
        "html": html_body, "text": text_body}, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request("https://api.resend.com/emails", data=payload, method="POST", headers={
        "Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json",
        "Idempotency-Key": token_hash,
    })
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            if response.status < 200 or response.status >= 300:
                raise ApiError(502, "BiteHub could not send the email right now. Please try again later.")
            response.read(1024)
    except urllib.error.HTTPError as error:
        # Never log message bodies or recipient data from the mail provider.
        sys.stderr.write(f"BiteHub email provider returned HTTP {error.code}.\n")
        raise ApiError(502, "BiteHub could not send the email right now. Please try again later.") from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        sys.stderr.write(f"BiteHub email delivery connection failed ({type(error).__name__}).\n")
        raise ApiError(502, "BiteHub could not send the email right now. Please try again later.") from None


def clean_text(value, label, max_length, required=True):
    text = str(value or "").strip()
    if required and not text:
        raise ValueError(f"{label} is required.")
    if len(text) > max_length:
        raise ValueError(f"{label} must be {max_length} characters or fewer.")
    return text


def parse_stock_count(value):
    if value in (None, ""):
        return None
    if isinstance(value, bool):
        raise ValueError("Stock must be a whole number of zero or more.")
    try:
        quantity = int(value)
    except (TypeError, ValueError):
        raise ValueError("Stock must be a whole number of zero or more.")
    if str(quantity) != str(value).strip() or quantity < 0 or quantity > 1000000:
        raise ValueError("Stock must be a whole number from zero to 1,000,000.")
    return quantity


def parse_product_photo(encoded, media_type, label="food photo"):
    if not isinstance(encoded, str) or not isinstance(media_type, str):
        raise ValueError(f"Choose a JPG, PNG, or WebP {label}.")
    if len(encoded) > ((MAX_PRODUCT_PHOTO_BYTES + 2) // 3) * 4:
        raise ValueError(f"Images must be 2 MB or smaller.")
    try:
        photo = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("That image could not be read. Please choose it again.")
    if not photo or len(photo) > MAX_PRODUCT_PHOTO_BYTES:
        raise ValueError("Images must be between 1 byte and 2 MB.")
    signatures = {
        "image/jpeg": photo.startswith(b"\xff\xd8\xff"),
        "image/png": photo.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/webp": len(photo) >= 12 and photo.startswith(b"RIFF") and photo[8:12] == b"WEBP",
    }
    if media_type not in signatures or not signatures[media_type]:
        raise ValueError(f"Choose a valid JPG, PNG, or WebP {label}.")
    return photo, media_type


def parse_tags(value, allowed, label):
    if not isinstance(value, list) or len(value) > len(allowed):
        raise ValueError(f"Choose valid {label.lower()}.")
    if any(not isinstance(tag, str) or tag not in allowed for tag in value):
        raise ValueError(f"Choose valid {label.lower()}.")
    return list(dict.fromkeys(value))


def parse_hours(opens_at, closes_at):
    for value, label in ((opens_at, "Opening time"), (closes_at, "Closing time")):
        if not isinstance(value, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
            raise ValueError(f"{label} must use 24-hour HH:MM format.")
    if opens_at == closes_at:
        raise ValueError("Opening and closing times must be different.")
    return opens_at, closes_at


def campus_point(latitude, longitude, label="Location", school=None):
    try:
        latitude, longitude = float(latitude), float(longitude)
    except (TypeError, ValueError):
        raise ValueError(f"Choose {label.lower()} on the school map.")
    if not math.isfinite(latitude) or not math.isfinite(longitude):
        raise ValueError(f"Choose {label.lower()} on the school map.")
    if not PHILIPPINES_BOUNDS["south"] <= latitude <= PHILIPPINES_BOUNDS["north"] or not PHILIPPINES_BOUNDS["west"] <= longitude <= PHILIPPINES_BOUNDS["east"]:
        raise ValueError(f"{label} must be in the Philippines.")
    if school and school.get("school_id") == "pns" and not (
            PNS_MAP_BOUNDS["south"] <= latitude <= PNS_MAP_BOUNDS["north"] and
            PNS_MAP_BOUNDS["west"] <= longitude <= PNS_MAP_BOUNDS["east"]):
        raise ValueError(f"{label} must be inside the PNS campus map area.")
    if not school:
        raise ValueError("Your school location is missing. Sign in again or contact your school administrator.")
    school_lat = school.get("school_latitude")
    school_lon = school.get("school_longitude")
    try:
        school_lat, school_lon = float(school_lat), float(school_lon)
        radius = float(school.get("delivery_radius_m") or DEFAULT_DELIVERY_RADIUS_METERS)
    except (TypeError, ValueError):
        raise ValueError("Your school map location has not been set.")
    lat1, lat2 = math.radians(school_lat), math.radians(latitude)
    dlat, dlon = lat2-lat1, math.radians(longitude-school_lon)
    haversine = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    distance = 6_371_000 * 2 * math.atan2(math.sqrt(haversine), math.sqrt(1-haversine))
    if distance > radius:
        raise ValueError(f"{label} must be within {int(radius)} metres of {school.get('school_name', 'your school')}.")
    return latitude, longitude


def stall_is_open(opens_at, closes_at, moment=None):
    opening = datetime.strptime(opens_at, "%H:%M").time()
    closing = datetime.strptime(closes_at, "%H:%M").time()
    if opening == clock_time(0, 0) and closing == clock_time(23, 59):
        return True
    current = (moment or datetime.now(CAMPUS_ZONE)).time().replace(second=0, microsecond=0)
    if opening < closing:
        return opening <= current < closing
    return current >= opening or current < closing


def stall_on_break(db, stall_id):
    if stall_id is None:
        return False
    row = db.execute("SELECT value FROM settings WHERE key=?", (f"stall_break:{int(stall_id)}",)).fetchone()
    return bool(row and row["value"] == "true")


def ceil_pickup_slot(moment):
    moment = moment.replace(second=0, microsecond=0)
    remainder = moment.minute % PICKUP_SLOT_MINUTES
    if remainder:
        moment += timedelta(minutes=PICKUP_SLOT_MINUTES - remainder)
    return moment


def pickup_slots(db, stall_id, moment=None):
    stall = db.execute("SELECT opens_at,closes_at,prep_minutes,pickup_slot_capacity,status FROM stalls WHERE id=?",
        (stall_id,)).fetchone()
    if not stall or stall["status"] != "approved":
        raise ApiError(404,"Stall is not available for pickup.")
    local_now = moment or datetime.now(CAMPUS_ZONE)
    earliest = ceil_pickup_slot(local_now + timedelta(minutes=stall["prep_minutes"]))
    opening = datetime.strptime(stall["opens_at"],"%H:%M").time()
    closing = datetime.strptime(stall["closes_at"],"%H:%M").time()
    slots = []
    for day_offset in range(2):
        day = local_now.date() + timedelta(days=day_offset)
        start = datetime.combine(day,opening,CAMPUS_ZONE)
        end = datetime.combine(day,closing,CAMPUS_ZONE)
        if closing <= opening:
            end += timedelta(days=1)
        start = max(start,earliest)
        slot = ceil_pickup_slot(start)
        while slot + timedelta(minutes=PICKUP_SLOT_MINUTES) <= end and slot <= local_now + timedelta(hours=24):
            slot_key = slot.isoformat(timespec="seconds")
            count = db.execute("""SELECT COUNT(*) FROM orders WHERE stall_id=? AND pickup_at=?
                AND status IN ('placed','confirmed','preparing','ready')""", (stall_id,slot_key)).fetchone()[0]
            if count < stall["pickup_slot_capacity"]:
                slot_end=slot+timedelta(minutes=PICKUP_SLOT_MINUTES)
                slots.append({"pickup_at":slot_key,"label":f"{slot.strftime('%a %I:%M %p')} - {slot_end.strftime('%I:%M %p')}",
                    "remaining":stall["pickup_slot_capacity"]-count})
            slot += timedelta(minutes=PICKUP_SLOT_MINUTES)
    return slots


def rotate_stall_rows(rows, moment=None):
    stalls = {}
    for row in rows:
        stalls.setdefault(row["stall_id"], []).append(row)
    stall_ids = sorted(stalls, key=lambda stall_id: (stalls[stall_id][0]["stall_name"].casefold(), stall_id))
    if not stall_ids:
        return rows
    today = (moment or datetime.now(CAMPUS_ZONE)).date()
    offset = date.toordinal(today) % len(stall_ids)
    stall_ids = stall_ids[offset:] + stall_ids[:offset]
    rotated = []
    for product_index in range(max(map(len, stalls.values()))):
        rotated.extend(stalls[stall_id][product_index] for stall_id in stall_ids if product_index < len(stalls[stall_id]))
    return rotated


class ApiError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class BiteHubHTTPServer(ThreadingHTTPServer):
    # The stdlib TCP server backlog defaults to 5. Leave room for short request
    # bursts while the threaded handlers acquire a database connection.
    request_queue_size = 128
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    server_version = "BiteHub/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def client_ip(self):
        return str(self.client_address[0]) if self.client_address else "unknown"

    def enforce_rate_limit(self, scope, identity, limit, window_seconds):
        global _rate_limit_calls
        key = (scope, identity)
        current = time.monotonic()
        with _rate_limit_lock:
            events = _rate_limit_events.setdefault(key, deque())
            while events and events[0] <= current - window_seconds:
                events.popleft()
            if len(events) >= limit:
                raise ApiError(429, "Too many requests. Please wait a moment and try again.")
            events.append(current)
            _rate_limit_calls += 1
            if _rate_limit_calls % 256 == 0:
                for stale_key, stale_events in list(_rate_limit_events.items()):
                    if not stale_events or stale_events[-1] <= current - 3600:
                        _rate_limit_events.pop(stale_key, None)

    def clear_rate_limit(self, scope, identity):
        with _rate_limit_lock:
            _rate_limit_events.pop((scope, identity), None)

    def webauthn_context(self):
        host_header = str(self.headers.get("Host") or "").strip()
        if not host_header or any(char in host_header for char in "\r\n/\\"):
            raise ApiError(400, "This BiteHub address cannot be used for passkey sign-in.")
        parsed_host = urlparse("//" + host_header)
        hostname = (parsed_host.hostname or "").lower().rstrip(".")
        if not hostname:
            raise ApiError(400, "This BiteHub address cannot be used for passkey sign-in.")
        if hostname in {"127.0.0.1", "::1"}:
            local_port = f":{parsed_host.port}" if parsed_host.port else ""
            raise ApiError(400,
                f"For local passkey testing, open BiteHub at http://localhost{local_port} and sign in again. "
                "Passkeys cannot use a numeric loopback address as their domain.")

        origin = WEBAUTHN_ORIGIN
        if origin:
            parsed_origin = urlparse(origin)
            if parsed_origin.scheme not in {"https", "http"} or not parsed_origin.hostname:
                raise ApiError(503, "BiteHub passkey origin settings are invalid.")
            if parsed_origin.hostname.lower().rstrip(".") != hostname:
                raise ApiError(400, "Open BiteHub at its configured address to use this passkey.")
        else:
            scheme = "https" if getattr(self.server, "is_https", False) else "http"
            origin = f"{scheme}://{host_header}"

        parsed_origin = urlparse(origin)
        rp_id = WEBAUTHN_RP_ID or (parsed_origin.hostname or hostname).lower().rstrip(".")
        origin_host = (parsed_origin.hostname or "").lower().rstrip(".")
        if origin_host != rp_id and not origin_host.endswith("." + rp_id):
            raise ApiError(503, "BiteHub passkey relying-party settings do not match this address.")
        local_hosts = {"localhost", "127.0.0.1", "::1"}
        if parsed_origin.scheme != "https" and origin_host not in local_hosts:
            raise ApiError(503, "Passkeys require BiteHub over HTTPS.")
        request_origin = str(self.headers.get("Origin") or "").rstrip("/")
        if request_origin and request_origin != origin:
            raise ApiError(403, "This passkey request came from a different BiteHub address.")
        return rp_id, origin

    def save_webauthn_challenge(self, purpose, challenge, user_id=None, session_hash=None):
        token = secrets.token_urlsafe(32)
        with connect() as db:
            db.execute("DELETE FROM webauthn_challenges WHERE expires_at<=?", (int(time.time()),))
            db.execute("""INSERT INTO webauthn_challenges
                (challenge_token_hash,purpose,challenge,user_id,session_hash,expires_at)
                VALUES(?,?,?,?,?,?)""", (
                    hashlib.sha256(token.encode("ascii")).hexdigest(), purpose, challenge,
                    user_id, session_hash, int(time.time()) + 300,
                ))
        return token

    def consume_webauthn_challenge(self, token, purpose):
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{40,100}", token):
            raise ApiError(400, "That passkey request expired. Please start again.")
        token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
        with connect() as db:
            row = db.execute("""SELECT challenge_token_hash,purpose,challenge,user_id,session_hash,expires_at
                FROM webauthn_challenges WHERE challenge_token_hash=?""", (token_hash,)).fetchone()
            db.execute("DELETE FROM webauthn_challenges WHERE challenge_token_hash=?", (token_hash,))
        if not row or row["purpose"] != purpose or int(row["expires_at"]) <= int(time.time()):
            raise ApiError(400, "That passkey request expired. Please start again.")
        return row

    def reach_viewer(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            signed = cookie["bitehub_viewer"].value if "bitehub_viewer" in cookie else ""
        except Exception:
            signed = ""
        with connect() as db:
            secret_row = db.execute("SELECT value FROM settings WHERE key='reach_signing_secret'").fetchone()
        secret = bytes.fromhex(secret_row["value"])
        if "." in signed:
            viewer_id, signature = signed.split(".", 1)
            expected = hmac.new(secret, viewer_id.encode("ascii", "ignore"), hashlib.sha256).hexdigest()
            if re.fullmatch(r"[0-9a-f]{32}", viewer_id) and secrets.compare_digest(signature, expected):
                return viewer_id, None, False
        viewer_id = secrets.token_hex(16)
        signature = hmac.new(secret, viewer_id.encode("ascii"), hashlib.sha256).hexdigest()
        secure = "; Secure" if getattr(self.server, "is_https", False) else ""
        header = f"bitehub_viewer={viewer_id}.{signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age={REACH_COOKIE_SECONDS}{secure}"
        return viewer_id, header, True

    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    def send_json(self, status, payload, headers=None):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if headers:
            for name, value in headers.items():
                self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            raise ApiError(400, "Chunked request bodies are not supported.")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self.close_connection = True
            raise ApiError(411, "A Content-Length header is required.")
        if not re.fullmatch(r"[0-9]{1,10}", raw_length):
            self.close_connection = True
            raise ApiError(400, "Invalid Content-Length header.")
        length = int(raw_length)
        if length > MAX_BODY:
            self.close_connection = True
            raise ApiError(413, "Request is too large.")
        raw = self.rfile.read(length)
        if len(raw) != length:
            self.close_connection = True
            raise ApiError(400, "Request body ended before Content-Length bytes were received.")
        try:
            value = json.loads(raw or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ApiError(400, "Request body must be valid JSON.")
        if not isinstance(value, dict):
            raise ApiError(400, "Request body must be a JSON object.")
        return value

    def cookie_token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            return cookie["bitehub_session"].value if "bitehub_session" in cookie else None
        except Exception:
            return None

    def guest_cookie_token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            return cookie["bitehub_guest_session"].value if "bitehub_guest_session" in cookie else None
        except Exception:
            return None

    def current_guest_session(self):
        token = self.guest_cookie_token()
        if not token:
            return None
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with connect() as db:
            row = db.execute(
                "SELECT id,guest_name AS name FROM guest_sessions WHERE token_hash=? AND expires_at>?",
                (token_hash, int(time.time())),
            ).fetchone()
        return dict(row) if row else None

    def create_guest_session(self, guest_name):
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        expires = int(time.time()) + GUEST_SESSION_SECONDS
        with connect() as db:
            db.execute("DELETE FROM guest_sessions WHERE expires_at<=?", (int(time.time()),))
            guest_id = insert_id(db,
                "INSERT INTO guest_sessions(guest_name,token_hash,created_at,expires_at) VALUES(?,?,?,?)",
                (guest_name, token_hash, now(), expires))
        secure = "; Secure" if getattr(self.server, "is_https", False) else ""
        cookie_header = (f"bitehub_guest_session={token}; HttpOnly; SameSite=Strict; Path=/; "
                         f"Max-Age={GUEST_SESSION_SECONDS}{secure}")
        return {"id": guest_id, "name": guest_name}, cookie_header

    def current_user(self, required=True):
        token = self.cookie_token()
        if token:
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            with connect() as db:
                row = db.execute("""SELECT u.id,u.name,u.email,u.role,u.school_id,u.school_zip,
                    sc.region school_region,sc.province school_province,sc.city school_city,sc.name school_name,
                    sc.school_type,sc.latitude school_latitude,sc.longitude school_longitude,sc.delivery_radius_m,
                    s.id stall_id,s.name stall_name,s.description stall_description,s.status stall_status,
                    s.opens_at stall_opens_at,s.closes_at stall_closes_at,s.prep_minutes stall_prep_minutes,
                    s.pickup_slot_capacity stall_pickup_slot_capacity,s.pickup_lat stall_pickup_lat,
                    s.pickup_lon stall_pickup_lon,s.logo_type stall_logo_type,
                    u.profile_photo_type,u.profile_photo_version
                    FROM sessions x JOIN users u ON u.id=x.user_id LEFT JOIN schools sc ON sc.id=u.school_id
                    LEFT JOIN stalls s ON s.owner_id=u.id
                    WHERE x.token_hash=? AND x.expires_at>? AND u.deleted_at IS NULL""", (token_hash, int(time.time()))).fetchone()
                if row:
                    user = dict(row)
                    user["stall_on_break"] = stall_on_break(db, user.get("stall_id"))
            if row:
                user["stall_logo_url"] = f"/api/stalls/{user['stall_id']}/logo" if user.get("stall_logo_type") else None
                user["profile_photo_url"] = f"/api/profile/photo?v={user['profile_photo_version']}" if user.get("profile_photo_type") else None
                return user
        if required:
            raise ApiError(401, "Please sign in to continue.")
        return None

    def require_role(self, *roles):
        user = self.current_user()
        if user["role"] not in roles:
            raise ApiError(403, "This account does not have access to that action.")
        return user

    def create_session(self, user_id):
        token = secrets.token_urlsafe(32)
        expires = int(time.time()) + SESSION_SECONDS
        with connect() as db:
            db.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
            db.execute("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
                       (hashlib.sha256(token.encode()).hexdigest(), user_id, expires))
        secure = "; Secure" if getattr(self.server, "is_https", False) else ""
        return {"Set-Cookie": f"bitehub_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_SECONDS}{secure}"}

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            try:
                self.api_get(path)
            except ApiError as error:
                self.send_json(error.status, {"error": error.message})
            except Exception:
                self.log_error("API failure: %s", __import__("traceback").format_exc())
                self.send_json(500, {"error": "The server could not complete that request."})
            return
        self.serve_static(path)

    def do_POST(self): self.api_request("POST")
    def do_PATCH(self): self.api_request("PATCH")
    def do_DELETE(self): self.api_request("DELETE")

    def api_request(self, method):
        try:
            path = urlparse(self.path).path
            if method == "DELETE":
                if self.headers.get("Transfer-Encoding"):
                    self.close_connection = True
                    raise ApiError(400, "Chunked request bodies are not supported.")
                raw_length = self.headers.get("Content-Length", "0")
                if not re.fullmatch(r"[0-9]{1,10}", raw_length):
                    self.close_connection = True
                    raise ApiError(400, "Invalid Content-Length header.")
                if int(raw_length) > MAX_BODY:
                    self.close_connection = True
                    raise ApiError(413, "Request is too large.")
                if int(raw_length) != 0:
                    self.close_connection = True
                    raise ApiError(400, "DELETE requests must not include a body.")
                data = {}
            else:
                data = self.body()
            if method == "POST": self.api_post(path, data)
            elif method == "PATCH": self.api_patch(path, data)
            else: self.api_delete(path)
        except ApiError as error:
            self.send_json(error.status, {"error": error.message})
        except (ValueError, sqlite3.IntegrityError) as error:
            self.send_json(400, {"error": str(error) or "That change could not be saved."})
        except Exception:
            self.log_error("API failure: %s", __import__("traceback").format_exc())
            self.send_json(500, {"error": "The server could not complete that request."})

    def api_get(self, path):
        if path == "/api/admin/passkeys/status":
            admin = self.require_role("admin")
            if not PASSKEYS_AVAILABLE:
                raise ApiError(503, "Passkey sign-in needs the BiteHub passkey database migration and server package.")
            with connect() as db:
                count = db.execute("SELECT COUNT(*) FROM admin_passkeys WHERE user_id=?", (admin["id"],)).fetchone()[0]
                setting = db.execute("SELECT value FROM settings WHERE key=?", (f"admin_passkey_required:{admin['id']}",)).fetchone()
            passkey_only = bool(setting and setting["value"] == "true")
            self.send_json(200, {"count": count, "passkey_only": passkey_only, "can_enable": count >= 2 and not passkey_only})
            return
        if path == "/api/profile/photo":
            user = self.current_user()
            with connect() as db:
                row = db.execute("SELECT profile_photo_data,profile_photo_type FROM users WHERE id=?", (user["id"],)).fetchone()
            if not row or not row["profile_photo_data"] or not row["profile_photo_type"]:
                raise ApiError(404, "Profile photo not found.")
            self.send_response(200)
            self.send_header("Content-Type", row["profile_photo_type"])
            self.send_header("Content-Length", str(len(row["profile_photo_data"])))
            self.send_header("Cache-Control", "private, no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(row["profile_photo_data"])
            return
        if path == "/api/maps/config":
            # Google Maps JavaScript API keys are public client-side credentials.
            # Restrict the configured key by referrer and enabled APIs in Google Cloud.
            self.send_json(200, {"google_maps_api_key": os.environ.get("BITEHUB_GOOGLE_MAPS_API_KEY", "").strip()})
            return
        if path == "/api/notifications/config":
            self.send_json(200, {"public_key": vapid_public_key(), "available": push_available(),
                "guest_available": GUEST_PUSH_AVAILABLE})
            return
        if path == "/api/notifications/status":
            user = self.current_user(required=False)
            guest_session = self.current_guest_session() if not user else None
            if not user and not guest_session:
                raise ApiError(401, "Sign in or continue as a guest to manage device alerts.")
            if user:
                with connect() as db:
                    count = db.execute("SELECT COUNT(*) FROM push_subscriptions WHERE user_id=?", (user["id"],)).fetchone()[0]
                self.send_json(200, {"enabled": count > 0, "available": push_available(), "guest_available": GUEST_PUSH_AVAILABLE})
            elif not GUEST_PUSH_AVAILABLE:
                self.send_json(200, {"enabled": False, "available": push_available(), "guest_available": False})
            else:
                with connect() as db:
                    count = db.execute("SELECT COUNT(*) FROM guest_push_subscriptions WHERE guest_session_id=?", (guest_session["id"],)).fetchone()[0]
                self.send_json(200, {"enabled": count > 0, "available": push_available(), "guest_available": True})
            return
        if path == "/api/notifications/inbox":
            user = self.current_user(required=False)
            guest_session = self.current_guest_session() if not user else None
            if not user and not guest_session:
                raise ApiError(401, "Sign in or continue as a guest to view your notifications.")
            if not NOTIFICATION_INBOX_AVAILABLE:
                raise ApiError(503, "The in-app notification inbox needs the BiteHub database migration.")
            with connect() as db:
                if user:
                    scope, identifier = "user_id", user["id"]
                else:
                    scope, identifier = "guest_session_id", guest_session["id"]
                unread_count = db.execute(
                    f"SELECT COUNT(*) FROM notifications WHERE {scope}=? AND read_at IS NULL", (identifier,)
                ).fetchone()[0]
                rows = db.execute(
                    f"SELECT id,title,body,url,tag,created_at,read_at FROM notifications WHERE {scope}=? "
                    "ORDER BY id DESC LIMIT 50", (identifier,)
                ).fetchall()
            items = [{"id": row["id"], "title": row["title"], "body": row["body"],
                      "url": safe_notification_url(row["url"]), "tag": row["tag"],
                      "created_at": str(row["created_at"]),
                      "read_at": str(row["read_at"]) if row["read_at"] else None}
                     for row in rows]
            self.send_json(200, {"notifications": items, "unread_count": unread_count})
            return
        if path == "/api/stalls":
            with connect() as db:
                if get_stall_registration_mode(db) == "stop_all":
                    self.send_json(200, {"stalls": []})
                    return
                rows = db.execute("""SELECT s.id,s.name,s.description,s.status,s.opens_at,s.closes_at,s.logo_type,
        s.pickup_lat pickup_latitude,s.pickup_lon pickup_longitude,
        COUNT(CASE WHEN p.available=1 THEN 1 END) menu_count,
        (SELECT value FROM settings WHERE key='stall_break:' || CAST(s.id AS TEXT)) stall_break_value FROM stalls s
                    JOIN users u ON u.id=s.owner_id LEFT JOIN products p ON p.stall_id=s.id
                    WHERE s.status='approved' AND u.school_id='pns' AND u.deleted_at IS NULL
                    GROUP BY s.id ORDER BY s.name""").fetchall()
            stall_list = []
            for row in rows:
                item = dict(row)
                item.pop("stall_break_value", None)
                item["is_open"] = stall_is_open(row["opens_at"], row["closes_at"])
                item["on_break"] = row["stall_break_value"] == "true"
                item["logo_url"] = f"/api/stalls/{row['id']}/logo" if row["logo_type"] else None
                stall_list.append(item)
            self.send_json(200, {"stalls": stall_list})
            return
        if path == "/api/reach-viewer":
            viewer_id, set_cookie, is_new = self.reach_viewer()
            if is_new:
                self.enforce_rate_limit("reach-viewer", self.client_ip(), 1200, 3600)
            self.send_json(200, {"ok": True}, {"Set-Cookie": set_cookie} if set_cookie else None)
            return
        if path == "/api/stall/analytics":
            owner = self.require_role("owner")
            stall_id = owner["stall_id"]
            week_ago = (datetime.now(CAMPUS_ZONE).date() - timedelta(days=6)).isoformat()
            with connect() as db:
                stall_views = db.execute("""SELECT COUNT(*) total,
                    SUM(CASE WHEN viewed_on>=? THEN 1 ELSE 0 END) last_7_days
                    FROM reach_views WHERE stall_id=? AND product_id IS NULL""", (week_ago,stall_id)).fetchone()
                rows = db.execute("""SELECT p.id,p.name,COALESCE(v.views_total,0) views_total,
                    COALESCE(v.views_7_days,0) views_7_days,COALESCE(o.order_count,0) order_count,
                    COALESCE(o.units_ordered,0) units_ordered
                    FROM products p
                    LEFT JOIN (SELECT product_id,COUNT(*) views_total,
                        SUM(CASE WHEN viewed_on>=? THEN 1 ELSE 0 END) views_7_days
                        FROM reach_views WHERE product_id IS NOT NULL GROUP BY product_id) v ON v.product_id=p.id
                    LEFT JOIN (SELECT oi.product_id,COUNT(DISTINCT o.id) order_count,
                        SUM(oi.quantity) units_ordered FROM order_items oi JOIN orders o ON o.id=oi.order_id
                        WHERE o.status!='declined' GROUP BY oi.product_id) o ON o.product_id=p.id
                    WHERE p.stall_id=? ORDER BY p.name""", (week_ago,stall_id)).fetchall()
            self.send_json(200, {"stall_views": {"total": stall_views["total"] or 0,
                "last_7_days": stall_views["last_7_days"] or 0},
                "products": [{"id":row["id"],"name":row["name"],"views_total":row["views_total"] or 0,
                    "views_7_days":row["views_7_days"] or 0,"order_count":row["order_count"],
                    "units_ordered":row["units_ordered"]} for row in rows]})
            return
        logo_match = re.fullmatch(r"/api/stalls/(\d+)/logo", path)
        if logo_match:
            stall_id = int(logo_match.group(1))
            user = self.current_user(required=False)
            with connect() as db:
                stall_mode = get_stall_registration_mode(db)
                row = db.execute("""SELECT s.logo_data,s.logo_type,s.status,s.owner_id,u.school_id
                    FROM stalls s JOIN users u ON u.id=s.owner_id
                    WHERE s.id=? AND u.deleted_at IS NULL""", (stall_id,)).fetchone()
            public = stall_mode != "stop_all" and row and row["status"] == "approved" and row["school_id"] == "pns"
            owner = row and user and user["role"] == "owner" and user["id"] == row["owner_id"]
            admin = user and user["role"] == "admin"
            if not row or not row["logo_data"] or not row["logo_type"] or not (public or owner or admin):
                raise ApiError(404, "Stall logo not found.")
            self.send_response(200)
            self.send_header("Content-Type", row["logo_type"])
            self.send_header("Content-Length", str(len(row["logo_data"])))
            self.send_header("Cache-Control", "private, max-age=300")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(row["logo_data"])
            return
        stall_match = re.fullmatch(r"/api/stalls/(\d+)", path)
        if stall_match:
            user = self.current_user(required=False)
            with connect() as db:
                stall_mode = get_stall_registration_mode(db)
                stall = db.execute("""SELECT s.id,s.name,s.description,s.status,s.opens_at,s.closes_at,s.logo_type,
                    s.pickup_lat pickup_latitude,s.pickup_lon pickup_longitude,
                    s.owner_id,u.school_id,u.name owner_name,
                    (SELECT value FROM settings WHERE key='stall_break:' || CAST(s.id AS TEXT)) stall_break_value
                    FROM stalls s JOIN users u ON u.id=s.owner_id WHERE s.id=? AND u.deleted_at IS NULL""",
                    (int(stall_match.group(1)),)).fetchone()
                public = stall_mode != "stop_all" and stall and stall["status"] == "approved" and stall["school_id"] == "pns"
                owner = stall and user and user["role"] == "owner" and user["id"] == stall["owner_id"]
                if not stall or not (public or owner): raise ApiError(404, "Stall not found.")
                products = db.execute("""SELECT p.id,p.name,p.description,p.ingredients,p.category,p.price_cents,p.emoji,
                    p.available,p.stock_count,p.photo_type,p.dietary_tags,p.allergen_tags FROM products p WHERE p.stall_id=? AND p.available=1
                    ORDER BY p.category,p.name""", (stall["id"],)).fetchall()
                payload = dict(stall)
                payload.pop("stall_break_value", None)
                payload.pop("owner_id", None)
                payload.pop("school_id", None)
                payload["is_open"] = stall_is_open(stall["opens_at"], stall["closes_at"])
                payload["on_break"] = stall["stall_break_value"] == "true"
                payload["menu_count"] = len(products)
                rating = db.execute("""SELECT AVG(f.rating) average,COUNT(f.rating) count FROM feedback f
                    JOIN orders o ON o.id=f.order_id WHERE o.stall_id=?""", (stall["id"],)).fetchone()
                payload["rating"] = round(rating["average"],1) if rating["average"] is not None else None
                payload["review_count"] = rating["count"]
                payload["logo_url"] = f"/api/stalls/{stall['id']}/logo" if stall["logo_type"] else None
                payload["products"] = [{"id": p["id"], "name": p["name"], "description": p["description"],
                    "ingredients": p["ingredients"], "dietary_tags": json.loads(p["dietary_tags"] or "[]"),
                    "allergen_tags": json.loads(p["allergen_tags"] or "[]"),
                    "category": p["category"], "price": p["price_cents"] / 100, "emoji": p["emoji"],
                    "stock_count": p["stock_count"], "photo_url": f"/api/products/{p['id']}/photo" if p["photo_type"] else None}
                    for p in products]
            self.send_json(200, payload)
            return
        photo_match = re.fullmatch(r"/api/products/(\d+)/photo", path)
        if photo_match:
            product_id = int(photo_match.group(1))
            user = self.current_user(required=False)
            with connect() as db:
                stall_mode = get_stall_registration_mode(db)
                row = db.execute("""SELECT p.photo_data,p.photo_type,p.available,s.status stall_status,s.owner_id,u.school_id
                    FROM products p JOIN stalls s ON s.id=p.stall_id JOIN users u ON u.id=s.owner_id
                    WHERE p.id=? AND u.deleted_at IS NULL""", (product_id,)).fetchone()
            if not row or not row["photo_data"] or not row["photo_type"]:
                raise ApiError(404, "Food photo not found.")
            public = (stall_mode != "stop_all" and row["available"]
                      and row["stall_status"] == "approved" and row["school_id"] == "pns")
            owner = user and user["role"] == "owner" and user["id"] == row["owner_id"]
            if not (public or owner or (user and user["role"] == "admin")):
                raise ApiError(404, "Food photo not found.")
            self.send_response(200)
            self.send_header("Content-Type", row["photo_type"])
            self.send_header("Content-Length", str(len(row["photo_data"])))
            self.send_header("Cache-Control", "private, max-age=300")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(row["photo_data"])
            return
        if path == "/api/session":
            user = self.current_user(required=False)
            guest_session = self.current_guest_session() if not user else None
            self.send_json(200, {"user": user, "guest_session": guest_session,
                "order_messages_available": ORDER_MESSAGES_AVAILABLE,
                "order_cancellation_available": ORDER_CANCELLATION_AVAILABLE,
                "guest_feedback_available": GUEST_FEEDBACK_AVAILABLE,
                "notification_inbox_available": NOTIFICATION_INBOX_AVAILABLE,
                "weekly_menu_available": WEEKLY_MENU_AVAILABLE})
            return
        if path == "/api/pickup-slots":
            self.require_role("buyer")
            query=parse_qs(urlparse(self.path).query)
            try: stall_id=int(query.get("stall_id",[""])[0])
            except ValueError: raise ValueError("Choose a valid stall.")
            with connect() as db:
                slots=pickup_slots(db,stall_id)
                stall=db.execute("SELECT pickup_slot_capacity FROM stalls WHERE id=?",(stall_id,)).fetchone()
            self.send_json(200,{"slots":slots,"capacity":stall["pickup_slot_capacity"]});return
        location_match = re.fullmatch(r"/api/orders/(\d+)/location", path)
        if location_match:
            user = self.current_user()
            order_id = int(location_match.group(1))
            with connect() as db:
                row = db.execute("""SELECT o.buyer_id,o.runner_id,o.fulfillment,o.status,s.owner_id,dp.latitude,dp.longitude,
                    dp.accuracy,dp.heading,dp.updated_at FROM orders o JOIN stalls s ON s.id=o.stall_id
                    LEFT JOIN delivery_positions dp ON dp.order_id=o.id WHERE o.id=?""", (order_id,)).fetchone()
            if not row: raise ApiError(404, "Order not found.")
            allowed = ((user["role"] == "buyer" and row["buyer_id"] == user["id"]) or
                       (user["role"] == "owner" and row["owner_id"] == user["id"]) or
                       (user["role"] == "runner" and row["runner_id"] == user["id"]))
            if not allowed: raise ApiError(403, "This account cannot view this delivery location.")
            if row["fulfillment"] != "delivery" or row["status"] != "out":
                raise ApiError(404, "Live delivery location is no longer available.")
            self.send_json(200, {"location": ({"latitude": row["latitude"], "longitude": row["longitude"],
                "accuracy": row["accuracy"], "heading": row["heading"], "updated_at": row["updated_at"]}
                if row["latitude"] is not None else None)})
            return
        if path == "/api/products":
            user = self.current_user(required=False)
            weekly_menu = []
            with connect() as db:
                stall_mode = get_stall_registration_mode(db)
                paused = db.execute("SELECT value FROM settings WHERE key='ordering_paused'").fetchone()[0] == "true"
                where, args = "WHERE u.school_id='pns' AND u.deleted_at IS NULL", []
                if not user or user["role"] not in ("admin", "owner"):
                    where += " AND p.available=1 AND s.status='approved'"
                    if stall_mode == "stop_all":
                        where += " AND 1=0"
                elif user["role"] == "owner":
                    where += " AND (s.owner_id=? OR (s.status='approved' AND p.available=1))"
                    args = [user["id"]]
                rows = db.execute(f"""SELECT p.id,p.name,p.description,p.ingredients,p.category,p.price_cents,p.emoji,p.available,
                    p.stock_count,p.dietary_tags,p.allergen_tags,p.photo_type,p.featured_until,s.id stall_id,s.name stall_name,s.description stall_description,
                    s.status stall_status,s.opens_at,s.closes_at,s.pickup_lat,s.pickup_lon,s.logo_type stall_logo_type,
                    (SELECT value FROM settings WHERE key='stall_break:' || CAST(s.id AS TEXT)) stall_break_value
                    FROM products p JOIN stalls s ON s.id=p.stall_id JOIN users u ON u.id=s.owner_id
                    {where} ORDER BY s.name,p.name""", args).fetchall()
                featured_rows = [row for row in rows if stall_mode != "stop_all" and row["featured_until"] and row["featured_until"] > now()
                    and row["available"] and (row["stock_count"] is None or row["stock_count"] > 0)
                    and row["stall_status"] == "approved" and row["stall_break_value"] != "true"]
                featured_rows = rotate_stall_rows(featured_rows)
                if not user or user["role"] == "buyer":
                    rows = rotate_stall_rows(rows)
                # Public scheduled items are part of the customer catalog too.
                # Keep them hidden when sales are stopped, while still letting
                # owners and admins inspect their own/admin schedule views.
                if WEEKLY_MENU_AVAILABLE and (stall_mode != "stop_all" or (user and user["role"] in ("owner", "admin"))):
                    schedule_where = "u.school_id='pns' AND u.deleted_at IS NULL AND s.status='approved'"
                    schedule_args = []
                    if user and user["role"] == "owner":
                        schedule_where = "s.owner_id=?"
                        schedule_args = [user["id"]]
                    weekly_rows = db.execute(f"""SELECT wm.id schedule_id,wm.weekday,wm.service_period,
                        p.id,p.stall_id,p.name,p.description,p.category,p.price_cents,p.emoji,p.available,
                        p.photo_type,s.name stall_name FROM weekly_menu_slots wm
                        JOIN products p ON p.id=wm.product_id JOIN stalls s ON s.id=wm.stall_id
                        JOIN users u ON u.id=s.owner_id WHERE {schedule_where}
                        ORDER BY wm.weekday,CASE wm.service_period WHEN 'Morning break' THEN 0 WHEN 'Lunch' THEN 1 ELSE 2 END,s.name,p.name""",
                        schedule_args).fetchall()
                    weekly_menu = [{"schedule_id": row["schedule_id"], "weekday": row["weekday"],
                        "service_period": row["service_period"], "id": row["id"], "stall_id": row["stall_id"],
                        "stall_name": row["stall_name"], "name": row["name"], "description": row["description"],
                        "category": row["category"], "price": row["price_cents"] / 100, "emoji": row["emoji"],
                        "photo_url": f"/api/products/{row['id']}/photo" if row["photo_type"] and row["available"] else None}
                        for row in weekly_rows]
            self.send_json(200, {"products": [self.product_json(row, bool(user and user["role"] in ("owner", "admin"))) for row in rows],
                                 "featured_products": [self.product_json(row) for row in featured_rows],
                                 "weekly_menu": weekly_menu,
                                 "weekly_menu_available": WEEKLY_MENU_AVAILABLE,
                                 "stall_registration_mode": stall_mode,
                                 "ordering_paused": paused,
                                 "stall_status": user.get("stall_status") if user and user["role"] == "owner" else None,
                                 "owner_hours": {"opens_at": user["stall_opens_at"], "closes_at": user["stall_closes_at"]}
                                                if user and user["role"] == "owner" else None,
                                  "owner_stall_on_break": bool(user and user["role"] == "owner" and user.get("stall_on_break")),
                                 "owner_prep_minutes": user["stall_prep_minutes"] if user and user["role"] == "owner" else None,
                                 "owner_pickup_capacity": user["stall_pickup_slot_capacity"] if user and user["role"] == "owner" else None,
                                 "owner_pickup_location": {"lat": user["stall_pickup_lat"], "lon": user["stall_pickup_lon"]}
                                                          if user and user["role"] == "owner" else None})
            return
        if path == "/api/orders":
            user = self.current_user()
            with connect() as db:
                if user["role"] == "buyer": sql, args = "o.buyer_id=?", [user["id"]]
                elif user["role"] == "owner": sql, args = "s.owner_id=?", [user["id"]]
                elif user["role"] == "runner": sql, args = "o.runner_id=?", [user["id"]]
                else: sql, args = "owner.school_id='pns'", []
                orders = db.execute(f"""SELECT o.*,COALESCE(NULLIF(o.guest_name,''),u.name,'Guest') buyer_name,COALESCE(u.email,'') buyer_email,s.name stall_name,r.name account_runner_name,
                    s.pickup_lat stall_latitude,s.pickup_lon stall_longitude,dp.latitude driver_latitude,
                    dp.longitude driver_longitude,dp.accuracy driver_accuracy,dp.heading driver_heading,dp.updated_at driver_updated_at
                    FROM orders o LEFT JOIN users u ON u.id=o.buyer_id JOIN stalls s ON s.id=o.stall_id
                    JOIN users owner ON owner.id=s.owner_id
                    LEFT JOIN users r ON r.id=o.runner_id LEFT JOIN delivery_positions dp ON dp.order_id=o.id
                    WHERE {sql} ORDER BY o.id DESC""",args).fetchall()
                stall_status = None
                if user["role"] == "owner":
                    stall = db.execute("SELECT status FROM stalls WHERE owner_id=?",(user["id"],)).fetchone()
                    stall_status = stall["status"] if stall else None
                paused = db.execute("SELECT value FROM settings WHERE key='ordering_paused'").fetchone()[0] == "true"
                result = self.orders_json(db, orders, include_pickup_codes=user["role"] == "buyer")
            self.send_json(200, {"orders":result,"ordering_paused":paused,"stall_status":stall_status})
            return
        if path == "/api/runners":
            self.require_role("owner", "admin")
            with connect() as db:
                rows = db.execute("SELECT id,name FROM users WHERE role='runner' AND school_id='pns' AND deleted_at IS NULL ORDER BY name").fetchall()
            self.send_json(200, {"runners": [dict(row) for row in rows]})
            return
        if path == "/api/admin/reports":
            self.require_role("admin")
            with connect() as db:
                daily_orders = db.execute("""SELECT date(o.created_at,'+8 hours') day,COUNT(*) orders,
                    SUM(CASE WHEN o.status='completed' THEN 1 ELSE 0 END) completed_orders,
                    SUM(CASE WHEN o.status='declined' THEN 1 ELSE 0 END) declined_orders,
                    COALESCE(SUM(CASE WHEN o.status='completed' THEN o.total_cents ELSE 0 END),0) sales_cents
                    FROM orders o JOIN stalls s ON s.id=o.stall_id JOIN users owner ON owner.id=s.owner_id
                    WHERE owner.school_id='pns' GROUP BY date(o.created_at,'+8 hours') ORDER BY day""").fetchall()
                daily_views = db.execute("""SELECT viewed_on day,
                    SUM(CASE WHEN rv.product_id IS NULL THEN 1 ELSE 0 END) stall_views,
                    SUM(CASE WHEN rv.product_id IS NOT NULL THEN 1 ELSE 0 END) item_views
                    FROM reach_views rv JOIN stalls s ON s.id=rv.stall_id JOIN users owner ON owner.id=s.owner_id
                    WHERE owner.school_id='pns' GROUP BY rv.viewed_on ORDER BY day""").fetchall()
                daily_units = db.execute("""SELECT date(o.created_at,'+8 hours') day,COALESCE(SUM(oi.quantity),0) units_ordered
                    FROM orders o JOIN stalls s ON s.id=o.stall_id JOIN users owner ON owner.id=s.owner_id
                    JOIN order_items oi ON oi.order_id=o.id WHERE o.status!='declined' AND owner.school_id='pns'
                    GROUP BY date(o.created_at,'+8 hours') ORDER BY day""").fetchall()
                stalls = db.execute("""SELECT s.id,s.name,COALESCE(o.orders,0) orders,
                    COALESCE(o.completed_orders,0) completed_orders,COALESCE(o.declined_orders,0) declined_orders,
                    COALESCE(o.sales_cents,0) sales_cents,COALESCE(o.units_ordered,0) units_ordered,
                    COALESCE(v.stall_views,0) stall_views,COALESCE(v.item_views,0) item_views
                    FROM stalls s
                    LEFT JOIN (SELECT o.stall_id,COUNT(*) orders,
                        SUM(CASE WHEN o.status='completed' THEN 1 ELSE 0 END) completed_orders,
                        SUM(CASE WHEN o.status='declined' THEN 1 ELSE 0 END) declined_orders,
                        SUM(CASE WHEN o.status='completed' THEN o.total_cents ELSE 0 END) sales_cents,
                        SUM(CASE WHEN o.status!='declined' THEN (SELECT COALESCE(SUM(oi.quantity),0)
                            FROM order_items oi WHERE oi.order_id=o.id) ELSE 0 END) units_ordered
                        FROM orders o GROUP BY o.stall_id) o ON o.stall_id=s.id
                    LEFT JOIN (SELECT stall_id,SUM(CASE WHEN product_id IS NULL THEN 1 ELSE 0 END) stall_views,
                        SUM(CASE WHEN product_id IS NOT NULL THEN 1 ELSE 0 END) item_views
                        FROM reach_views GROUP BY stall_id) v ON v.stall_id=s.id
                    JOIN users owner ON owner.id=s.owner_id WHERE owner.school_id='pns'
                    ORDER BY s.name""").fetchall()
                products = db.execute("""SELECT p.id,p.name,s.name stall_name,
                    COALESCE(v.views,0) views,COALESCE(o.orders,0) orders,COALESCE(o.units_ordered,0) units_ordered,
                    COALESCE(o.sales_cents,0) sales_cents
                    FROM products p JOIN stalls s ON s.id=p.stall_id JOIN users owner ON owner.id=s.owner_id
                    LEFT JOIN (SELECT product_id,COUNT(*) views FROM reach_views
                        WHERE product_id IS NOT NULL GROUP BY product_id) v ON v.product_id=p.id
                    LEFT JOIN (SELECT oi.product_id,COUNT(DISTINCT o.id) orders,SUM(oi.quantity) units_ordered,
                        SUM(CASE WHEN o.status='completed' THEN oi.price_cents*oi.quantity ELSE 0 END) sales_cents
                        FROM order_items oi JOIN orders o ON o.id=oi.order_id
                        WHERE o.status!='declined' GROUP BY oi.product_id) o ON o.product_id=p.id
                    WHERE owner.school_id='pns' ORDER BY orders DESC,p.name""").fetchall()
            daily = {row["day"]:{"date":row["day"],"orders":row["orders"],
                "completed_orders":row["completed_orders"],"declined_orders":row["declined_orders"],
                "sales_cents":row["sales_cents"],"units_ordered":0,"stall_views":0,"item_views":0} for row in daily_orders}
            for row in daily_views:
                record = daily.setdefault(row["day"], {"date":row["day"],"orders":0,
                    "completed_orders":0,"declined_orders":0,"sales_cents":0,"units_ordered":0,"stall_views":0,"item_views":0})
                record["stall_views"],record["item_views"] = row["stall_views"],row["item_views"]
            for row in daily_units:
                record = daily.setdefault(row["day"], {"date":row["day"],"orders":0,
                    "completed_orders":0,"declined_orders":0,"sales_cents":0,"units_ordered":0,"stall_views":0,"item_views":0})
                record["units_ordered"] = row["units_ordered"]
            daily_rows = [daily[key] for key in sorted(daily)]
            totals = {key:sum(row[key] for row in daily_rows) for key in
                ("orders","completed_orders","declined_orders","sales_cents","units_ordered","stall_views","item_views")}
            self.send_json(200, {"totals":totals,"daily":daily_rows,
                "stalls":[dict(row) for row in stalls],"products":[dict(row) for row in products]})
            return
        if path == "/api/admin/overview":
            self.require_role("admin")
            with connect() as db:
                users = db.execute("SELECT role,COUNT(*) count FROM users WHERE school_id='pns' AND deleted_at IS NULL GROUP BY role").fetchall()
                stalls = db.execute("SELECT COUNT(*) FROM stalls s JOIN users owner ON owner.id=s.owner_id WHERE owner.school_id='pns' AND owner.deleted_at IS NULL").fetchone()[0]
                stall_rows = db.execute("""SELECT s.id,s.name,s.status,s.created_at,s.opens_at,s.closes_at,
                    (SELECT value FROM settings WHERE key='stall_break:' || CAST(s.id AS TEXT)) stall_break_value,
                    u.name owner_name,u.email owner_email,
                    COUNT(p.id) product_count FROM stalls s JOIN users u ON u.id=s.owner_id
                    LEFT JOIN products p ON p.stall_id=s.id WHERE u.school_id='pns' AND u.deleted_at IS NULL
                    GROUP BY s.id,u.name,u.email,s.opens_at,s.closes_at ORDER BY
                    CASE s.status WHEN 'paused' THEN 0 ELSE 1 END,s.name""").fetchall()
                stall_list = []
                for row in stall_rows:
                    item = dict(row)
                    item["currently_open"] = (item["status"] == "approved"
                        and stall_is_open(item["opens_at"], item["closes_at"])
                        and item["stall_break_value"] != "true")
                    item.pop("stall_break_value", None)
                    stall_list.append(item)
                products = db.execute("SELECT COUNT(*) FROM products p JOIN stalls s ON s.id=p.stall_id JOIN users owner ON owner.id=s.owner_id WHERE owner.school_id='pns' AND owner.deleted_at IS NULL").fetchone()[0]
                rows = db.execute("""SELECT o.status,COUNT(*) count,COALESCE(SUM(o.total_cents),0) sales
                    FROM orders o JOIN stalls s ON s.id=o.stall_id JOIN users owner ON owner.id=s.owner_id
                    WHERE owner.school_id='pns' GROUP BY o.status""").fetchall()
                paused = db.execute("SELECT value FROM settings WHERE key='ordering_paused'").fetchone()[0] == "true"
                stall_mode = get_stall_registration_mode(db)
            self.send_json(200, {"users": {row["role"]: row["count"] for row in users}, "stalls": stalls,
                                 "stall_list": stall_list,
                                 "products": products, "orders": [dict(row) for row in rows], "ordering_paused": paused,
                                 "stall_registration_mode": stall_mode})
            return
        raise ApiError(404, "That API route does not exist.")

    @staticmethod
    def product_json(row, include_unavailable=False):
        stock_count = row["stock_count"]
        featured_until = row["featured_until"] if "featured_until" in row.keys() else None
        featured = bool(featured_until and featured_until > now() and row["available"]
                        and (stock_count is None or stock_count > 0) and row["stall_status"] == "approved")
        item = {"id": row["id"], "name": row["name"], "description": row["description"],
                "ingredients": row["ingredients"] if "ingredients" in row.keys() else "",
                "category": row["category"], "price": row["price_cents"] / 100, "emoji": row["emoji"],
            "available": bool(row["available"]) and (stock_count is None or stock_count > 0),
                "stock_count": stock_count, "dietary_tags": json.loads(row["dietary_tags"] or "[]"),
                "allergen_tags": json.loads(row["allergen_tags"] or "[]"), "stall_id": row["stall_id"],
                "stall_name": row["stall_name"], "stall_status": row["stall_status"],
                "pickup_lat": row["pickup_lat"], "pickup_lon": row["pickup_lon"],
                "featured": featured, "featured_until": featured_until if featured else None,
                "opens_at": row["opens_at"], "closes_at": row["closes_at"],
            "stall_open": row["stall_status"] == "approved" and stall_is_open(row["opens_at"], row["closes_at"]),
                "stall_on_break": row["stall_break_value"] == "true" if "stall_break_value" in row.keys() else False}
        if "photo_type" in row.keys() and row["photo_type"]:
            item["photo_url"] = f"/api/products/{row['id']}/photo"
        if "stall_description" in row.keys(): item["stall_description"] = row["stall_description"]
        if "stall_logo_type" in row.keys() and row["stall_logo_type"]:
            item["stall_logo_url"] = f"/api/stalls/{row['stall_id']}/logo"
        return item

    @staticmethod
    def orders_json(db, rows, include_pickup_codes=False):
        if not rows:
            return []
        order_ids = [row["id"] for row in rows]
        items_by_order, feedback_by_order = {}, {}
        for start in range(0,len(order_ids),500):
            batch = order_ids[start:start+500]
            marks = ",".join("?" for _ in batch)
            items = db.execute(f"""SELECT order_id,product_id,name,price_cents,quantity,emoji
                FROM order_items WHERE order_id IN ({marks}) ORDER BY order_id,id""",batch).fetchall()
            for item in items:
                items_by_order.setdefault(item["order_id"],[]).append({
                    "product_id":item["product_id"],"name":item["name"],"price":item["price_cents"]/100,
                    "quantity":item["quantity"],"emoji":item["emoji"]})
            feedback = db.execute(f"SELECT order_id,rating,comment,created_at FROM feedback WHERE order_id IN ({marks})",batch).fetchall()
            feedback_by_order.update({row["order_id"]:{"rating":row["rating"],"comment":row["comment"],
                "created_at":row["created_at"]} for row in feedback})
        return [{"id":row["id"],"buyer":row["buyer_name"],"buyer_email":row["buyer_email"],
            "is_guest":row["buyer_id"] is None,
            "pickup_code":row["guest_pickup_code"] if include_pickup_codes else "",
            "guest_school_role":row["guest_school_role"],"guest_grade":row["guest_grade"],
            "guest_section":row["guest_section"],
            "stall":row["stall_name"],"runner":row["runner_name"] or row["account_runner_name"],
            "runner_account":row["runner_id"] is not None,"fulfillment":row["fulfillment"],
            "pickup_offer_status":row["pickup_offer_status"],
            "cancelled_by_buyer":bool(row["buyer_cancelled"]) if "buyer_cancelled" in row.keys() else False,
            "status":row["status"],"total":row["total_cents"]/100,"buyer_note":row["buyer_note"],
            "created_at":row["created_at"],"estimated_ready_at":row["estimated_ready_at"],
            "pickup_at":row["pickup_at"],"items":items_by_order.get(row["id"],[]),
            "stall_latitude":row["stall_latitude"],"stall_longitude":row["stall_longitude"],
            "delivery_latitude":row["delivery_lat"],"delivery_longitude":row["delivery_lon"],
            "driver_latitude":row["driver_latitude"] if row["status"] == "out" and row["fulfillment"] == "delivery" else None,
            "driver_longitude":row["driver_longitude"] if row["status"] == "out" and row["fulfillment"] == "delivery" else None,
            "driver_accuracy":row["driver_accuracy"] if row["status"] == "out" and row["fulfillment"] == "delivery" else None,
            "driver_heading":row["driver_heading"] if row["status"] == "out" and row["fulfillment"] == "delivery" else None,
            "driver_updated_at":row["driver_updated_at"] if row["status"] == "out" and row["fulfillment"] == "delivery" else None,
            "feedback":({**feedback_by_order[row["id"]],"verified_guest":row["buyer_id"] is None}
                if row["id"] in feedback_by_order else None)} for row in rows]

    def api_post(self, path, data):
        if path == "/api/admin/passkeys/register/options":
            admin = self.require_role("admin")
            if not PASSKEYS_AVAILABLE:
                raise ApiError(503, "Passkey sign-in needs the BiteHub passkey database migration and server package.")
            self.enforce_rate_limit("admin-passkey-register", admin["id"], 10, 600)
            rp_id, _origin = self.webauthn_context()
            with connect() as db:
                existing = db.execute("SELECT credential_id FROM admin_passkeys WHERE user_id=?", (admin["id"],)).fetchall()
            if len(existing) >= 10:
                raise ApiError(409, "This admin account already has the maximum of 10 passkeys.")
            options = generate_registration_options(
                rp_id=rp_id,
                rp_name="BiteHub · Palawan National School",
                user_id=str(admin["id"]).encode("utf-8"),
                user_name=admin["email"],
                user_display_name=admin["name"],
                authenticator_selection=AuthenticatorSelectionCriteria(
                    resident_key=ResidentKeyRequirement.REQUIRED,
                    user_verification=UserVerificationRequirement.REQUIRED,
                ),
                exclude_credentials=[PublicKeyCredentialDescriptor(id=row["credential_id"]) for row in existing],
            )
            public_key = json.loads(options_to_json(options))
            session_token = self.cookie_token() or ""
            session_hash = hashlib.sha256(session_token.encode("utf-8")).hexdigest()
            challenge_id = self.save_webauthn_challenge("register", base64url_to_bytes(public_key["challenge"]),
                user_id=admin["id"], session_hash=session_hash)
            self.send_json(200, {"challenge_id": challenge_id, "publicKey": public_key})
            return

        if path == "/api/admin/passkeys/register/verify":
            admin = self.require_role("admin")
            if not PASSKEYS_AVAILABLE:
                raise ApiError(503, "Passkey sign-in needs the BiteHub passkey database migration and server package.")
            challenge_row = self.consume_webauthn_challenge(data.get("challenge_id"), "register")
            session_token = self.cookie_token() or ""
            session_hash = hashlib.sha256(session_token.encode("utf-8")).hexdigest()
            if str(challenge_row["user_id"]) != str(admin["id"]) or not secrets.compare_digest(
                    str(challenge_row["session_hash"] or ""), session_hash):
                raise ApiError(403, "Sign in again before registering this passkey.")
            credential = data.get("credential")
            if not isinstance(credential, dict) or credential.get("type") != "public-key":
                raise ApiError(400, "The device did not return a valid passkey response.")
            rp_id, origin = self.webauthn_context()
            try:
                verification = verify_registration_response(
                    credential=credential,
                    expected_challenge=challenge_row["challenge"],
                    expected_rp_id=rp_id,
                    expected_origin=origin,
                    require_user_verification=True,
                )
            except Exception:
                self.enforce_rate_limit("admin-passkey-register-invalid", admin["id"], 8, 600)
                raise ApiError(400, "BiteHub could not verify that passkey. Please try registering it again.")
            raw_transports = (credential.get("response") or {}).get("transports", [])
            transports = [item for item in raw_transports if isinstance(item, str) and item in {
                "usb", "nfc", "ble", "internal", "hybrid", "smart-card",
            }] if isinstance(raw_transports, list) else []
            with connect() as db:
                duplicate = db.execute("SELECT user_id FROM admin_passkeys WHERE credential_id=?",
                    (verification.credential_id,)).fetchone()
                if duplicate:
                    raise ApiError(409, "That passkey is already registered with BiteHub.")
                active = db.execute("SELECT role FROM users WHERE id=? AND deleted_at IS NULL", (admin["id"],)).fetchone()
                if not active or active["role"] != "admin":
                    raise ApiError(403, "This account no longer has school-admin access.")
                db.execute("""INSERT INTO admin_passkeys
                    (credential_id,user_id,credential_public_key,sign_count,transports,created_at)
                    VALUES(?,?,?,?,?,?)""", (
                        verification.credential_id, admin["id"], verification.credential_public_key,
                        int(verification.sign_count), json.dumps(transports), now(),
                    ))
                count = db.execute("SELECT COUNT(*) FROM admin_passkeys WHERE user_id=?", (admin["id"],)).fetchone()[0]
            self.send_json(201, {"ok": True, "count": count})
            return

        if path == "/api/admin/passkeys/require":
            admin = self.require_role("admin")
            if not PASSKEYS_AVAILABLE:
                raise ApiError(503, "Passkey sign-in needs the BiteHub passkey database migration and server package.")
            with connect() as db:
                count = db.execute("SELECT COUNT(*) FROM admin_passkeys WHERE user_id=?", (admin["id"],)).fetchone()[0]
                if count < 2:
                    raise ApiError(409, "Register a backup passkey on another device or security key before switching sign-in.")
                key = f"admin_passkey_required:{admin['id']}"
                db.execute("""INSERT INTO settings(key,value) VALUES(?,?)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value""", (key, "true"))
            self.send_json(200, {"ok": True, "passkey_only": True})
            return

        if path == "/api/admin/passkeys/login/options":
            if not PASSKEYS_AVAILABLE:
                raise ApiError(503, "Passkey sign-in needs the BiteHub passkey database migration and server package.")
            ip = self.client_ip()
            self.enforce_rate_limit("admin-passkey-login", ip, 20, 600)
            rp_id, _origin = self.webauthn_context()
            with connect() as db:
                rows = db.execute("""SELECT p.credential_id FROM admin_passkeys p
                    JOIN users u ON u.id=p.user_id WHERE u.role='admin' AND u.deleted_at IS NULL""").fetchall()
            if not rows:
                raise ApiError(409, "No admin passkey is registered yet. Sign in with the admin account once, then add passkeys in Settings.")
            options = generate_authentication_options(
                rp_id=rp_id,
                allow_credentials=[PublicKeyCredentialDescriptor(id=row["credential_id"]) for row in rows],
                user_verification=UserVerificationRequirement.REQUIRED,
            )
            public_key = json.loads(options_to_json(options))
            challenge_id = self.save_webauthn_challenge("login", base64url_to_bytes(public_key["challenge"]))
            self.send_json(200, {"challenge_id": challenge_id, "publicKey": public_key})
            return

        if path == "/api/admin/passkeys/login/verify":
            if not PASSKEYS_AVAILABLE:
                raise ApiError(503, "Passkey sign-in needs the BiteHub passkey database migration and server package.")
            ip = self.client_ip()
            self.enforce_rate_limit("admin-passkey-verify", ip, 12, 600)
            challenge_row = self.consume_webauthn_challenge(data.get("challenge_id"), "login")
            credential = data.get("credential")
            if not isinstance(credential, dict) or credential.get("type") != "public-key":
                raise ApiError(400, "The device did not return a valid passkey response.")
            try:
                credential_id = base64url_to_bytes(str(credential.get("rawId") or credential.get("id") or ""))
            except Exception:
                self.enforce_rate_limit("admin-passkey-invalid", ip, 8, 600)
                raise ApiError(401, "That passkey could not sign in to a school-admin account.")
            with connect() as db:
                record = db.execute("""SELECT p.user_id,p.credential_public_key,p.sign_count,u.role
                    FROM admin_passkeys p JOIN users u ON u.id=p.user_id
                    WHERE p.credential_id=? AND u.role='admin' AND u.deleted_at IS NULL""", (credential_id,)).fetchone()
            if not record:
                self.enforce_rate_limit("admin-passkey-invalid", ip, 8, 600)
                raise ApiError(401, "That passkey could not sign in to a school-admin account.")
            rp_id, origin = self.webauthn_context()
            try:
                verification = verify_authentication_response(
                    credential=credential,
                    expected_challenge=challenge_row["challenge"],
                    expected_rp_id=rp_id,
                    expected_origin=origin,
                    credential_public_key=record["credential_public_key"],
                    credential_current_sign_count=int(record["sign_count"]),
                    require_user_verification=True,
                )
            except Exception:
                self.enforce_rate_limit("admin-passkey-invalid", ip, 8, 600)
                raise ApiError(401, "That passkey could not sign in to a school-admin account.")
            with connect() as db:
                active = db.execute("SELECT role FROM users WHERE id=? AND deleted_at IS NULL", (record["user_id"],)).fetchone()
                if not active or active["role"] != "admin":
                    raise ApiError(403, "This account no longer has school-admin access.")
                db.execute("UPDATE admin_passkeys SET sign_count=? WHERE credential_id=?",
                    (int(verification.new_sign_count), credential_id))
            self.clear_rate_limit("admin-passkey-invalid", ip)
            self.send_json(200, {"user": self.current_user_from_id(record["user_id"])}, self.create_session(record["user_id"]))
            return

        if path == "/api/menu-schedule":
            owner = self.require_role("owner")
            if not WEEKLY_MENU_AVAILABLE:
                raise ApiError(503, "The weekly menu planner needs the BiteHub database migration.")
            try:
                product_id = int(data.get("product_id"))
                weekday = int(data.get("weekday"))
            except (TypeError, ValueError):
                raise ValueError("Choose a menu item and day for this weekly plan.")
            service_period = str(data.get("service_period") or "").strip()
            if product_id < 1 or weekday < 0 or weekday > 6:
                raise ValueError("Choose a valid menu item and weekday.")
            if service_period not in {"Morning break", "Lunch", "Afternoon break"}:
                raise ValueError("Choose a valid school break period.")
            stall_id = owner.get("stall_id")
            if not stall_id:
                raise ApiError(403, "This owner account does not have a stall to plan for.")
            with connect() as db:
                product = db.execute("SELECT id FROM products WHERE id=? AND stall_id=?",
                    (product_id, stall_id)).fetchone()
                if not product:
                    raise ApiError(404, "Choose one of your own menu items.")
                timestamp = now()
                db.execute("""INSERT INTO weekly_menu_slots(stall_id,product_id,weekday,service_period,created_at,updated_at)
                    VALUES(?,?,?,?,?,?) ON CONFLICT(stall_id,product_id,weekday,service_period)
                    DO UPDATE SET updated_at=excluded.updated_at""",
                    (stall_id, product_id, weekday, service_period, timestamp, timestamp))
                row = db.execute("""SELECT id FROM weekly_menu_slots WHERE stall_id=? AND product_id=?
                    AND weekday=? AND service_period=?""", (stall_id, product_id, weekday, service_period)).fetchone()
            self.send_json(201, {"schedule_id": row["id"], "ok": True})
            return
        if path == "/api/runner-location":
            try:
                order_id = int(data.get("order_id"))
            except (TypeError, ValueError):
                raise ValueError("This runner link is invalid. Ask the stall owner for a new link.")
            token = data.get("token")
            if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{40,100}", token):
                self.enforce_rate_limit("runner-location-invalid", self.client_ip(), 120, 900)
                raise ApiError(404, "This runner link is no longer active. Ask the stall owner for a fresh link.")
            token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
            try:
                accuracy = float(data.get("accuracy")) if data.get("accuracy") is not None else None
                heading = float(data.get("heading")) if data.get("heading") is not None else None
            except (TypeError, ValueError):
                raise ValueError("Invalid GPS accuracy or heading.")
            if accuracy is not None and (not math.isfinite(accuracy) or accuracy < 0 or accuracy > 1000):
                raise ValueError("Invalid GPS accuracy.")
            if heading is not None and (not math.isfinite(heading) or not 0 <= heading < 360):
                raise ValueError("Invalid GPS heading.")
            with connect() as db:
                order = db.execute("""SELECT o.status,o.fulfillment,o.runner_name,o.runner_id,
                    o.runner_tracking_token_hash,o.runner_tracking_expires_at,COALESCE(u.school_id,'pns') school_id,
                    sc.name school_name,sc.latitude school_latitude,sc.longitude school_longitude,
                    sc.delivery_radius_m FROM orders o JOIN stalls s ON s.id=o.stall_id
                    LEFT JOIN users u ON u.id=o.buyer_id JOIN schools sc ON sc.id=COALESCE(u.school_id,'pns') WHERE o.id=?""",
                    (order_id,)).fetchone()
                if not order or not order["runner_tracking_token_hash"] or not hmac.compare_digest(order["runner_tracking_token_hash"], token_hash):
                    self.enforce_rate_limit("runner-location-invalid", self.client_ip(), 120, 900)
                    raise ApiError(404, "This runner link is no longer active. Ask the stall owner for a fresh link.")
                if order["status"] != "out" or order["fulfillment"] != "delivery":
                    raise ApiError(409, "This delivery has ended. The runner link is no longer active.")
                if not order["runner_name"] and order["runner_id"] is None:
                    raise ApiError(409, "The stall has not assigned a runner to this delivery.")
                expires_at = order["runner_tracking_expires_at"]
                if not expires_at or expires_at <= now():
                    raise ApiError(410, "This runner link has expired. Ask the stall owner for a fresh link.")
                self.enforce_rate_limit("runner-location-token", token_hash, 200, 900)
                latitude, longitude = campus_point(data.get("latitude"), data.get("longitude"),
                    "Runner location", dict(order))
                updated_at = now()
                db.execute("""INSERT INTO delivery_positions(order_id,latitude,longitude,accuracy,heading,updated_at)
                    VALUES(?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET latitude=excluded.latitude,
                    longitude=excluded.longitude,accuracy=excluded.accuracy,heading=excluded.heading,
                    updated_at=excluded.updated_at""",
                    (order_id, latitude, longitude, accuracy, heading, updated_at))
            self.send_json(200, {"ok": True, "runner_name": order["runner_name"], "updated_at": updated_at})
            return
        runner_link_match = re.fullmatch(r"/api/orders/(\d+)/runner-link", path)
        if runner_link_match:
            owner = self.require_role("owner")
            order_id = int(runner_link_match.group(1))
            token = secrets.token_urlsafe(32)
            token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
            expires_at = (datetime.now(timezone.utc) + timedelta(hours=12)).isoformat(timespec="seconds")
            with connect() as db:
                order = db.execute("""SELECT o.status,o.fulfillment,o.runner_name,o.runner_id,s.owner_id
                    FROM orders o JOIN stalls s ON s.id=o.stall_id WHERE o.id=?""", (order_id,)).fetchone()
                if not order or order["owner_id"] != owner["id"]:
                    raise ApiError(404, "Delivery order not found.")
                if order["status"] != "out" or order["fulfillment"] != "delivery":
                    raise ApiError(409, "Start the delivery before creating a runner link.")
                if not order["runner_name"] and order["runner_id"] is None:
                    raise ApiError(409, "Assign a runner before creating a tracking link.")
                db.execute("""UPDATE orders SET runner_tracking_token_hash=?,runner_tracking_expires_at=?
                    WHERE id=? AND status='out' AND fulfillment='delivery'""",
                    (token_hash, expires_at, order_id))
            self.send_json(200, {"ok": True, "token": token, "expires_at": expires_at})
            return
        if path == "/api/reach-views":
            viewer_id, _, is_new = self.reach_viewer()
            if is_new:
                raise ApiError(403, "Refresh the page before recording a view.")
            self.enforce_rate_limit("reach-post", self.client_ip(), 6000, 3600)
            self.enforce_rate_limit("reach-viewer", viewer_id, 80, 3600)
            try:
                stall_id = int(data.get("stall_id"))
                product_id = int(data["product_id"]) if data.get("product_id") is not None else None
            except (TypeError,ValueError,KeyError):
                raise ValueError("Choose a valid stall or menu item.")
            viewed_on = datetime.now(CAMPUS_ZONE).date().isoformat()
            counted = False
            with connect() as db:
                db.execute("BEGIN IMMEDIATE")
                stall = db.execute("SELECT id FROM stalls WHERE id=? AND status='approved'",(stall_id,)).fetchone()
                if not stall: raise ApiError(404,"Stall not found.")
                if product_id is not None:
                    product = db.execute("SELECT id FROM products WHERE id=? AND stall_id=? AND available=1",
                        (product_id,stall_id)).fetchone()
                    if not product: raise ApiError(404,"Menu item not found.")
                viewer_key = hashlib.sha256(viewer_id.encode()).hexdigest()
                exists = db.execute("SELECT 1 FROM reach_views WHERE stall_id=? AND product_id IS ? AND viewed_on=? AND viewer_key=? LIMIT 1",
                    (stall_id,product_id,viewed_on,viewer_key)).fetchone()
                if not exists:
                    db.execute("INSERT INTO reach_views(stall_id,product_id,viewed_on,viewer_key) VALUES(?,?,?,?)",
                        (stall_id,product_id,viewed_on,viewer_key))
                    counted = True
            self.send_json(200,{"counted":counted})
            return
        if path == "/api/notifications/unsubscribe":
            user = self.current_user(required=False)
            guest_session = self.current_guest_session() if not user else None
            if not user and not guest_session:
                raise ApiError(401, "Sign in or continue as a guest to manage device alerts.")
            if guest_session and not GUEST_PUSH_AVAILABLE:
                raise ApiError(503, "Guest device alerts are not enabled on this database yet.")
            endpoint = data.get("endpoint")
            if not isinstance(endpoint, str) or len(endpoint) > 2048:
                raise ValueError("Invalid notification subscription.")
            with connect() as db:
                if user:
                    db.execute("DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?", (user["id"], endpoint))
                else:
                    db.execute("DELETE FROM guest_push_subscriptions WHERE guest_session_id=? AND endpoint=?",
                        (guest_session["id"], endpoint))
            self.send_json(200, {"ok": True})
            return
        if path == "/api/notifications/subscriptions":
            user = self.current_user(required=False)
            guest_session = self.current_guest_session() if not user else None
            if not user and not guest_session:
                raise ApiError(401, "Sign in or continue as a guest to manage device alerts.")
            if guest_session and not GUEST_PUSH_AVAILABLE:
                raise ApiError(503, "Guest device alerts are not enabled on this database yet.")
            subscription = data.get("subscription")
            if not isinstance(subscription, dict): raise ValueError("Invalid notification subscription.")
            endpoint = subscription.get("endpoint")
            parsed_endpoint = urlparse(endpoint) if isinstance(endpoint, str) else None
            keys = subscription.get("keys")
            hostname = (parsed_endpoint.hostname or "").lower() if parsed_endpoint else ""
            trusted_push_host = (hostname == "fcm.googleapis.com" or hostname.endswith(".push.services.mozilla.com") or
                hostname == "push.services.mozilla.com" or hostname.endswith(".push.apple.com") or
                (hostname.endswith(".notify.windows.com") and hostname.startswith("wns")))
            if not isinstance(endpoint, str) or len(endpoint) > 2048 or parsed_endpoint.scheme != "https" or not trusted_push_host:
                raise ValueError("Invalid push service endpoint.")
            if not isinstance(keys, dict) or not all(isinstance(keys.get(k), str) and 8 <= len(keys[k]) <= 256 for k in ("p256dh", "auth")):
                raise ValueError("Invalid notification encryption keys.")
            with connect() as db:
                if user:
                    db.execute("""INSERT INTO push_subscriptions(user_id,endpoint,subscription_json,created_at,updated_at)
                        VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,
                        subscription_json=excluded.subscription_json,updated_at=excluded.updated_at""",
                        (user["id"], endpoint, json.dumps(subscription), now(), now()))
                    if GUEST_PUSH_AVAILABLE:
                        db.execute("DELETE FROM guest_push_subscriptions WHERE endpoint=?", (endpoint,))
                else:
                    db.execute("""INSERT INTO guest_push_subscriptions(guest_session_id,endpoint,subscription_json,created_at,updated_at)
                        VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET guest_session_id=excluded.guest_session_id,
                        subscription_json=excluded.subscription_json,updated_at=excluded.updated_at""",
                        (guest_session["id"], endpoint, json.dumps(subscription), now(), now()))
                    db.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (endpoint,))
            self.send_json(201, {"ok": True})
            return
        if path == "/api/guest/session":
            if self.current_user(required=False):
                raise ApiError(403, "Sign out before continuing as a guest.")
            guest_name = clean_text(data.get("name"), "Name", 80)
            guest_session, cookie_header = self.create_guest_session(guest_name)
            self.send_json(201, {"guest_session": guest_session}, {"Set-Cookie": cookie_header})
            return
        if path == "/api/guest/logout":
            secure = "; Secure" if getattr(self.server, "is_https", False) else ""
            self.send_json(200, {"ok": True}, {
                "Set-Cookie": f"bitehub_guest_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{secure}"
            })
            return
        if path == "/api/email/verify":
            if not email_delivery_ready():
                raise ApiError(503, "Email verification is not enabled yet. You can sign in with your password.")
            token = data.get("token")
            if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{40,100}", token):
                raise ApiError(400, "This verification link is invalid or has expired. Request a new one and try again.")
            token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
            with connect() as db:
                auth_token = db.execute("""SELECT t.user_id FROM email_auth_tokens t
                    JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.purpose='verify'
                    AND t.expires_at>? AND u.deleted_at IS NULL""", (token_hash, int(time.time()))).fetchone()
                if not auth_token:
                    raise ApiError(400, "This verification link is invalid or has expired. Request a new one and try again.")
                db.execute("UPDATE users SET email_verified=TRUE WHERE id=?", (auth_token["user_id"],))
                db.execute("DELETE FROM email_auth_tokens WHERE token_hash=?", (token_hash,))
            self.send_json(200, {"ok": True, "message": "Your email is verified. You can sign in now."})
            return
        if path == "/api/email/verification/resend":
            if not email_delivery_ready():
                raise ApiError(503, "Email delivery is not set up yet. Please try again later.")
            email = str(data.get("email") or "").strip().lower()
            ip = self.client_ip()
            email_key = hashlib.sha256(email.encode("utf-8")).hexdigest()
            self.enforce_rate_limit("email-resend-ip", ip, 30, 3600)
            self.enforce_rate_limit("email-resend-account", email_key, 3, 3600)
            if email_delivery_ready() and re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
                with connect() as db:
                    user = db.execute("SELECT id,email,name FROM users WHERE email=? AND email_verified=FALSE AND deleted_at IS NULL", (email,)).fetchone()
                    if user:
                        token, token_hash = create_email_auth_token(db, user["id"], "verify", EMAIL_VERIFY_SECONDS)
                    else:
                        token = token_hash = None
                if user:
                    try:
                        send_account_email(user["email"], "Verify your BiteHub account", "Verify your email",
                            "Confirm your email address to sign in to your PNS stall account.",
                            "Verify email", "verify_email", token, token_hash)
                    except ApiError:
                        pass
            self.send_json(200, {"ok": True, "message": "If this address needs verification, a new link will arrive shortly."})
            return
        if path == "/api/password/forgot":
            if not email_delivery_ready():
                raise ApiError(503, "Email delivery is not set up yet. Please try again later.")
            email = str(data.get("email") or "").strip().lower()
            ip = self.client_ip()
            email_key = hashlib.sha256(email.encode("utf-8")).hexdigest()
            self.enforce_rate_limit("password-reset-ip", ip, 30, 3600)
            self.enforce_rate_limit("password-reset-account", email_key, 5, 3600)
            if email_delivery_ready() and re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
                with connect() as db:
                    user = db.execute("SELECT id,email,name FROM users WHERE email=? AND email_verified=TRUE AND deleted_at IS NULL", (email,)).fetchone()
                    if user:
                        token, token_hash = create_email_auth_token(db, user["id"], "reset", PASSWORD_RESET_SECONDS)
                    else:
                        token = token_hash = None
                if user:
                    try:
                        send_account_email(user["email"], "Reset your BiteHub password", "Reset your password",
                            "Use this secure link to choose a new password for your PNS stall account.",
                            "Choose a new password", "reset_password", token, token_hash)
                    except ApiError:
                        pass
            self.send_json(200, {"ok": True, "message": "If a BiteHub account uses that email, password reset instructions will arrive shortly."})
            return
        if path == "/api/password/reset":
            if not email_delivery_ready():
                raise ApiError(503, "Email password reset is not enabled yet. Contact the BiteHub administrator for help.")
            token = data.get("token")
            password = data.get("password")
            if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{40,100}", token):
                raise ApiError(400, "This password reset link is invalid or has expired. Request a new one and try again.")
            if not isinstance(password, str) or len(password) < 10:
                raise ApiError(400, "Use a password with at least 10 characters.")
            if len(password) > 1024:
                raise ApiError(400, "Password must be 1,024 characters or fewer.")
            token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
            with connect() as db:
                auth_token = db.execute("""SELECT t.user_id FROM email_auth_tokens t
                    JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.purpose='reset'
                    AND t.expires_at>? AND u.deleted_at IS NULL""", (token_hash, int(time.time()))).fetchone()
                if not auth_token:
                    raise ApiError(400, "This password reset link is invalid or has expired. Request a new one and try again.")
                salt = secrets.token_bytes(16)
                db.execute("UPDATE users SET password_hash=?,password_salt=?,email_verified=TRUE WHERE id=?",
                    (password_digest(password, salt), salt.hex(), auth_token["user_id"]))
                db.execute("DELETE FROM sessions WHERE user_id=?", (auth_token["user_id"],))
                db.execute("DELETE FROM email_auth_tokens WHERE user_id=?", (auth_token["user_id"],))
            self.send_json(200, {"ok": True, "message": "Your password has been changed. Sign in with your new password."})
            return
        if path == "/api/signup":
            name = clean_text(data.get("name"), "Name", 80)
            email = clean_text(data.get("email"), "Email", 254).lower()
            if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email): raise ValueError("Enter a valid email address.")
            password = str(data.get("password") or "")
            if len(password) < 10: raise ValueError("Use a password with at least 10 characters.")
            if len(password) > 1024: raise ValueError("Password must be 1,024 characters or fewer.")
            role = data.get("role")
            if role == "buyer": raise ApiError(400,"Customer accounts are no longer needed. Continue as a guest to order.")
            if role != "owner": raise ApiError(400, "Choose a supported account type.")
            grade_section = ""
            school = PILOT_SCHOOLS["pns"]
            school_region, school_province, school_city = school["region"], school["province"], school["city"]
            school_zip = "5300"
            stall_name = clean_text(data.get("stall_name"), "Stall name", 80) if role == "owner" else None
            salt = secrets.token_bytes(16)
            with connect() as db:
                stall_mode = get_stall_registration_mode(db)
                if stall_mode == "stop_all":
                    raise ApiError(409, "New stall accounts are currently paused by the school administrator.")
                school_id = "pns"
                user_id = insert_id(db, "INSERT INTO users(name,email,password_hash,password_salt,role,school_id,school_region,school_province,school_city,school_zip,grade_section,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                                    (name,email,password_digest(password,salt),salt.hex(),role,school_id,school_region,school_province,school_city,school_zip,grade_section,now()))
                if role == "owner":
                    stall_status = "pending" if stall_mode == "limited" else "approved"
                    db.execute("INSERT INTO stalls(owner_id,name,status,created_at) VALUES(?,?,?,?)",
                        (user_id,stall_name,stall_status,now()))
            self.send_json(201, {"user": self.current_user_from_id(user_id)}, self.create_session(user_id))
            return
        if path == "/api/login":
            email = str(data.get("email") or "").strip().lower()
            password = str(data.get("password") or "")
            requested_role = data.get("role")
            if requested_role is not None and requested_role not in ("buyer", "owner", "admin", "runner"):
                raise ApiError(400, "Choose a supported account type.")
            if len(email) > 254 or len(password) > 1024:
                raise ApiError(400, "Email or password is too long.")
            ip = self.client_ip()
            account_key = hashlib.sha256(f"{ip}|{email}".encode()).hexdigest()
            self.enforce_rate_limit("login-ip", ip, 120, 60)
            self.enforce_rate_limit("login-account", account_key, 8, 600)
            with connect() as db: user = db.execute("SELECT id,password_hash,password_salt,role FROM users WHERE email=? AND deleted_at IS NULL", (email,)).fetchone()
            if user and user["role"] == "admin":
                with connect() as db:
                    passkey_setting = db.execute("SELECT value FROM settings WHERE key=?",
                        (f"admin_passkey_required:{user['id']}",)).fetchone()
                if passkey_setting and passkey_setting["value"] == "true":
                    raise ApiError(401, "This admin account uses passkey-only sign-in. Choose ‘Use a passkey’ instead.")
            if not user or not secrets.compare_digest(password_digest(password,bytes.fromhex(user["password_salt"])),user["password_hash"]):
                raise ApiError(401, "Email or password did not match.")
            if requested_role and user["role"] != requested_role:
                raise ApiError(401, "Your account uses a different sign-in role. Choose the matching role.")
            self.clear_rate_limit("login-account", account_key)
            self.send_json(200, {"user": self.current_user_from_id(user["id"])}, self.create_session(user["id"]))
            return
        if path == "/api/logout":
            token = self.cookie_token()
            if token:
                with connect() as db: db.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
            self.send_json(200, {"ok": True}, {"Set-Cookie": "bitehub_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"})
            return
        if path == "/api/account/delete":
            user = self.current_user()
            password = data.get("password")
            if not isinstance(password, str) or not password or len(password) > 1024:
                raise ValueError("Enter your current password to confirm account deletion.")
            if data.get("confirm") is not True:
                raise ValueError("Confirm that you understand before deleting your account.")
            self.enforce_rate_limit("account-delete", user["id"], 8, 600)
            salt = secrets.token_bytes(16)
            deleted_email = f"deleted-{user['id']}-{secrets.token_hex(8)}@deleted.invalid"
            replacement_password = secrets.token_urlsafe(48)
            with connect() as db:
                db.execute("BEGIN IMMEDIATE")
                account = db.execute("SELECT role,password_hash,password_salt FROM users WHERE id=? AND deleted_at IS NULL", (user["id"],)).fetchone()
                if not account or not secrets.compare_digest(password_digest(password, bytes.fromhex(account["password_salt"])), account["password_hash"]):
                    raise ApiError(401, "Your password did not match. Your account has not been changed.")
                self.clear_rate_limit("account-delete", user["id"])
                if account["role"] == "admin":
                    active_admins = db.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND deleted_at IS NULL AND id<>?", (user["id"],)).fetchone()[0]
                    if active_admins == 0:
                        raise ApiError(409, "This is the only administrator account. Add another administrator before deleting it.")
                active_orders = db.execute("""SELECT o.id FROM orders o LEFT JOIN stalls s ON s.id=o.stall_id
                    WHERE o.status NOT IN ('completed','declined')
                    AND (o.buyer_id=? OR o.runner_id=? OR s.owner_id=?) LIMIT 1""", (user["id"], user["id"], user["id"])).fetchone()
                if active_orders:
                    raise ApiError(409, "Complete or resolve your active orders and deliveries before deleting your account.")
                db.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
                db.execute("DELETE FROM push_subscriptions WHERE user_id=?", (user["id"],))
                db.execute("DELETE FROM feedback WHERE buyer_id=?", (user["id"],))
                db.execute("DELETE FROM delivery_positions WHERE order_id IN (SELECT id FROM orders WHERE buyer_id=? OR runner_id=?)", (user["id"], user["id"]))
                db.execute("UPDATE orders SET runner_id=NULL WHERE runner_id=?", (user["id"],))
                db.execute("UPDATE orders SET buyer_note='',delivery_lat=NULL,delivery_lon=NULL WHERE buyer_id=?", (user["id"],))
                db.execute("""UPDATE stalls SET status='paused',description='',pickup_lat=NULL,pickup_lon=NULL,logo_data=NULL,logo_type=NULL
                    WHERE owner_id=?""", (user["id"],))
                db.execute("""UPDATE users SET name='Deleted account',email=?,password_hash=?,password_salt=?,
                    school_id='pns',school_region='',school_province='',school_city='',school_zip='',
                    profile_photo_data=NULL,profile_photo_type=NULL,profile_photo_version=profile_photo_version+1,deleted_at=?
                    WHERE id=?""", (deleted_email, password_digest(replacement_password, salt), salt.hex(), now(), user["id"]))
            secure = "; Secure" if getattr(self.server, "is_https", False) else ""
            self.send_json(200, {"ok": True, "message": "Your account has been deleted. Past orders no longer show your profile."},
                           {"Set-Cookie": f"bitehub_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{secure}"})
            return
        location_match = re.fullmatch(r"/api/orders/(\d+)/location", path)
        if location_match:
            runner = self.require_role("runner")
            order_id = int(location_match.group(1))
            latitude, longitude = campus_point(data.get("latitude"), data.get("longitude"), "Driver location", runner)
            accuracy = data.get("accuracy")
            heading = data.get("heading")
            try:
                accuracy = float(accuracy) if accuracy is not None else None
                heading = float(heading) if heading is not None else None
            except (TypeError, ValueError):
                raise ValueError("Invalid GPS accuracy or heading.")
            if accuracy is not None and (not math.isfinite(accuracy) or accuracy < 0 or accuracy > 1000):
                raise ValueError("Invalid GPS accuracy.")
            if heading is not None and (not math.isfinite(heading) or not 0 <= heading < 360):
                raise ValueError("Invalid GPS heading.")
            with connect() as db:
                order = db.execute("""SELECT o.status,o.fulfillment,o.runner_id FROM orders o
                    JOIN stalls s ON s.id=o.stall_id WHERE o.id=?""", (order_id,)).fetchone()
                if not order or order["runner_id"] != runner["id"]:
                    raise ApiError(404, "Delivery order not found.")
                if order["fulfillment"] != "delivery" or order["status"] != "out":
                    raise ApiError(409, "Start the delivery before sharing its location.")
                db.execute("""INSERT INTO delivery_positions(order_id,latitude,longitude,accuracy,heading,updated_at)
                    VALUES(?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET latitude=excluded.latitude,
                    longitude=excluded.longitude,accuracy=excluded.accuracy,heading=excluded.heading,
                    updated_at=excluded.updated_at""", (order_id, latitude, longitude, accuracy, heading, now()))
            self.send_json(200, {"ok": True, "updated_at": now()})
            return
        if path == "/api/products":
            owner = self.require_role("owner")
            with connect() as db:
                stall_mode = get_stall_registration_mode(db)
            if stall_mode == "stop_all":
                raise ApiError(409, "Stall product sales are stopped by the school administrator.")
            if owner.get("stall_status") != "approved":
                raise ApiError(409, "Your stall must be approved before you can publish menu items.")
            name = clean_text(data.get("name"), "Item name", 80)
            desc = clean_text(data.get("description"), "Description", 240, required=False)
            ingredients = clean_text(data.get("ingredients"), "Ingredients", 700, required=False)
            category = data.get("category")
            if category not in ("Meals", "Snacks", "Drinks"): raise ValueError("Choose a menu category.")
            price = cents(data.get("price"))
            emoji = clean_text(data.get("emoji", "🍽️"), "Food icon", 8)
            stock_count = parse_stock_count(data.get("stock_count"))
            dietary_tags = parse_tags(data.get("dietary_tags", []), DIETARY_TAGS, "dietary tags")
            allergen_tags = parse_tags(data.get("allergen_tags", []), ALLERGEN_TAGS, "allergen information")
            photo_data = photo_type = None
            if "photo_data" in data or "photo_type" in data:
                photo_data, photo_type = parse_product_photo(data.get("photo_data"), data.get("photo_type"))
            with connect() as db:
                stall_mode = get_stall_registration_mode(db)
                stall = db.execute("SELECT status FROM stalls WHERE id=? AND owner_id=?",
                    (owner.get("stall_id"), owner["id"])).fetchone()
                if stall_mode == "stop_all":
                    raise ApiError(409, "Stall product sales are stopped by the school administrator.")
                if not stall or stall["status"] != "approved":
                    raise ApiError(409, "Your stall must be approved before you can publish menu items.")
                product_id = insert_id(db, """INSERT INTO products(stall_id,name,description,ingredients,category,price_cents,emoji,stock_count,
                    dietary_tags,allergen_tags,photo_data,photo_type,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (owner["stall_id"],name,desc,ingredients,category,price,emoji,stock_count,json.dumps(dietary_tags),json.dumps(allergen_tags),photo_data,photo_type,now()))
                row = db.execute("""SELECT p.*,s.id stall_id,s.name stall_name,s.status stall_status,s.opens_at,s.closes_at,
                    s.pickup_lat,s.pickup_lon
                    FROM products p JOIN stalls s ON s.id=p.stall_id WHERE p.id=?""", (product_id,)).fetchone()
            self.send_json(201, {"product": self.product_json(row)})
            return
        order_messages_match = re.fullmatch(r"/api/orders/(\d+)/messages", path)
        if order_messages_match:
            if not ORDER_MESSAGES_AVAILABLE:
                raise ApiError(503, "Order messages are not enabled on this database yet. Apply the BiteHub order messages migration and restart the server.")
            order_id = int(order_messages_match.group(1))
            user = self.current_user(required=False)
            token = data.get("token")
            with connect() as db:
                order = db.execute("""SELECT o.id,o.buyer_id,o.guest_session_id,o.guest_name,o.guest_access_token_hash,s.owner_id
                    FROM orders o JOIN stalls s ON s.id=o.stall_id WHERE o.id=?""", (order_id,)).fetchone()
                if not order:
                    raise ApiError(404, "Order not found.")
                token_hash = ""
                if user:
                    if user["role"] == "buyer" and order["buyer_id"] == user["id"]:
                        sender_role, sender_user_id, sender_name = "buyer", user["id"], user["name"]
                    elif user["role"] == "owner" and order["owner_id"] == user["id"]:
                        sender_role, sender_user_id, sender_name = "owner", user["id"], user["name"]
                    else:
                        raise ApiError(404, "Order not found.")
                else:
                    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{40,100}", token):
                        self.enforce_rate_limit("guest-order-message-invalid", self.client_ip(), 120, 900)
                        raise ApiError(404, "Order not found.")
                    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
                    stored_hash = order["guest_access_token_hash"] or ""
                    if order["buyer_id"] is not None or not stored_hash or not hmac.compare_digest(stored_hash, token_hash):
                        self.enforce_rate_limit("guest-order-message-invalid", self.client_ip(), 120, 900)
                        raise ApiError(404, "Order not found.")
                    sender_role, sender_user_id = "guest", None
                    sender_name = order["guest_name"] or "Guest"

                action = data.get("action", "list")
                if action == "list":
                    rows = db.execute("""SELECT id,sender_role,sender_name,message,created_at
                        FROM order_messages WHERE order_id=? ORDER BY id DESC LIMIT 200""", (order_id,)).fetchall()
                    messages = [{"id": row["id"], "sender_role": row["sender_role"],
                        "sender_name": row["sender_name"], "message": row["message"],
                        "created_at": row["created_at"]} for row in reversed(rows)]
                    self.send_json(200, {"messages": messages})
                    return
                if action != "send":
                    raise ApiError(400, "Choose whether to load or send order messages.")
                raw_message = data.get("message")
                if not isinstance(raw_message, str):
                    raise ValueError("Write a message before sending it.")
                message = re.sub(r"[\r\n\t\x00-\x1f\x7f]+", " ", raw_message).strip()
                if not message:
                    raise ValueError("Write a message before sending it.")
                if len(message) > 1000:
                    raise ValueError("Messages can be up to 1,000 characters.")
                identity = f"{order_id}:{sender_user_id if sender_user_id is not None else token_hash}"
                self.enforce_rate_limit("order-message-send", identity, 30, 60)
                row = db.execute("""INSERT INTO order_messages
                    (order_id,sender_role,sender_user_id,sender_name,message,created_at)
                    VALUES(?,?,?,?,?,?) RETURNING id,sender_role,sender_name,message,created_at""",
                    (order_id, sender_role, sender_user_id, sender_name, message, now())).fetchone()
            notification = {
                    "title": "New order message",
                    "body": f"You have a new message about order #{order_id}.",
                    "url": "/#buyer-orders" if sender_role == "owner" else "/#owner-orders",
                    "tag": f"bitehub-message-{order_id}",
                }
            if sender_role == "owner":
                dispatch_order_buyer_push(order["buyer_id"], order["guest_session_id"], notification)
            else:
                dispatch_push([order["owner_id"]], notification)
            self.send_json(201, {"message": {"id": row["id"], "sender_role": row["sender_role"],
                "sender_name": row["sender_name"], "message": row["message"], "created_at": row["created_at"]}})
            return
        guest_order_match = re.fullmatch(r"/api/guest/orders/(\d+)", path)
        if guest_order_match:
            token = data.get("token")
            if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{40,100}", token):
                self.enforce_rate_limit("guest-order-invalid", self.client_ip(), 120, 900)
                raise ApiError(404, "Guest order not found.")
            token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
            order_id = int(guest_order_match.group(1))
            with connect() as db:
                row = db.execute("""SELECT o.*,COALESCE(NULLIF(o.guest_name,''),u.name,'Guest') buyer_name,COALESCE(u.email,'') buyer_email,
                    s.name stall_name,r.name account_runner_name,s.pickup_lat stall_latitude,s.pickup_lon stall_longitude,
                    dp.latitude driver_latitude,dp.longitude driver_longitude,dp.accuracy driver_accuracy,
                    dp.heading driver_heading,dp.updated_at driver_updated_at
                    FROM orders o LEFT JOIN users u ON u.id=o.buyer_id JOIN stalls s ON s.id=o.stall_id
                    JOIN users owner ON owner.id=s.owner_id LEFT JOIN users r ON r.id=o.runner_id
                    LEFT JOIN delivery_positions dp ON dp.order_id=o.id
                    WHERE o.id=? AND o.buyer_id IS NULL AND o.guest_access_token_hash=?""",
                    (order_id,token_hash)).fetchone()
                if not row:
                    self.enforce_rate_limit("guest-order-invalid", self.client_ip(), 120, 900)
                    raise ApiError(404, "Guest order not found.")
                result = self.orders_json(db,[row],include_pickup_codes=True)[0]
            self.send_json(200,{"order":result})
            return
        if path in ("/api/orders", "/api/guest/orders"):
            with connect() as db:
                stall_mode = get_stall_registration_mode(db)
            if stall_mode == "stop_all":
                raise ApiError(409, "Campus stall sales are temporarily stopped by the school administrator.")
            guest_order = path == "/api/guest/orders"
            if guest_order and self.current_user(required=False):
                raise ApiError(403,"Sign out before placing a guest order.")
            buyer = None if guest_order else self.require_role("buyer")
            guest_name = clean_text(data.get("guest_name"),"Name for this order",80) if guest_order else ""
            guest_school_role = guest_grade = guest_section = ""
            guest_token = secrets.token_urlsafe(32) if guest_order else ""
            guest_token_hash = hashlib.sha256(guest_token.encode("utf-8")).hexdigest() if guest_token else ""
            guest_session = self.current_guest_session() if guest_order else None
            guest_session_cookie = None
            if guest_order and not guest_session:
                guest_session, guest_session_cookie = self.create_guest_session(guest_name)
            if data.get("fulfillment") not in ("pickup", "delivery"): raise ValueError("Choose pickup or campus delivery.")
            delivery_lat = delivery_lon = None
            if data["fulfillment"] == "delivery":
                if guest_order:
                    guest_school_role = clean_text(data.get("guest_school_role"), "School role", 32)
                    allowed_guest_roles = {"junior_student", "senior_student", "teacher", "staff"}
                    if guest_school_role not in allowed_guest_roles:
                        raise ValueError("Choose your school role for delivery.")
                    guest_section = clean_text(data.get("guest_section"), "Section or office", 80)
                    if guest_school_role in ("junior_student", "senior_student"):
                        guest_grade = clean_text(data.get("guest_grade"), "Grade", 2)
                        allowed_grades = {"7", "8", "9", "10"} if guest_school_role == "junior_student" else {"11", "12"}
                        if guest_grade not in allowed_grades:
                            raise ValueError("Choose a grade that matches your school role.")
                point = data.get("delivery_location") or {}
                if buyer:
                    location_school = buyer
                else:
                    school = PILOT_SCHOOLS["pns"]
                    location_school = {"school_id":"pns","school_latitude":school["latitude"],
                        "school_longitude":school["longitude"],"delivery_radius_m":school["radius"]}
                delivery_lat, delivery_lon = campus_point(point.get("latitude"), point.get("longitude"), "Delivery location", location_school)
            pickup_at=None
            if data["fulfillment"]=="pickup" and data.get("pickup_at"):
                try:
                    requested_pickup=datetime.fromisoformat(str(data["pickup_at"]))
                    if requested_pickup.tzinfo is None: raise ValueError()
                    pickup_at=requested_pickup.astimezone(CAMPUS_ZONE).isoformat(timespec="seconds")
                except (TypeError,ValueError):
                    raise ValueError("Choose a valid pickup time.")
            entries = data.get("items")
            if not isinstance(entries,list) or not entries or len(entries)>30: raise ValueError("Add at least one menu item.")
            ids, quantities = set(), {}
            for entry in entries:
                try: product_id, quantity = int(entry["product_id"]), int(entry["quantity"])
                except (KeyError, TypeError, ValueError): raise ValueError("The cart contains an invalid item.")
                if quantity < 1 or quantity > 50: raise ValueError("Item quantities must be between 1 and 50.")
                ids.add(product_id); quantities[product_id] = quantities.get(product_id,0)+quantity
            if any(quantity > 50 for quantity in quantities.values()): raise ValueError("Item quantities must be 50 or less.")
            note = clean_text(data.get("note"), "Order note", 240, required=False)
            with connect() as db:
                db.execute("BEGIN IMMEDIATE")
                if get_stall_registration_mode(db) == "stop_all":
                    raise ApiError(409, "Campus stall sales are temporarily stopped by the school administrator.")
                if guest_order:
                    db.execute("UPDATE guest_sessions SET guest_name=?,expires_at=? WHERE id=?",
                        (guest_name,int(time.time())+GUEST_SESSION_SECONDS,guest_session["id"]))
                paused = db.execute("SELECT value FROM settings WHERE key='ordering_paused'").fetchone()[0] == "true"
                if paused: raise ApiError(409, "Ordering is temporarily paused.")
                marks = ",".join("?" for _ in ids)
                products = db.execute(f"""SELECT p.*,s.id stall_id,s.name stall_name,s.status stall_status,s.opens_at,s.closes_at
                    FROM products p JOIN stalls s ON s.id=p.stall_id
                    WHERE p.id IN ({marks}) AND p.available=1 AND s.status='approved'""", list(ids)).fetchall()
                if len(products) != len(ids): raise ApiError(409, "One or more items are no longer available. Refresh the menu and try again.")
                if len({row["stall_id"] for row in products}) != 1: raise ValueError("Place separate orders for each stall.")
                stall = products[0]
                if stall_on_break(db, stall["stall_id"]):
                    raise ApiError(409, "This stall is taking a short break and is not accepting new orders right now.")
                if pickup_at:
                    slots=pickup_slots(db,stall["stall_id"])
                    if pickup_at not in {slot["pickup_at"] for slot in slots}:
                        raise ApiError(409,"That pickup window just filled or is no longer available. Choose another time.")
                if not stall_is_open(stall["opens_at"],stall["closes_at"]):
                    raise ApiError(409,"This stall is closed. Please order during its posted hours.")
                for product in products:
                    if product["stock_count"] is not None and quantities[product["id"]] > product["stock_count"]:
                        raise ApiError(409,f"Only {product['stock_count']} of {product['name']} remain.")
                for product in products:
                    if product["stock_count"] is not None:
                        changed = db.execute("UPDATE products SET stock_count=stock_count-? WHERE id=? AND stock_count>=?",
                            (quantities[product["id"]],product["id"],quantities[product["id"]]))
                        if not changed.rowcount:
                            raise ApiError(409,f"Stock for {product['name']} just changed. Refresh the menu and try again.")
                total = sum(row["price_cents"]*quantities[row["id"]] for row in products)
                pickup_code = new_pickup_code(db) if guest_order or data["fulfillment"] == "pickup" else ""
                order_id = insert_id(db, """INSERT INTO orders(buyer_id,guest_name,guest_school_role,guest_grade,guest_section,
                    guest_session_id,guest_access_token_hash,guest_pickup_code,stall_id,fulfillment,status,total_cents,buyer_note,
                    created_at,updated_at,pickup_at,delivery_lat,delivery_lon)
                    VALUES(?,?,?,?,?,?,?,?,?,?,'placed',?,?,?,?,?,?,?)""",
                    (buyer["id"] if buyer else None,guest_name,guest_school_role,guest_grade,guest_section,
                     guest_session["id"] if guest_order else None,guest_token_hash,pickup_code,
                     products[0]["stall_id"],data["fulfillment"],total,note,
                     now(),now(),pickup_at,delivery_lat,delivery_lon))
                stall_owner_id = db.execute("SELECT owner_id FROM stalls WHERE id=?", (products[0]["stall_id"],)).fetchone()[0]
                for product in products:
                    db.execute("INSERT INTO order_items(order_id,product_id,name,price_cents,quantity,emoji) VALUES(?,?,?,?,?,?)",
                               (order_id,product["id"],product["name"],product["price_cents"],quantities[product["id"]],product["emoji"]))
            dispatch_push([stall_owner_id], {"title": "New BiteHub order", "body": f"New order #{order_id} is waiting at your stall.", "url": "/#owner-orders", "tag": f"bitehub-order-{order_id}"})
            result = {"order_id":order_id}
            if guest_order:
                result.update({"guest_token":guest_token,"pickup_code":pickup_code,
                    "guest_session_id":guest_session["id"]})
            response_headers = {"Set-Cookie": guest_session_cookie} if guest_session_cookie else None
            self.send_json(201,result,response_headers)
            return
        feedback_match = re.fullmatch(r"/api/orders/(\d+)/feedback", path)
        if feedback_match:
            order_id = int(feedback_match.group(1))
            reviewer = self.current_user(required=False)
            try: rating = int(data.get("rating"))
            except (TypeError, ValueError): raise ValueError("Choose a rating from 1 to 5.")
            if rating < 1 or rating > 5: raise ValueError("Choose a rating from 1 to 5.")
            comment = clean_text(data.get("comment"), "Feedback", 500, required=False)
            with connect() as db:
                order = db.execute("SELECT status,buyer_id,guest_access_token_hash FROM orders WHERE id=?", (order_id,)).fetchone()
                if not order: raise ApiError(404, "Order not found.")
                if reviewer:
                    if reviewer["role"] != "buyer" or order["buyer_id"] != reviewer["id"]:
                        raise ApiError(404, "Order not found.")
                else:
                    if not GUEST_FEEDBACK_AVAILABLE:
                        raise ApiError(503, "Guest reviews are not enabled on this database yet. Apply the guest-order-feedback Supabase migration and restart the server.")
                    guest_token = data.get("guest_token")
                    if not isinstance(guest_token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{40,100}", guest_token):
                        self.enforce_rate_limit("guest-feedback-invalid", self.client_ip(), 120, 900)
                        raise ApiError(404, "Order not found.")
                    supplied_hash = hashlib.sha256(guest_token.encode("utf-8")).hexdigest()
                    stored_hash = order["guest_access_token_hash"] or ""
                    if order["buyer_id"] is not None or not stored_hash or not hmac.compare_digest(stored_hash, supplied_hash):
                        self.enforce_rate_limit("guest-feedback-invalid", self.client_ip(), 120, 900)
                        raise ApiError(404, "Order not found.")
                if order["status"] != "completed": raise ApiError(409, "Feedback is available after your order is completed.")
                inserted = db.execute("INSERT INTO feedback(order_id,buyer_id,rating,comment,created_at) VALUES(?,?,?,?,?) ON CONFLICT(order_id) DO NOTHING",
                    (order_id, reviewer["id"] if reviewer else None, rating, comment, now()))
                if not inserted.rowcount:
                    raise ApiError(409, "Feedback has already been submitted for this order.")
            self.send_json(201, {"ok":True}); return
        if path == "/api/admin/pause":
            self.require_role("admin")
            paused = bool(data.get("paused"))
            with connect() as db: db.execute("UPDATE settings SET value=? WHERE key='ordering_paused'", ("true" if paused else "false",))
            self.send_json(200, {"ordering_paused": paused})
            return
        raise ApiError(404, "That API route does not exist.")

    def api_patch(self, path, data):
        if path == "/api/admin/stall-policy":
            self.require_role("admin")
            mode = data.get("mode")
            if mode not in STALL_REGISTRATION_MODES:
                raise ValueError("Choose Allow all, Limited approval, or Stop all.")
            with connect() as db:
                db.execute("INSERT INTO settings(key,value) VALUES('stall_registration_mode',?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (mode,))
            labels = {"allow_all":"All stalls may register and sell.",
                      "limited":"New stall accounts need admin approval before selling.",
                      "stop_all":"New stall accounts and stall sales are stopped."}
            self.send_json(200, {"stall_registration_mode":mode,"message":labels[mode]})
            return
        if path == "/api/notifications/inbox/read-all":
            user = self.current_user(required=False)
            guest_session = self.current_guest_session() if not user else None
            if not user and not guest_session:
                raise ApiError(401, "Sign in or continue as a guest to update your notifications.")
            if not NOTIFICATION_INBOX_AVAILABLE:
                raise ApiError(503, "The in-app notification inbox needs the BiteHub database migration.")
            scope, identifier = ("user_id", user["id"]) if user else ("guest_session_id", guest_session["id"])
            with connect() as db:
                db.execute(f"UPDATE notifications SET read_at=? WHERE {scope}=? AND read_at IS NULL", (now(), identifier))
            self.send_json(200, {"ok": True})
            return
        inbox_match = re.fullmatch(r"/api/notifications/inbox/(\d+)", path)
        if inbox_match:
            user = self.current_user(required=False)
            guest_session = self.current_guest_session() if not user else None
            if not user and not guest_session:
                raise ApiError(401, "Sign in or continue as a guest to update your notifications.")
            if not NOTIFICATION_INBOX_AVAILABLE:
                raise ApiError(503, "The in-app notification inbox needs the BiteHub database migration.")
            scope, identifier = ("user_id", user["id"]) if user else ("guest_session_id", guest_session["id"])
            with connect() as db:
                result = db.execute(f"UPDATE notifications SET read_at=? WHERE id=? AND {scope}=?",
                    (now(), int(inbox_match.group(1)), identifier))
                if result.rowcount != 1:
                    raise ApiError(404, "Notification not found.")
            self.send_json(200, {"ok": True})
            return
        if path == "/api/stall/break":
            owner = self.require_role("owner")
            on_break = data.get("on_break")
            if not isinstance(on_break, bool):
                raise ValueError("Choose whether your stall is taking a short break.")
            if not owner.get("stall_id"):
                raise ApiError(404, "Your stall account is not available.")
            key = f"stall_break:{int(owner['stall_id'])}"
            with connect() as db:
                if on_break:
                    db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (key, "true"))
                else:
                    db.execute("DELETE FROM settings WHERE key=?", (key,))
            self.send_json(200, {"on_break": on_break})
            return
        if path == "/api/profile":
            user = self.current_user()
            name = clean_text(data.get("name", user["name"]), "Your name", 80)
            remove_photo = data.get("remove_photo", False)
            if not isinstance(remove_photo, bool): raise ValueError("Choose whether to remove your profile photo.")
            if remove_photo and ("photo_data" in data or "photo_type" in data):
                raise ValueError("Choose a new photo or remove the existing one, not both.")
            with connect() as db:
                existing = db.execute("SELECT profile_photo_data,profile_photo_type FROM users WHERE id=?", (user["id"],)).fetchone()
                photo_data, photo_type = existing["profile_photo_data"], existing["profile_photo_type"]
                if remove_photo:
                    photo_data = photo_type = None
                elif "photo_data" in data or "photo_type" in data:
                    photo_data, photo_type = parse_product_photo(data.get("photo_data"), data.get("photo_type"), "profile photo")
                version = time.time_ns() // 1_000_000 if photo_type else 0
                db.execute("UPDATE users SET name=?,profile_photo_data=?,profile_photo_type=?,profile_photo_version=? WHERE id=?",
                    (name, photo_data, photo_type, version, user["id"]))
            self.send_json(200, {"user": self.current_user_from_id(user["id"])})
            return
        if path == "/api/stall/feature":
            owner = self.require_role("owner")
            try: product_id = int(data.get("product_id"))
            except (TypeError, ValueError): raise ValueError("Choose a menu item to feature.")
            featured = data.get("featured")
            if not isinstance(featured, bool): raise ValueError("Choose whether to feature this item.")
            with connect() as db:
                product = db.execute("""SELECT p.id,p.available,p.stock_count,s.id stall_id,s.status stall_status
                    FROM products p JOIN stalls s ON s.id=p.stall_id
                    WHERE p.id=? AND s.owner_id=?""", (product_id, owner["id"])).fetchone()
                if not product: raise ApiError(404, "Menu item not found.")
                if featured and product["stall_status"] != "approved": raise ApiError(409, "Your stall must be open to feature an item.")
                if featured and (not product["available"] or product["stock_count"] == 0):
                    raise ApiError(409, "Only an available menu item can be featured.")
                if featured:
                    expires = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(timespec="seconds")
                    db.execute("UPDATE products SET featured_until=NULL WHERE stall_id=?", (product["stall_id"],))
                    db.execute("UPDATE products SET featured_until=? WHERE id=?", (expires, product_id))
                else:
                    expires = None
                    db.execute("UPDATE products SET featured_until=NULL WHERE id=?", (product_id,))
            self.send_json(200, {"product_id": product_id, "featured": featured, "featured_until": expires})
            return
        if path == "/api/stall/profile/logo":
            owner = self.require_role("owner")
            remove_logo = data.get("remove_logo", False)
            if not isinstance(remove_logo, bool): raise ValueError("Choose whether to remove the stall logo.")
            if remove_logo and ("logo_data" in data or "logo_type" in data):
                raise ValueError("Choose a new logo or remove the existing one, not both.")
            if remove_logo:
                logo_data = logo_type = None
            else:
                logo_data, logo_type = parse_product_photo(data.get("logo_data"), data.get("logo_type"), "stall logo")
            with connect() as db:
                cur = db.execute("UPDATE stalls SET logo_data=?,logo_type=? WHERE owner_id=?",
                    (logo_data,logo_type,owner["id"]))
                if not cur.rowcount: raise ApiError(404, "Stall not found.")
                stall_id = db.execute("SELECT id FROM stalls WHERE owner_id=?",(owner["id"],)).fetchone()[0]
            self.send_json(200,{"logo_url":f"/api/stalls/{stall_id}/logo" if logo_type else None})
            return
        if path == "/api/stall/profile":
            owner = self.require_role("owner")
            name = clean_text(data.get("name"), "Stall name", 80)
            description = clean_text(data.get("description"), "Stall description", 500, required=False)
            with connect() as db:
                cur = db.execute("UPDATE stalls SET name=?,description=? WHERE owner_id=?",
                    (name, description, owner["id"]))
                if not cur.rowcount: raise ApiError(404, "Stall not found.")
            self.send_json(200, {"name": name, "description": description})
            return
        if path == "/api/stall/location":
            owner = self.require_role("owner")
            latitude, longitude = campus_point(data.get("latitude"), data.get("longitude"), "Stall pickup point", owner)
            with connect() as db:
                cur = db.execute("UPDATE stalls SET pickup_lat=?,pickup_lon=? WHERE owner_id=?",
                    (latitude, longitude, owner["id"]))
                if not cur.rowcount: raise ApiError(404, "Stall not found.")
            self.send_json(200, {"pickup_latitude": latitude, "pickup_longitude": longitude})
            return
        if path == "/api/stall/hours":
            owner = self.require_role("owner")
            opens_at, closes_at = parse_hours(data.get("opens_at"),data.get("closes_at"))
            try: prep_minutes = int(data.get("prep_minutes"))
            except (TypeError,ValueError): raise ValueError("Prep time must be a whole number of minutes.")
            if isinstance(data.get("prep_minutes"),bool) or not 1 <= prep_minutes <= 180:
                raise ValueError("Prep time must be between 1 and 180 minutes.")
            with connect() as db:
                cur = db.execute("UPDATE stalls SET opens_at=?,closes_at=?,prep_minutes=? WHERE owner_id=?",
                    (opens_at,closes_at,prep_minutes,owner["id"]))
                if not cur.rowcount: raise ApiError(404,"Stall not found.")
            self.send_json(200,{"opens_at":opens_at,"closes_at":closes_at,"prep_minutes":prep_minutes}); return
        stall_match = re.fullmatch(r"/api/admin/stalls/(\d+)", path)
        if stall_match:
            self.require_role("admin")
            status = data.get("status")
            if status not in ("approved", "paused"):
                raise ValueError("Choose approved or paused stall status.")
            with connect() as db:
                cur = db.execute("""UPDATE stalls SET status=? WHERE id=? AND owner_id IN
                    (SELECT id FROM users WHERE school_id='pns' AND deleted_at IS NULL)""", (status,int(stall_match.group(1))))
                if not cur.rowcount: raise ApiError(404,"Stall not found.")
            self.send_json(200,{"status":status}); return
        product_match = re.fullmatch(r"/api/products/(\d+)", path)
        if product_match:
            owner = self.require_role("owner")
            product_id = int(product_match.group(1))
            with connect() as db:
                row = db.execute("SELECT p.* FROM products p JOIN stalls s ON s.id=p.stall_id WHERE p.id=? AND s.owner_id=?", (product_id,owner["id"])).fetchone()
                if not row: raise ApiError(404, "Menu item not found.")
                if set(data) == {"available"}:
                    available = data["available"]
                    if not isinstance(available,bool): raise ValueError("Availability must be true or false.")
                    db.execute("UPDATE products SET available=?,featured_until=CASE WHEN ?=FALSE THEN NULL ELSE featured_until END WHERE id=?",
                        (available,available,product_id))
                    self.send_json(200, {"ok":True}); return
                name = clean_text(data.get("name",row["name"]), "Item name", 80)
                desc = clean_text(data.get("description",row["description"]), "Description", 240, required=False)
                ingredients = clean_text(data.get("ingredients",row["ingredients"]), "Ingredients", 700, required=False)
                category = data.get("category",row["category"])
                if category not in ("Meals", "Snacks", "Drinks"): raise ValueError("Choose a menu category.")
                price = cents(data.get("price",row["price_cents"] / 100))
                emoji = clean_text(data.get("emoji",row["emoji"]), "Food icon", 8)
                stock_count = parse_stock_count(data.get("stock_count",row["stock_count"]))
                dietary_tags = parse_tags(data.get("dietary_tags",json.loads(row["dietary_tags"] or "[]")),DIETARY_TAGS,"dietary tags")
                allergen_tags = parse_tags(data.get("allergen_tags",json.loads(row["allergen_tags"] or "[]")),ALLERGEN_TAGS,"allergen information")
                remove_photo = data.get("remove_photo", False)
                if not isinstance(remove_photo, bool): raise ValueError("Choose whether to remove the current photo.")
                if remove_photo and ("photo_data" in data or "photo_type" in data): raise ValueError("Choose a new photo or remove the current one, not both.")
                photo_data, photo_type = row["photo_data"], row["photo_type"]
                if remove_photo:
                    photo_data = photo_type = None
                elif "photo_data" in data or "photo_type" in data:
                    photo_data, photo_type = parse_product_photo(data.get("photo_data"), data.get("photo_type"))
                db.execute("""UPDATE products SET name=?,description=?,ingredients=?,category=?,price_cents=?,emoji=?,stock_count=?,
                    dietary_tags=?,allergen_tags=?,photo_data=?,photo_type=? WHERE id=?""",
                    (name,desc,ingredients,category,price,emoji,stock_count,json.dumps(dietary_tags),json.dumps(allergen_tags),photo_data,photo_type,product_id))
                updated = db.execute("""SELECT p.*,s.id stall_id,s.name stall_name,s.status stall_status,s.opens_at,s.closes_at,
                    s.pickup_lat,s.pickup_lon
                    FROM products p JOIN stalls s ON s.id=p.stall_id WHERE p.id=?""", (product_id,)).fetchone()
            self.send_json(200, {"product":self.product_json(updated)}); return
        order_match = re.fullmatch(r"/api/orders/(\d+)", path)
        if order_match:
            order_id, action = int(order_match.group(1)), data.get("action")
            if action == "cancel-pending" and not ORDER_CANCELLATION_AVAILABLE:
                raise ApiError(503, "Order editing is not enabled on this database yet. Apply the buyer-order-cancellation Supabase migration, then restart BiteHub.")
            user = self.current_user(required=False)
            with connect() as db:
                db.execute("BEGIN IMMEDIATE")
                order = db.execute("SELECT o.*,s.owner_id,s.prep_minutes FROM orders o JOIN stalls s ON s.id=o.stall_id WHERE o.id=?", (order_id,)).fetchone()
                if not order: raise ApiError(404, "Order not found.")
                guest_access = False
                if user is None:
                    guest_token = data.get("guest_token")
                    if isinstance(guest_token,str) and re.fullmatch(r"[A-Za-z0-9_-]{40,100}",guest_token):
                        supplied_hash = hashlib.sha256(guest_token.encode("utf-8")).hexdigest()
                        stored_hash = order["guest_access_token_hash"] or ""
                        guest_access = order["buyer_id"] is None and bool(stored_hash) and hmac.compare_digest(stored_hash,supplied_hash)
                    if not guest_access:
                        raise ApiError(404,"Guest order not found.")
                next_status, expected_status = None, None
                runner_name = order["runner_name"]
                special_action = None
                if user and user["role"] == "owner" and order["owner_id"] == user["id"]:
                    transitions = {"confirm":("placed","confirmed"),"decline":("placed","declined"),"prepare":("confirmed","preparing"),"ready":("preparing","ready")}
                    if action == "verify-pickup":
                        if order["status"] != "ready" or order["fulfillment"] != "pickup":
                            raise ApiError(409,"Only a ready pickup order can be verified.")
                        supplied_code = data.get("pickup_code")
                        if not isinstance(supplied_code, str) or not re.fullmatch(r"[A-HJ-NP-Z2-9]{8}", supplied_code.strip().upper()):
                            raise ValueError("Enter the 8-character pickup code shown by the customer.")
                        self.enforce_rate_limit("pickup-code-verify", str(user["id"]), 10, 300)
                        stored_code = order["guest_pickup_code"] or ""
                        if not stored_code or not hmac.compare_digest(stored_code, supplied_code.strip().upper()):
                            raise ApiError(403,"That pickup code does not match this order. Check the code with the customer.")
                        expected_status,next_status = "ready","completed"
                    elif action == "assign":
                        if order["status"] != "ready" or order["fulfillment"] != "delivery": raise ApiError(409,"Only ready delivery orders can be assigned.")
                        if order["pickup_offer_status"] == "pending": raise ApiError(409,"Wait for the customer to respond to the pickup offer.")
                        runner_name = clean_text(data.get("runner_name"),"Runner name",80)
                        special_action = "assign"
                    elif action == "offer-pickup":
                        if order["status"] != "ready" or order["fulfillment"] != "delivery": raise ApiError(409,"Pickup can only be offered for a ready delivery order.")
                        if order["pickup_offer_status"] == "pending": raise ApiError(409,"The customer already has a pickup offer to answer.")
                        special_action = "offer-pickup"
                    elif action == "out":
                        if order["status"] != "ready" or order["fulfillment"] != "delivery": raise ApiError(409,"Only ready delivery orders can be sent out.")
                        if order["pickup_offer_status"] == "pending": raise ApiError(409,"Wait for the customer to respond to the pickup offer.")
                        if not (runner_name or order["runner_id"]): raise ValueError("Assign a runner name before sending this order out.")
                        expected_status,next_status = "ready","out"
                    elif action == "delivered":
                        if order["status"] != "out" or order["fulfillment"] != "delivery": raise ApiError(409,"Only an order on the way can be marked delivered.")
                        expected_status,next_status = "out","completed"
                    elif action in transitions:
                        expected_status,next_status = transitions[action]
                        if order["status"] != expected_status: raise ApiError(409,"That order has already changed. Refresh and try again.")
                    else: raise ApiError(400,"That order action is not supported.")
                elif user and user["role"] == "runner" and order["runner_id"] == user["id"]:
                    transitions = {"out":("ready","out"),"delivered":("out","completed")}
                    if action not in transitions: raise ApiError(400,"That order action is not supported.")
                    expected_status,next_status = transitions[action]
                    if order["status"] != expected_status: raise ApiError(409,"That order has already changed. Refresh and try again.")
                elif (user and user["role"] == "buyer" and order["buyer_id"] == user["id"]) or guest_access:
                    if action == "accept-pickup":
                        if order["status"] != "ready" or order["fulfillment"] != "delivery" or order["pickup_offer_status"] != "pending": raise ApiError(409,"There is no pickup offer to accept.")
                        special_action = "accept-pickup"
                    elif action == "cancel-no-runner":
                        if order["status"] != "ready" or order["fulfillment"] != "delivery" or order["pickup_offer_status"] != "pending": raise ApiError(409,"There is no pickup offer to cancel.")
                        expected_status,next_status = "ready","declined"
                        special_action = "cancel-no-runner"
                    elif action == "cancel-pending":
                        if order["status"] != "placed" or order["buyer_cancelled"]:
                            raise ApiError(409,"The stall has already started handling this order. Only a new order can be cancelled here.")
                        expected_status,next_status = "placed","declined"
                        special_action = "buyer-cancel"
                    else: raise ApiError(403,"That order cannot be updated by this account.")
                else: raise ApiError(403,"This account cannot update that order.")
                if special_action == "assign":
                    changed = db.execute("UPDATE orders SET runner_name=?,runner_id=NULL,runner_tracking_token_hash=NULL,runner_tracking_expires_at=NULL,updated_at=? WHERE id=? AND status='ready' AND fulfillment='delivery'",
                        (runner_name,now(),order_id))
                elif special_action == "offer-pickup":
                    changed = db.execute("UPDATE orders SET pickup_offer_status='pending',runner_name='',runner_id=NULL,runner_tracking_token_hash=NULL,runner_tracking_expires_at=NULL,updated_at=? WHERE id=? AND status='ready' AND fulfillment='delivery' AND pickup_offer_status!='pending'",
                        (now(),order_id))
                elif special_action == "accept-pickup":
                    pickup_code = order["guest_pickup_code"] or new_pickup_code(db)
                    changed = db.execute("UPDATE orders SET fulfillment='pickup',pickup_offer_status='accepted',guest_pickup_code=?,runner_name='',runner_id=NULL,delivery_lat=NULL,delivery_lon=NULL,runner_tracking_token_hash=NULL,runner_tracking_expires_at=NULL,updated_at=? WHERE id=? AND status='ready' AND fulfillment='delivery' AND pickup_offer_status='pending'",
                        (pickup_code,now(),order_id))
                    db.execute("DELETE FROM delivery_positions WHERE order_id=?",(order_id,))
                elif special_action == "cancel-no-runner":
                    changed = db.execute("UPDATE orders SET status='declined',pickup_offer_status='declined',updated_at=? WHERE id=? AND status='ready' AND fulfillment='delivery' AND pickup_offer_status='pending'",
                        (now(),order_id))
                    db.execute("DELETE FROM delivery_positions WHERE order_id=?",(order_id,))
                    db.execute("UPDATE orders SET delivery_lat=NULL,delivery_lon=NULL WHERE id=?",(order_id,))
                elif special_action == "buyer-cancel":
                    changed = db.execute("UPDATE orders SET status='declined',buyer_cancelled=TRUE,updated_at=? WHERE id=? AND status='placed' AND buyer_cancelled=FALSE",
                        (now(),order_id))
                elif next_status == "confirmed":
                    estimate = (datetime.now(timezone.utc)+timedelta(minutes=order["prep_minutes"])).isoformat(timespec="seconds")
                    changed = db.execute("UPDATE orders SET status=?,updated_at=?,estimated_ready_at=? WHERE id=? AND status=?",
                        (next_status,now(),estimate,order_id,expected_status))
                elif next_status:
                    changed = db.execute("UPDATE orders SET status=?,updated_at=? WHERE id=? AND status=?",
                        (next_status,now(),order_id,expected_status))
                if not changed.rowcount:
                    raise ApiError(409,"That order has already changed. Refresh and try again.")
                if next_status == "declined":
                    reserved = db.execute("SELECT product_id,quantity FROM order_items WHERE order_id=? AND product_id IS NOT NULL", (order_id,)).fetchall()
                    for item in reserved:
                        db.execute("UPDATE products SET stock_count=MIN(1000000,stock_count+?) WHERE id=? AND stock_count IS NOT NULL",
                            (item["quantity"],item["product_id"]))
                if next_status == "completed":
                    db.execute("DELETE FROM delivery_positions WHERE order_id=?", (order_id,))
                    db.execute("UPDATE orders SET delivery_lat=NULL,delivery_lon=NULL,runner_tracking_token_hash=NULL,runner_tracking_expires_at=NULL WHERE id=?", (order_id,))
                buyer_id = order["buyer_id"]
                guest_session_id = order["guest_session_id"]
                owner_id = order["owner_id"]
                stall_name = db.execute("SELECT name FROM stalls WHERE id=?", (order["stall_id"],)).fetchone()[0]
            if special_action == "offer-pickup":
                dispatch_order_buyer_push(buyer_id, guest_session_id, {"title":"Delivery unavailable · choose pickup or cancel","body":f"{stall_name} has no runner for order #{order_id}. Open BiteHub to choose pickup at the stall or cancel.","url":"/#buyer-orders","tag":f"bitehub-order-{order_id}"})
            elif special_action == "accept-pickup":
                dispatch_push([owner_id], {"title":"Customer chose pickup","body":f"The customer will pick up order #{order_id} at your stall.","url":"/#owner-orders","tag":f"bitehub-order-{order_id}"})
            elif special_action == "cancel-no-runner":
                dispatch_push([owner_id], {"title":"Customer cancelled order","body":f"The customer cancelled order #{order_id} because pickup was not suitable.","url":"/#owner-orders","tag":f"bitehub-order-{order_id}"})
            elif special_action == "buyer-cancel":
                dispatch_push([owner_id], {"title":"Customer cancelled new order","body":f"The customer cancelled order #{order_id} before you accepted it.","url":"/#owner-orders","tag":f"bitehub-order-{order_id}"})
            if next_status and special_action != "buyer-cancel":
                declined_body = (f"Order #{order_id} was cancelled because pickup was not suitable."
                    if special_action == "cancel-no-runner" else f"{stall_name} could not accept order #{order_id}.")
                push_status = {"confirmed": ("Order accepted", f"{stall_name} accepted order #{order_id}."),
                    "preparing": ("Your order is being prepared", f"{stall_name} is preparing order #{order_id}."),
                    "ready": ("Your order is ready", f"Order #{order_id} is ready for pickup or delivery."),
                    "out": ("Your order is on the way", f"Order #{order_id} is on the way with {runner_name or 'your runner'}."),
                    "completed": ("Order completed", f"Order #{order_id} has been completed."),
                    "declined": ("Order update", declined_body)}
                if next_status in push_status:
                    title, body = push_status[next_status]
                    dispatch_order_buyer_push(buyer_id, guest_session_id, {"title": title, "body": body, "url": "/#buyer-orders", "tag": f"bitehub-order-{order_id}"})
            elif special_action == "assign":
                dispatch_order_buyer_push(buyer_id, guest_session_id, {"title":"Runner assigned","body":f"{runner_name} will deliver order #{order_id}.","url":"/#buyer-orders","tag":f"bitehub-order-{order_id}"})
            self.send_json(200,{"ok":True}); return
        raise ApiError(404,"That API route does not exist.")

    def api_delete(self, path):
        admin_stall_match = re.fullmatch(r"/api/admin/stalls/(\d+)", path)
        if admin_stall_match:
            self.require_role("admin")
            stall_id = int(admin_stall_match.group(1))
            with connect() as db:
                stall = db.execute("""SELECT s.id,s.owner_id FROM stalls s JOIN users u ON u.id=s.owner_id
                    WHERE s.id=? AND u.school_id='pns' AND u.deleted_at IS NULL""", (stall_id,)).fetchone()
                if not stall:
                    raise ApiError(404, "Stall account not found.")
                removed_at = now()
                db.execute("UPDATE users SET deleted_at=? WHERE id=?", (removed_at, stall["owner_id"]))
                db.execute("UPDATE stalls SET status='paused' WHERE id=?", (stall_id,))
                db.execute("UPDATE products SET available=FALSE,featured_until=NULL WHERE stall_id=?", (stall_id,))
                db.execute("DELETE FROM sessions WHERE user_id=?", (stall["owner_id"],))
            self.send_json(200, {"ok":True,"deleted":True,"history_preserved":True})
            return
        admin_product_match = re.fullmatch(r"/api/admin/products/(\d+)", path)
        if admin_product_match:
            self.require_role("admin")
            product_id = int(admin_product_match.group(1))
            with connect() as db:
                result = db.execute("""DELETE FROM products WHERE id=? AND stall_id IN (
                    SELECT s.id FROM stalls s JOIN users u ON u.id=s.owner_id
                    WHERE u.school_id='pns' AND u.deleted_at IS NULL)""", (product_id,))
                if result.rowcount != 1:
                    raise ApiError(404, "Food item not found.")
            self.send_json(200, {"ok":True,"removed_from_catalog_and_menu":True,"order_history_preserved":True})
            return
        schedule_match = re.fullmatch(r"/api/menu-schedule/(\d+)", path)
        if schedule_match:
            owner = self.require_role("owner")
            if not WEEKLY_MENU_AVAILABLE:
                raise ApiError(503, "The weekly menu planner needs the BiteHub database migration.")
            with connect() as db:
                result = db.execute("DELETE FROM weekly_menu_slots WHERE id=? AND stall_id=?",
                    (int(schedule_match.group(1)), owner.get("stall_id")))
                if result.rowcount != 1:
                    raise ApiError(404, "Weekly menu plan not found.")
            self.send_json(200, {"ok": True})
            return
        match = re.fullmatch(r"/api/products/(\d+)", path)
        if not match: raise ApiError(404,"That API route does not exist.")
        owner = self.require_role("owner")
        with connect() as db:
            cur = db.execute("DELETE FROM products WHERE id=? AND stall_id=?", (int(match.group(1)),owner["stall_id"]))
            if not cur.rowcount: raise ApiError(404,"Menu item not found.")
        self.send_json(200,{"ok":True})

    @staticmethod
    def current_user_from_id(user_id):
        with connect() as db:
            row = db.execute("SELECT u.id,u.name,u.email,u.role,u.school_id,u.grade_section,sc.region school_region,sc.province school_province,sc.city school_city,u.school_zip,sc.name school_name,sc.school_type,sc.latitude school_latitude,sc.longitude school_longitude,sc.delivery_radius_m,s.id stall_id,s.name stall_name,s.description stall_description,s.status stall_status,s.opens_at stall_opens_at,s.closes_at stall_closes_at,s.prep_minutes stall_prep_minutes,s.pickup_slot_capacity stall_pickup_slot_capacity,s.logo_type stall_logo_type,u.profile_photo_type,u.profile_photo_version FROM users u LEFT JOIN schools sc ON sc.id=u.school_id LEFT JOIN stalls s ON s.owner_id=u.id WHERE u.id=?",(user_id,)).fetchone()
            user = dict(row)
            user["stall_on_break"] = stall_on_break(db, user.get("stall_id"))
        user["stall_logo_url"] = f"/api/stalls/{user['stall_id']}/logo" if user.get("stall_logo_type") else None
        user["profile_photo_url"] = f"/api/profile/photo?v={user['profile_photo_version']}" if user.get("profile_photo_type") else None
        return user

    def serve_static(self, requested):
        relative = unquote(requested).lstrip("/") or "index.html"
        # Only publish files the frontend actually uses. The project directory also
        # contains the SQLite database, certificates, and other private files.
        public_files = {
            "index.html", "font-loader.js", "styles.css", "app-ui.css", "experience.css",
            "school-theme.css", "feature-ui.css", "stall-profile.css",
            "opening-screen.css", "market-ui.css", "app.js", "sw.js", "manifest.webmanifest",
            "bitehub-mark.svg", "brand-refresh.css", "sidebar-preferences.css", "device-responsive.css",
            "palette-theme.css", "prototype-notice.css",
            "legal_drafts/PRIVACY_NOTICE_DRAFT.md", "legal_drafts/TERMS_OF_USE_DRAFT.md",
            "legal_drafts/COOKIE_AND_LOCATION_NOTICES_DRAFT.md",
            "legal_drafts/CHILD_FRIENDLY_PRIVACY_SUMMARY_DRAFT.md",
            "assets/bitehub-food-mark.png", "assets/bitehub-logo.png",
            "assets/bitehub-icon.png", "assets/bitehub-wordmark.png",
            "assets/palawan-national-school-logo.webp",
            "assets/bitehub-food-market-4k.webp",
            "assets/bitehub-food-market-medium.webp",
            "assets/bitehub-food-market-mobile.webp",
            "assets/bitehub-campus-food-bg.webp",
            "assets/bitehub-campus-food-medium.webp",
            "assets/bitehub-campus-food-mobile.webp",
            "assets/palawan-campus-map.png",
            "assets/pns-campus-safe-routes.jpg",
            "assets/pns-campus-hero.jpg",
            "assets/palawan-national-school-campus.png",
            "background music assets/Panaginip.mp3",
            "background music assets/pahina.mp3",
            "background music assets/life time.mp3",
            "background music assets/bawat piyesa.mp3",
        }
        if relative not in public_files:
            self.send_error(404); return
        target = (BASE / relative).resolve()
        if BASE not in target.parents and target != BASE:
            self.send_error(403); return
        if target.is_dir(): target = target / "index.html"
        if not target.is_file(): self.send_error(404); return
        data = target.read_bytes()
        mime = "text/plain" if target.suffix == ".md" else (mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        if mime.startswith("text/") or mime in ("application/javascript",): mime += "; charset=utf-8"
        compressible = target.suffix.lower() in {".css", ".html", ".js", ".md", ".svg", ".webmanifest"}
        accepts_gzip = any(
            encoding.strip().split(";", 1)[0].lower() == "gzip"
            and not re.search(r"(?:^|;)\s*q\s*=\s*0(?:\.0*)?\s*(?:;|$)", encoding, re.I)
            for encoding in self.headers.get("Accept-Encoding", "").split(",")
        )
        compressed_response = False
        if compressible and accepts_gzip and len(data) >= 512:
            compressed = gzip.compress(data, compresslevel=6, mtime=0)
            if len(compressed) < len(data):
                data = compressed
                compressed_response = True
        self.send_response(200)
        if compressed_response: self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Type",mime)
        self.send_header("Content-Length",str(len(data)))
        if compressible: self.send_header("Vary", "Accept-Encoding")
        self.send_header("Cache-Control", "no-cache" if target.name == "index.html" or target.suffix in {".js", ".css", ".webmanifest"} else "public, max-age=3600")
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("Content-Security-Policy","default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://maps.googleapis.com https://maps.gstatic.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self' https://maps.googleapis.com https://maps.gstatic.com; connect-src 'self' https://maps.googleapis.com https://maps.gstatic.com https://*.googleapis.com https://*.gstatic.com; worker-src 'self' blob:; base-uri 'self'; frame-ancestors 'none'")
        self.end_headers(); self.wfile.write(data)


def create_admin(email, name, password):
    email = email.strip().lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+",email): raise SystemExit("Invalid email address.")
    if len(password) < 10: raise SystemExit("Use an admin password with at least 10 characters.")
    salt = secrets.token_bytes(16)
    with connect() as db:
        db.execute("INSERT INTO users(name,email,password_hash,password_salt,role,created_at) VALUES(?,?,?,?,?,?)",
                   (clean_text(name,"Name",80),email,password_digest(password,salt),salt.hex(),"admin",now()))
    print(f"Administrator account created for {email}.")


def main():
    parser = argparse.ArgumentParser(description="Run the BiteHub server and SQLite database.")
    parser.add_argument("--host",default=os.environ.get("HOST", "127.0.0.1"),help="Interface to bind")
    parser.add_argument("--port",type=int,default=int(os.environ.get("PORT", "8001")),help="Port to bind")
    parser.add_argument("--https-cert",help="PEM server certificate for HTTPS (use with --https-key)")
    parser.add_argument("--https-key",help="PEM private key for HTTPS (use with --https-cert)")
    parser.add_argument("--behind-proxy",action="store_true",help="Serve behind a reverse proxy that terminates HTTPS")
    parser.add_argument("--create-admin",action="store_true",help="Create an admin account, then exit")
    parser.add_argument("--email",help="Admin email for --create-admin")
    parser.add_argument("--name",help="Admin display name for --create-admin")
    parser.add_argument("--password",help="Admin password for --create-admin; omit to enter it privately")
    args = parser.parse_args()
    initialize()
    if args.create_admin:
        email = args.email or input("Admin email: ")
        name = args.name or input("Admin name: ")
        password = args.password or __import__("getpass").getpass("Admin password (10+ characters): ")
        create_admin(email,name,password); return
    if bool(args.https_cert) != bool(args.https_key):
        parser.error("--https-cert and --https-key must be used together.")
    if args.https_cert and args.behind_proxy:
        parser.error("Use either local HTTPS certificates or --behind-proxy, not both.")
    if args.host in ("0.0.0.0", "::") and not (args.https_cert or args.behind_proxy):
        parser.error("Binding to the network requires HTTPS. Use start-secure.cmd or --behind-proxy behind a trusted HTTPS proxy.")
    httpd = BiteHubHTTPServer((args.host,args.port),Handler)
    httpd.is_https = bool(args.https_cert or args.behind_proxy)
    scheme = "http"
    if args.https_cert:
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(args.https_cert,args.https_key)
        httpd.socket = tls.wrap_socket(httpd.socket,server_side=True)
        scheme = "https"
    if args.host in ("0.0.0.0", "::"):
        print(f"BiteHub is listening on all interfaces at port {args.port} ({scheme.upper()}). Open https://<this-PC-LAN-IP>:{args.port} on trusted phones.")
    else:
        print(f"BiteHub is running at {scheme}://{args.host}:{args.port}")
    if DATABASE_URL:
        print("PostgreSQL database: Supabase (bitehub_app schema)")
    else:
        print(f"SQLite database: {DB_PATH}")
    try: httpd.serve_forever()
    except KeyboardInterrupt: print("\nStopping BiteHub.")
    finally: httpd.server_close()


if __name__ == "__main__": main()
