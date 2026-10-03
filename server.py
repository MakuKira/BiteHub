#!/usr/bin/env python3
"""BiteHub local server. Uses Python's standard library, SQLite, and cryptography for Web Push."""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
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
import urllib.error
import urllib.request
from datetime import date, datetime, time as clock_time, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from zoneinfo import ZoneInfo

BASE = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("BITEHUB_DB", BASE / "bitehub.sqlite3"))
SESSION_SECONDS = 60 * 60 * 24 * 14
PBKDF2_ROUNDS = 310_000
ROLES = {"buyer", "owner", "runner", "admin"}
MAX_BODY = 3 * 1024 * 1024
MAX_PRODUCT_PHOTO_BYTES = 2 * 1024 * 1024
PICKUP_SLOT_MINUTES = 30
CAMPUS_ZONE = ZoneInfo("Asia/Manila")
DIETARY_TAGS = {"vegetarian", "vegan", "halal", "gluten-free", "dairy-free", "nut-free"}
ALLERGEN_TAGS = {"peanuts", "tree-nuts", "milk", "eggs", "soy", "wheat", "fish", "shellfish", "sesame"}
CAMPUS_BOUNDS = {"south": 9.736753, "north": 9.740445, "west": 118.737108, "east": 118.740839}


def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA journal_mode = WAL")
    return db


def initialize():
    with connect() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('buyer','owner','runner','admin')),
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stalls (
          id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'approved'
                                                CHECK(status IN ('pending','approved','paused')), opens_at TEXT NOT NULL DEFAULT '00:00',
                                        closes_at TEXT NOT NULL DEFAULT '23:59', prep_minutes INTEGER NOT NULL DEFAULT 15
                                            CHECK(prep_minutes BETWEEN 1 AND 180), pickup_slot_capacity INTEGER NOT NULL DEFAULT 4
                                            CHECK(pickup_slot_capacity BETWEEN 1 AND 100), pickup_lat REAL, pickup_lon REAL,
                                            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY, stall_id INTEGER NOT NULL REFERENCES stalls(id) ON DELETE CASCADE,
          name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL,
          price_cents INTEGER NOT NULL CHECK(price_cents > 0), emoji TEXT NOT NULL DEFAULT '🍽️',
                    available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)), stock_count INTEGER
                        CHECK(stock_count IS NULL OR stock_count >= 0), dietary_tags TEXT NOT NULL DEFAULT '[]',
                    allergen_tags TEXT NOT NULL DEFAULT '[]', photo_data BLOB, photo_type TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY, value TEXT NOT NULL
        );
        INSERT OR IGNORE INTO settings(key,value) VALUES('ordering_paused','false');
        CREATE TABLE IF NOT EXISTS orders (
          id INTEGER PRIMARY KEY, buyer_id INTEGER NOT NULL REFERENCES users(id),
          stall_id INTEGER NOT NULL REFERENCES stalls(id), runner_id INTEGER REFERENCES users(id),
          fulfillment TEXT NOT NULL CHECK(fulfillment IN ('pickup','delivery')),
          status TEXT NOT NULL CHECK(status IN ('placed','confirmed','preparing','ready','out','completed','declined')),
          total_cents INTEGER NOT NULL, buyer_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, estimated_ready_at TEXT, pickup_at TEXT,
          delivery_lat REAL, delivery_lon REAL
        );
        CREATE TABLE IF NOT EXISTS order_items (
          id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
          name TEXT NOT NULL, price_cents INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 50), emoji TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS feedback (
                    order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
                    buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
                    comment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
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
        CREATE INDEX IF NOT EXISTS orders_buyer_idx ON orders(buyer_id, id DESC);
        CREATE INDEX IF NOT EXISTS orders_stall_idx ON orders(stall_id, id DESC);
        CREATE INDEX IF NOT EXISTS orders_runner_idx ON orders(runner_id, id DESC);
        CREATE INDEX IF NOT EXISTS products_stall_idx ON products(stall_id, available);
        CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
        """)
        stall_columns = {row["name"] for row in db.execute("PRAGMA table_info(stalls)")}
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
        for name in ("pickup_lat", "pickup_lon"):
            if name not in stall_columns:
                db.execute(f"ALTER TABLE stalls ADD COLUMN {name} REAL")
        order_columns = {row["name"] for row in db.execute("PRAGMA table_info(orders)")}
        if "estimated_ready_at" not in order_columns:
            db.execute("ALTER TABLE orders ADD COLUMN estimated_ready_at TEXT")
        if "pickup_at" not in order_columns:
            db.execute("ALTER TABLE orders ADD COLUMN pickup_at TEXT")
        for name in ("delivery_lat", "delivery_lon"):
            if name not in order_columns:
                db.execute(f"ALTER TABLE orders ADD COLUMN {name} REAL")
        product_columns = {row["name"] for row in db.execute("PRAGMA table_info(products)")}
        for name, declaration in (
            ("stock_count", "INTEGER CHECK(stock_count IS NULL OR stock_count >= 0)"),
            ("featured_until", "TEXT"),
            ("dietary_tags", "TEXT NOT NULL DEFAULT '[]'"),
            ("allergen_tags", "TEXT NOT NULL DEFAULT '[]'"),
            ("photo_data", "BLOB"),
            ("photo_type", "TEXT"),
        ):
            if name not in product_columns:
                db.execute(f"ALTER TABLE products ADD COLUMN {name} {declaration}")
        db.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),))


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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
            private_path = Path(os.environ.get("BITEHUB_VAPID_PRIVATE_KEY", BASE / ".local-certs" / "vapid_private.pem"))
            private_path.parent.mkdir(parents=True, exist_ok=True)
            if private_path.exists():
                private_key = serialization.load_pem_private_key(private_path.read_bytes(), password=None)
            else:
                private_key = ec.generate_private_key(ec.SECP256R1())
                private_path.write_bytes(private_key.private_bytes(serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
            public_bytes = private_key.public_key().public_bytes(serialization.Encoding.X962,
                serialization.PublicFormat.UncompressedPoint)
            _vapid_cache = (base64.urlsafe_b64encode(public_bytes).decode().rstrip("="), private_path)
        except (ImportError, OSError, ValueError):
            _vapid_cache = (None, None)
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


def dispatch_push(user_ids, payload):
    if not push_available():
        return
    threading.Thread(target=send_push, args=(tuple(set(user_ids)), payload), daemon=True).start()


def send_push(user_ids, payload):
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF, HKDFExpand
        from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
        _, private_key_path = vapid_keys()
        private_key = serialization.load_pem_private_key(private_key_path.read_bytes(), password=None)
        public_bytes = private_key.public_key().public_bytes(serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint)
        public_token = base64.urlsafe_b64encode(public_bytes).decode().rstrip("=")
        subject = os.environ.get("BITEHUB_VAPID_SUBJECT", "mailto:bitehub-notifications@example.com")
        with connect() as db:
            subscriptions = db.execute("SELECT id,endpoint,subscription_json FROM push_subscriptions WHERE user_id IN (%s)" %
                ",".join("?" for _ in user_ids), user_ids).fetchall() if user_ids else []
        for subscription in subscriptions:
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
                cek = HKDFExpand(algorithm=hashes.SHA256(), length=16,
                    info=b"Content-Encoding: aes128gcm\x00").derive(ikm)
                nonce = HKDFExpand(algorithm=hashes.SHA256(), length=12,
                    info=b"Content-Encoding: nonce\x00").derive(ikm)
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
                        db.execute("DELETE FROM push_subscriptions WHERE id=?", (subscription["id"],))
            except Exception:
                pass
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


def parse_product_photo(encoded, media_type):
    if not isinstance(encoded, str) or not isinstance(media_type, str):
        raise ValueError("Choose a JPG, PNG, or WebP food photo.")
    if len(encoded) > ((MAX_PRODUCT_PHOTO_BYTES + 2) // 3) * 4:
        raise ValueError("Food photos must be 2 MB or smaller.")
    try:
        photo = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("That food photo could not be read. Please choose it again.")
    if not photo or len(photo) > MAX_PRODUCT_PHOTO_BYTES:
        raise ValueError("Food photos must be between 1 byte and 2 MB.")
    signatures = {
        "image/jpeg": photo.startswith(b"\xff\xd8\xff"),
        "image/png": photo.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/webp": len(photo) >= 12 and photo.startswith(b"RIFF") and photo[8:12] == b"WEBP",
    }
    if media_type not in signatures or not signatures[media_type]:
        raise ValueError("Choose a valid JPG, PNG, or WebP food photo.")
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


def campus_point(latitude, longitude, label="Location"):
    try:
        latitude, longitude = float(latitude), float(longitude)
    except (TypeError, ValueError):
        raise ValueError(f"Choose {label.lower()} on the campus map.")
    if not math.isfinite(latitude) or not math.isfinite(longitude):
        raise ValueError(f"Choose {label.lower()} on the campus map.")
    if not CAMPUS_BOUNDS["south"] <= latitude <= CAMPUS_BOUNDS["north"] or not CAMPUS_BOUNDS["west"] <= longitude <= CAMPUS_BOUNDS["east"]:
        raise ValueError(f"{label} must be inside the Palawan National School delivery area. Off-campus locations are not available.")
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


class Handler(BaseHTTPRequestHandler):
    server_version = "BiteHub/1.0"

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
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_BODY:
            raise ApiError(413, "Request is too large.")
        raw = self.rfile.read(length)
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

    def current_user(self, required=True):
        token = self.cookie_token()
        if token:
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            with connect() as db:
                row = db.execute("""SELECT u.id,u.name,u.email,u.role,s.id stall_id,s.name stall_name,s.description stall_description,s.status stall_status,
                    s.opens_at stall_opens_at,s.closes_at stall_closes_at,s.prep_minutes stall_prep_minutes,
                    s.pickup_slot_capacity stall_pickup_slot_capacity,s.pickup_lat stall_pickup_lat,
                    s.pickup_lon stall_pickup_lon
                    FROM sessions x JOIN users u ON u.id=x.user_id LEFT JOIN stalls s ON s.owner_id=u.id
                    WHERE x.token_hash=? AND x.expires_at>?""", (token_hash, int(time.time()))).fetchone()
            if row:
                return dict(row)
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
        return {"Set-Cookie": f"bitehub_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_SECONDS}"}

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
            data = self.body() if method != "DELETE" else {}
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
        if path == "/api/notifications/config":
            self.send_json(200, {"public_key": vapid_public_key(), "available": push_available()})
            return
        if path == "/api/notifications/status":
            user = self.current_user()
            with connect() as db:
                count = db.execute("SELECT COUNT(*) FROM push_subscriptions WHERE user_id=?", (user["id"],)).fetchone()[0]
            self.send_json(200, {"enabled": count > 0, "available": push_available()})
            return
        if path == "/api/stalls":
            with connect() as db:
                rows = db.execute("""SELECT s.id,s.name,s.description,s.status,s.opens_at,s.closes_at,
                    COUNT(CASE WHEN p.available=1 THEN 1 END) menu_count FROM stalls s
                    LEFT JOIN products p ON p.stall_id=s.id WHERE s.status='approved'
                    GROUP BY s.id ORDER BY s.name""").fetchall()
            self.send_json(200, {"stalls": [dict(row, is_open=stall_is_open(row["opens_at"], row["closes_at"])) for row in rows]})
            return
        stall_match = re.fullmatch(r"/api/stalls/(\d+)", path)
        if stall_match:
            with connect() as db:
                stall = db.execute("""SELECT s.id,s.name,s.description,s.status,s.opens_at,s.closes_at,
                    u.name owner_name FROM stalls s JOIN users u ON u.id=s.owner_id
                    WHERE s.id=? AND s.status='approved'""", (int(stall_match.group(1)),)).fetchone()
                if not stall: raise ApiError(404, "Stall not found.")
                products = db.execute("""SELECT p.id,p.name,p.description,p.category,p.price_cents,p.emoji,
                    p.available,p.stock_count,p.photo_type FROM products p WHERE p.stall_id=? AND p.available=1
                    ORDER BY p.category,p.name""", (stall["id"],)).fetchall()
                payload = dict(stall)
                payload["is_open"] = stall_is_open(stall["opens_at"], stall["closes_at"])
                payload["menu_count"] = len(products)
                payload["products"] = [{"id": p["id"], "name": p["name"], "description": p["description"],
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
                row = db.execute("""SELECT p.photo_data,p.photo_type,p.available,s.status stall_status,s.owner_id
                    FROM products p JOIN stalls s ON s.id=p.stall_id WHERE p.id=?""", (product_id,)).fetchone()
            if not row or not row["photo_data"] or not row["photo_type"]:
                raise ApiError(404, "Food photo not found.")
            public = row["available"] and row["stall_status"] == "approved"
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
            self.send_json(200, {"user": self.current_user(required=False)})
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
                row = db.execute("""SELECT o.buyer_id,o.runner_id,s.owner_id,dp.latitude,dp.longitude,
                    dp.accuracy,dp.heading,dp.updated_at FROM orders o JOIN stalls s ON s.id=o.stall_id
                    LEFT JOIN delivery_positions dp ON dp.order_id=o.id WHERE o.id=?""", (order_id,)).fetchone()
            if not row: raise ApiError(404, "Order not found.")
            allowed = ((user["role"] == "buyer" and row["buyer_id"] == user["id"]) or
                       (user["role"] == "owner" and row["owner_id"] == user["id"]) or
                       (user["role"] == "runner" and row["runner_id"] == user["id"]))
            if not allowed: raise ApiError(403, "This account cannot view this delivery location.")
            self.send_json(200, {"location": ({"latitude": row["latitude"], "longitude": row["longitude"],
                "accuracy": row["accuracy"], "heading": row["heading"], "updated_at": row["updated_at"]}
                if row["latitude"] is not None else None)})
            return
        if path == "/api/products":
            user = self.current_user(required=False)
            with connect() as db:
                paused = db.execute("SELECT value FROM settings WHERE key='ordering_paused'").fetchone()[0] == "true"
                where, args = "", []
                if not user or user["role"] not in ("admin", "owner"):
                    where = "WHERE p.available=1 AND s.status='approved'"
                elif user["role"] == "owner":
                    where, args = "WHERE s.owner_id=? OR (s.status='approved' AND p.available=1)", [user["id"]]
                rows = db.execute(f"""SELECT p.id,p.name,p.description,p.category,p.price_cents,p.emoji,p.available,
                    p.stock_count,p.dietary_tags,p.allergen_tags,p.photo_type,p.featured_until,s.id stall_id,s.name stall_name,s.description stall_description,
                    s.status stall_status,s.opens_at,s.closes_at,s.pickup_lat,s.pickup_lon
                    FROM products p JOIN stalls s ON s.id=p.stall_id {where} ORDER BY s.name,p.name""", args).fetchall()
                featured_rows = [row for row in rows if row["featured_until"] and row["featured_until"] > now()
                    and row["available"] and (row["stock_count"] is None or row["stock_count"] > 0)
                    and row["stall_status"] == "approved"]
                featured_rows = rotate_stall_rows(featured_rows)
                if not user or user["role"] == "buyer":
                    rows = rotate_stall_rows(rows)
            self.send_json(200, {"products": [self.product_json(row, bool(user and user["role"] in ("owner", "admin"))) for row in rows],
                                 "featured_products": [self.product_json(row) for row in featured_rows],
                                 "ordering_paused": paused,
                                 "stall_status": user.get("stall_status") if user and user["role"] == "owner" else None,
                                 "owner_hours": {"opens_at": user["stall_opens_at"], "closes_at": user["stall_closes_at"]}
                                                if user and user["role"] == "owner" else None,
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
                else: sql, args = "1=1", []
                orders = db.execute(f"""SELECT o.*,u.name buyer_name,u.email buyer_email,s.name stall_name,r.name runner_name,
                    s.pickup_lat stall_latitude,s.pickup_lon stall_longitude,dp.latitude driver_latitude,
                    dp.longitude driver_longitude,dp.accuracy driver_accuracy,dp.updated_at driver_updated_at
                    FROM orders o JOIN users u ON u.id=o.buyer_id JOIN stalls s ON s.id=o.stall_id
                    LEFT JOIN users r ON r.id=o.runner_id LEFT JOIN delivery_positions dp ON dp.order_id=o.id
                    WHERE {sql} ORDER BY o.id DESC""",args).fetchall()
                stall_status = None
                if user["role"] == "owner":
                    stall = db.execute("SELECT status FROM stalls WHERE owner_id=?",(user["id"],)).fetchone()
                    stall_status = stall["status"] if stall else None
                paused = db.execute("SELECT value FROM settings WHERE key='ordering_paused'").fetchone()[0] == "true"
                result = self.orders_json(db, orders)
            self.send_json(200, {"orders":result,"ordering_paused":paused,"stall_status":stall_status})
            return
        if path == "/api/runners":
            self.require_role("owner", "admin")
            with connect() as db:
                rows = db.execute("SELECT id,name FROM users WHERE role='runner' ORDER BY name").fetchall()
            self.send_json(200, {"runners": [dict(row) for row in rows]})
            return
        if path == "/api/admin/overview":
            self.require_role("admin")
            with connect() as db:
                users = db.execute("SELECT role,COUNT(*) count FROM users GROUP BY role").fetchall()
                stalls = db.execute("SELECT COUNT(*) FROM stalls").fetchone()[0]
                stall_rows = db.execute("""SELECT s.id,s.name,s.status,s.created_at,u.name owner_name,u.email owner_email,
                    COUNT(p.id) product_count FROM stalls s JOIN users u ON u.id=s.owner_id
                    LEFT JOIN products p ON p.stall_id=s.id GROUP BY s.id ORDER BY
                    CASE s.status WHEN 'paused' THEN 0 ELSE 1 END,s.name""").fetchall()
                products = db.execute("SELECT COUNT(*) FROM products").fetchone()[0]
                rows = db.execute("SELECT status,COUNT(*) count,COALESCE(SUM(total_cents),0) sales FROM orders GROUP BY status").fetchall()
                paused = db.execute("SELECT value FROM settings WHERE key='ordering_paused'").fetchone()[0] == "true"
            self.send_json(200, {"users": {row["role"]: row["count"] for row in users}, "stalls": stalls,
                                 "stall_list": [dict(row) for row in stall_rows],
                                 "products": products, "orders": [dict(row) for row in rows], "ordering_paused": paused})
            return
        raise ApiError(404, "That API route does not exist.")

    @staticmethod
    def product_json(row, include_unavailable=False):
        stock_count = row["stock_count"]
        featured_until = row["featured_until"] if "featured_until" in row.keys() else None
        featured = bool(featured_until and featured_until > now() and row["available"]
                        and (stock_count is None or stock_count > 0) and row["stall_status"] == "approved")
        item = {"id": row["id"], "name": row["name"], "description": row["description"],
                "category": row["category"], "price": row["price_cents"] / 100, "emoji": row["emoji"],
            "available": bool(row["available"]) and (stock_count is None or stock_count > 0),
                "stock_count": stock_count, "dietary_tags": json.loads(row["dietary_tags"] or "[]"),
                "allergen_tags": json.loads(row["allergen_tags"] or "[]"), "stall_id": row["stall_id"],
                "stall_name": row["stall_name"], "stall_status": row["stall_status"],
                "pickup_lat": row["pickup_lat"], "pickup_lon": row["pickup_lon"],
                "featured": featured, "featured_until": featured_until if featured else None,
                "opens_at": row["opens_at"], "closes_at": row["closes_at"],
            "stall_open": row["stall_status"] == "approved" and stall_is_open(row["opens_at"], row["closes_at"])}
        if "photo_type" in row.keys() and row["photo_type"]:
            item["photo_url"] = f"/api/products/{row['id']}/photo"
        if "stall_description" in row.keys(): item["stall_description"] = row["stall_description"]
        return item

    @staticmethod
    def orders_json(db, rows):
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
            "stall":row["stall_name"],"runner":row["runner_name"],"fulfillment":row["fulfillment"],
            "status":row["status"],"total":row["total_cents"]/100,"buyer_note":row["buyer_note"],
            "created_at":row["created_at"],"estimated_ready_at":row["estimated_ready_at"],
            "pickup_at":row["pickup_at"],"items":items_by_order.get(row["id"],[]),
            "stall_latitude":row["stall_latitude"],"stall_longitude":row["stall_longitude"],
            "delivery_latitude":row["delivery_lat"],"delivery_longitude":row["delivery_lon"],
            "driver_latitude":row["driver_latitude"],"driver_longitude":row["driver_longitude"],
            "driver_accuracy":row["driver_accuracy"],"driver_updated_at":row["driver_updated_at"],
            "feedback":feedback_by_order.get(row["id"])} for row in rows]

    def api_post(self, path, data):
        if path == "/api/notifications/unsubscribe":
            user = self.current_user()
            endpoint = data.get("endpoint")
            if not isinstance(endpoint, str) or len(endpoint) > 2048:
                raise ValueError("Invalid notification subscription.")
            with connect() as db:
                db.execute("DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?", (user["id"], endpoint))
            self.send_json(200, {"ok": True})
            return
        if path == "/api/notifications/subscriptions":
            user = self.current_user()
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
                db.execute("""INSERT INTO push_subscriptions(user_id,endpoint,subscription_json,created_at,updated_at)
                    VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,
                    subscription_json=excluded.subscription_json,updated_at=excluded.updated_at""",
                    (user["id"], endpoint, json.dumps(subscription), now(), now()))
            self.send_json(201, {"ok": True})
            return
        if path == "/api/signup":
            name = clean_text(data.get("name"), "Name", 80)
            email = clean_text(data.get("email"), "Email", 254).lower()
            if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email): raise ValueError("Enter a valid email address.")
            password = str(data.get("password") or "")
            if len(password) < 10: raise ValueError("Use a password with at least 10 characters.")
            role = data.get("role")
            if role not in ("buyer", "owner", "runner"): raise ApiError(400, "Choose a supported account type.")
            stall_name = clean_text(data.get("stall_name"), "Stall name", 80) if role == "owner" else None
            salt = secrets.token_bytes(16)
            with connect() as db:
                cur = db.execute("INSERT INTO users(name,email,password_hash,password_salt,role,created_at) VALUES(?,?,?,?,?,?)",
                                 (name,email,password_digest(password,salt),salt.hex(),role,now()))
                user_id = cur.lastrowid
                if role == "owner": db.execute("INSERT INTO stalls(owner_id,name,status,created_at) VALUES(?,?,'approved',?)", (user_id,stall_name,now()))
            self.send_json(201, {"user": self.current_user_from_id(user_id)}, self.create_session(user_id))
            return
        if path == "/api/login":
            email = str(data.get("email") or "").strip().lower()
            password = str(data.get("password") or "")
            with connect() as db: user = db.execute("SELECT id,password_hash,password_salt FROM users WHERE email=?", (email,)).fetchone()
            if not user or not secrets.compare_digest(password_digest(password,bytes.fromhex(user["password_salt"])),user["password_hash"]):
                raise ApiError(401, "Email or password did not match.")
            self.send_json(200, {"user": self.current_user_from_id(user["id"])}, self.create_session(user["id"]))
            return
        if path == "/api/logout":
            token = self.cookie_token()
            if token:
                with connect() as db: db.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
            self.send_json(200, {"ok": True}, {"Set-Cookie": "bitehub_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"})
            return
        location_match = re.fullmatch(r"/api/orders/(\d+)/location", path)
        if location_match:
            runner = self.require_role("runner")
            order_id = int(location_match.group(1))
            latitude, longitude = campus_point(data.get("latitude"), data.get("longitude"), "Driver location")
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
            name = clean_text(data.get("name"), "Item name", 80)
            desc = clean_text(data.get("description"), "Description", 240, required=False)
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
                cur = db.execute("""INSERT INTO products(stall_id,name,description,category,price_cents,emoji,stock_count,
                    dietary_tags,allergen_tags,photo_data,photo_type,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (owner["stall_id"],name,desc,category,price,emoji,stock_count,json.dumps(dietary_tags),json.dumps(allergen_tags),photo_data,photo_type,now()))
                row = db.execute("""SELECT p.*,s.id stall_id,s.name stall_name,s.status stall_status,s.opens_at,s.closes_at,
                    s.pickup_lat,s.pickup_lon
                    FROM products p JOIN stalls s ON s.id=p.stall_id WHERE p.id=?""", (cur.lastrowid,)).fetchone()
            self.send_json(201, {"product": self.product_json(row)})
            return
        if path == "/api/orders":
            buyer = self.require_role("buyer")
            if data.get("fulfillment") not in ("pickup", "delivery"): raise ValueError("Choose pickup or campus delivery.")
            delivery_lat = delivery_lon = None
            if data["fulfillment"] == "delivery":
                point = data.get("delivery_location") or {}
                delivery_lat, delivery_lon = campus_point(point.get("latitude"), point.get("longitude"), "Delivery location")
            pickup_at=None
            if data["fulfillment"]=="pickup":
                try:
                    requested_pickup=datetime.fromisoformat(str(data.get("pickup_at") or ""))
                    if requested_pickup.tzinfo is None: raise ValueError()
                    pickup_at=requested_pickup.astimezone(CAMPUS_ZONE).isoformat(timespec="seconds")
                except (TypeError,ValueError):
                    raise ValueError("Choose an available pickup time.")
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
                paused = db.execute("SELECT value FROM settings WHERE key='ordering_paused'").fetchone()[0] == "true"
                if paused: raise ApiError(409, "Ordering is temporarily paused.")
                marks = ",".join("?" for _ in ids)
                products = db.execute(f"""SELECT p.*,s.id stall_id,s.name stall_name,s.status stall_status,s.opens_at,s.closes_at
                    FROM products p JOIN stalls s ON s.id=p.stall_id
                    WHERE p.id IN ({marks}) AND p.available=1 AND s.status='approved'""", list(ids)).fetchall()
                if len(products) != len(ids): raise ApiError(409, "One or more items are no longer available. Refresh the menu and try again.")
                if len({row["stall_id"] for row in products}) != 1: raise ValueError("Place separate orders for each stall.")
                stall = products[0]
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
                cur = db.execute("""INSERT INTO orders(buyer_id,stall_id,fulfillment,status,total_cents,buyer_note,
                    created_at,updated_at,pickup_at,delivery_lat,delivery_lon) VALUES(?,?,?,'placed',?,?,?,?,?,?,?)""",
                    (buyer["id"],products[0]["stall_id"],data["fulfillment"],total,note,now(),now(),pickup_at,delivery_lat,delivery_lon))
                order_id = cur.lastrowid
                stall_owner_id = db.execute("SELECT owner_id FROM stalls WHERE id=?", (products[0]["stall_id"],)).fetchone()[0]
                for product in products:
                    db.execute("INSERT INTO order_items(order_id,product_id,name,price_cents,quantity,emoji) VALUES(?,?,?,?,?,?)",
                               (order_id,product["id"],product["name"],product["price_cents"],quantities[product["id"]],product["emoji"]))
            dispatch_push([stall_owner_id], {"title": "New BiteHub order", "body": f"New order #{order_id} is waiting at your stall.", "url": "/#orders", "tag": f"bitehub-order-{order_id}"})
            self.send_json(201, {"order_id": order_id})
            return
        feedback_match = re.fullmatch(r"/api/orders/(\d+)/feedback", path)
        if feedback_match:
            buyer = self.require_role("buyer")
            order_id = int(feedback_match.group(1))
            try: rating = int(data.get("rating"))
            except (TypeError, ValueError): raise ValueError("Choose a rating from 1 to 5.")
            if rating < 1 or rating > 5: raise ValueError("Choose a rating from 1 to 5.")
            comment = clean_text(data.get("comment"), "Feedback", 500, required=False)
            with connect() as db:
                order = db.execute("SELECT status FROM orders WHERE id=? AND buyer_id=?", (order_id,buyer["id"])).fetchone()
                if not order: raise ApiError(404, "Order not found.")
                if order["status"] != "completed": raise ApiError(409, "Feedback is available after your order is completed.")
                if db.execute("SELECT 1 FROM feedback WHERE order_id=?", (order_id,)).fetchone():
                    raise ApiError(409, "Feedback has already been submitted for this order.")
                db.execute("INSERT INTO feedback(order_id,buyer_id,rating,comment,created_at) VALUES(?,?,?,?,?)",
                           (order_id,buyer["id"],rating,comment,now()))
            self.send_json(201, {"ok":True}); return
        if path == "/api/admin/pause":
            self.require_role("admin")
            paused = bool(data.get("paused"))
            with connect() as db: db.execute("UPDATE settings SET value=? WHERE key='ordering_paused'", ("true" if paused else "false",))
            self.send_json(200, {"ordering_paused": paused})
            return
        raise ApiError(404, "That API route does not exist.")

    def api_patch(self, path, data):
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
        if path == "/api/stall/hours":
            owner = self.require_role("owner")
            opens_at, closes_at = parse_hours(data.get("opens_at"),data.get("closes_at"))
            try: prep_minutes = int(data.get("prep_minutes"))
            except (TypeError,ValueError): raise ValueError("Prep time must be a whole number of minutes.")
            if isinstance(data.get("prep_minutes"),bool) or not 1 <= prep_minutes <= 180:
                raise ValueError("Prep time must be between 1 and 180 minutes.")
            try: pickup_slot_capacity=int(data.get("pickup_slot_capacity"))
            except (TypeError,ValueError): raise ValueError("Pickup limit must be a whole number.")
            if isinstance(data.get("pickup_slot_capacity"),bool) or not 1 <= pickup_slot_capacity <= 100:
                raise ValueError("Pickup limit must be between 1 and 100 orders per time slot.")
            with connect() as db:
                cur = db.execute("UPDATE stalls SET opens_at=?,closes_at=?,prep_minutes=?,pickup_slot_capacity=? WHERE owner_id=?",
                    (opens_at,closes_at,prep_minutes,pickup_slot_capacity,owner["id"]))
                if not cur.rowcount: raise ApiError(404,"Stall not found.")
            self.send_json(200,{"opens_at":opens_at,"closes_at":closes_at,"prep_minutes":prep_minutes,
                "pickup_slot_capacity":pickup_slot_capacity}); return
        stall_match = re.fullmatch(r"/api/admin/stalls/(\d+)", path)
        if stall_match:
            self.require_role("admin")
            status = data.get("status")
            if status not in ("approved", "paused"):
                raise ValueError("Choose approved or paused stall status.")
            with connect() as db:
                cur = db.execute("UPDATE stalls SET status=? WHERE id=?", (status,int(stall_match.group(1))))
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
                    db.execute("UPDATE products SET available=?,featured_until=CASE WHEN ?=0 THEN NULL ELSE featured_until END WHERE id=?",
                        (int(available),int(available),product_id))
                    self.send_json(200, {"ok":True}); return
                name = clean_text(data.get("name",row["name"]), "Item name", 80)
                desc = clean_text(data.get("description",row["description"]), "Description", 240, required=False)
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
                db.execute("""UPDATE products SET name=?,description=?,category=?,price_cents=?,emoji=?,stock_count=?,
                    dietary_tags=?,allergen_tags=?,photo_data=?,photo_type=? WHERE id=?""",
                    (name,desc,category,price,emoji,stock_count,json.dumps(dietary_tags),json.dumps(allergen_tags),photo_data,photo_type,product_id))
                updated = db.execute("""SELECT p.*,s.id stall_id,s.name stall_name,s.status stall_status,s.opens_at,s.closes_at,
                    s.pickup_lat,s.pickup_lon
                    FROM products p JOIN stalls s ON s.id=p.stall_id WHERE p.id=?""", (product_id,)).fetchone()
            self.send_json(200, {"product":self.product_json(updated)}); return
        order_match = re.fullmatch(r"/api/orders/(\d+)", path)
        if order_match:
            order_id, action = int(order_match.group(1)), data.get("action")
            user = self.current_user()
            with connect() as db:
                order = db.execute("SELECT o.*,s.owner_id,s.prep_minutes FROM orders o JOIN stalls s ON s.id=o.stall_id WHERE o.id=?", (order_id,)).fetchone()
                if not order: raise ApiError(404, "Order not found.")
                next_status, runner_id = None, order["runner_id"]
                if user["role"] == "owner" and order["owner_id"] == user["id"]:
                    transitions = {"confirm":("placed","confirmed"),"decline":("placed","declined"),"prepare":("confirmed","preparing"),"ready":("preparing","ready")}
                    if action == "assign":
                        if order["status"] != "ready" or order["fulfillment"] != "delivery": raise ApiError(409,"Only ready delivery orders can be assigned.")
                        try: runner_id = int(data.get("runner_id"))
                        except (ValueError,TypeError): raise ValueError("Choose a campus runner.")
                        runner = db.execute("SELECT id FROM users WHERE id=? AND role='runner'", (runner_id,)).fetchone()
                        if not runner: raise ValueError("Choose a valid campus runner.")
                    elif action in transitions:
                        expected,next_status = transitions[action]
                        if order["status"] != expected: raise ApiError(409,"That order has already changed. Refresh and try again.")
                    else: raise ApiError(400,"That order action is not supported.")
                elif user["role"] == "runner" and order["runner_id"] == user["id"]:
                    transitions = {"out":("ready","out"),"delivered":("out","completed")}
                    if action not in transitions: raise ApiError(400,"That order action is not supported.")
                    expected,next_status = transitions[action]
                    if order["status"] != expected: raise ApiError(409,"That order has already changed. Refresh and try again.")
                elif user["role"] == "buyer" and order["buyer_id"] == user["id"]:
                    if action != "collect" or order["fulfillment"] != "pickup" or order["status"] != "ready": raise ApiError(403,"That order cannot be confirmed as collected.")
                    next_status = "completed"
                else: raise ApiError(403,"This account cannot update that order.")
                if next_status == "confirmed":
                    estimate = (datetime.now(timezone.utc)+timedelta(minutes=order["prep_minutes"])).isoformat(timespec="seconds")
                    db.execute("UPDATE orders SET status=?,updated_at=?,estimated_ready_at=? WHERE id=?",
                        (next_status,now(),estimate,order_id))
                elif next_status: db.execute("UPDATE orders SET status=?,updated_at=? WHERE id=?",(next_status,now(),order_id))
                else: db.execute("UPDATE orders SET runner_id=?,updated_at=? WHERE id=?",(runner_id,now(),order_id))
                buyer_id = order["buyer_id"]
                assigned_runner_id = runner_id if action == "assign" else None
                stall_name = db.execute("SELECT name FROM stalls WHERE id=?", (order["stall_id"],)).fetchone()[0]
            if next_status:
                push_status = {"confirmed": ("Order accepted", f"{stall_name} accepted order #{order_id}."),
                    "preparing": ("Your order is being prepared", f"{stall_name} is preparing order #{order_id}."),
                    "ready": ("Your order is ready", f"Order #{order_id} is ready for pickup or delivery."),
                    "out": ("Your order is on the way", f"Order #{order_id} is on the way."),
                    "completed": ("Order completed", f"Order #{order_id} has been completed."),
                    "declined": ("Order update", f"{stall_name} could not accept order #{order_id}.")}
                if next_status in push_status:
                    title, body = push_status[next_status]
                    dispatch_push([buyer_id], {"title": title, "body": body, "url": "/#orders", "tag": f"bitehub-order-{order_id}"})
            if assigned_runner_id:
                dispatch_push([assigned_runner_id], {"title": "Delivery assigned", "body": f"Order #{order_id} is ready for your delivery.", "url": "/#orders", "tag": f"bitehub-order-{order_id}"})
            self.send_json(200,{"ok":True}); return
        raise ApiError(404,"That API route does not exist.")

    def api_delete(self, path):
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
            row = db.execute("SELECT u.id,u.name,u.email,u.role,s.id stall_id,s.name stall_name,s.description stall_description,s.status stall_status,s.opens_at stall_opens_at,s.closes_at stall_closes_at,s.prep_minutes stall_prep_minutes,s.pickup_slot_capacity stall_pickup_slot_capacity FROM users u LEFT JOIN stalls s ON s.owner_id=u.id WHERE u.id=?",(user_id,)).fetchone()
        return dict(row)

    def serve_static(self, requested):
        relative = unquote(requested).lstrip("/") or "index.html"
        target = (BASE / relative).resolve()
        if BASE not in target.parents and target != BASE:
            self.send_error(403); return
        if target.is_dir(): target = target / "index.html"
        if not target.is_file(): self.send_error(404); return
        data = target.read_bytes()
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if mime.startswith("text/") or mime in ("application/javascript",): mime += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type",mime)
        self.send_header("Content-Length",str(len(data)))
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("Content-Security-Policy","default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'")
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
    parser.add_argument("--port",type=int,default=int(os.environ.get("PORT", "8000")),help="Port to bind")
    parser.add_argument("--https-cert",help="PEM server certificate for HTTPS (use with --https-key)")
    parser.add_argument("--https-key",help="PEM private key for HTTPS (use with --https-cert)")
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
    httpd = ThreadingHTTPServer((args.host,args.port),Handler)
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
    print(f"SQLite database: {DB_PATH}")
    try: httpd.serve_forever()
    except KeyboardInterrupt: print("\nStopping BiteHub.")
    finally: httpd.server_close()


if __name__ == "__main__": main()
