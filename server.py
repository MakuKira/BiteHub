#!/usr/bin/env python3
"""BiteHub local server. Uses only Python's standard library and SQLite."""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

BASE = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("BITEHUB_DB", BASE / "bitehub.sqlite3"))
SESSION_SECONDS = 60 * 60 * 24 * 14
PBKDF2_ROUNDS = 310_000
ROLES = {"buyer", "owner", "runner", "admin"}
MAX_BODY = 64 * 1024


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
          name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY, stall_id INTEGER NOT NULL REFERENCES stalls(id) ON DELETE CASCADE,
          name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL,
          price_cents INTEGER NOT NULL CHECK(price_cents > 0), emoji TEXT NOT NULL DEFAULT '🍽️',
          available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)), created_at TEXT NOT NULL
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
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS order_items (
          id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
          name TEXT NOT NULL, price_cents INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 50), emoji TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS orders_buyer_idx ON orders(buyer_id, id DESC);
        CREATE INDEX IF NOT EXISTS orders_stall_idx ON orders(stall_id, id DESC);
        CREATE INDEX IF NOT EXISTS orders_runner_idx ON orders(runner_id, id DESC);
        CREATE INDEX IF NOT EXISTS products_stall_idx ON products(stall_id, available);
        CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
        """)
        db.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),))


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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
                row = db.execute("""SELECT u.id,u.name,u.email,u.role,s.id stall_id,s.name stall_name
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
        if path == "/api/session":
            self.send_json(200, {"user": self.current_user(required=False)})
            return
        if path == "/api/products":
            user = self.current_user(required=False)
            with connect() as db:
                paused = db.execute("SELECT value FROM settings WHERE key='ordering_paused'").fetchone()[0] == "true"
                where, args = "", []
                if not user or user["role"] not in ("admin", "owner"):
                    where = "WHERE p.available=1"
                elif user["role"] == "owner":
                    where, args = "WHERE s.owner_id=? OR p.available=1", [user["id"]]
                rows = db.execute(f"""SELECT p.id,p.name,p.description,p.category,p.price_cents,p.emoji,p.available,
                    s.id stall_id,s.name stall_name,s.description stall_description
                    FROM products p JOIN stalls s ON s.id=p.stall_id {where} ORDER BY s.name,p.name""", args).fetchall()
            self.send_json(200, {"products": [self.product_json(row, bool(user and user["role"] in ("owner", "admin"))) for row in rows], "ordering_paused": paused})
            return
        if path == "/api/orders":
            user = self.current_user()
            with connect() as db:
                if user["role"] == "buyer": sql, args = "o.buyer_id=?", [user["id"]]
                elif user["role"] == "owner": sql, args = "s.owner_id=?", [user["id"]]
                elif user["role"] == "runner": sql, args = "o.runner_id=?", [user["id"]]
                else: sql, args = "1=1", []
                orders = db.execute(f"""SELECT o.*,u.name buyer_name,u.email buyer_email,s.name stall_name,r.name runner_name
                    FROM orders o JOIN users u ON u.id=o.buyer_id JOIN stalls s ON s.id=o.stall_id
                    LEFT JOIN users r ON r.id=o.runner_id WHERE {sql} ORDER BY o.id DESC""", args).fetchall()
                result = [self.order_json(db, row) for row in orders]
            self.send_json(200, {"orders": result})
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
                products = db.execute("SELECT COUNT(*) FROM products").fetchone()[0]
                rows = db.execute("SELECT status,COUNT(*) count,COALESCE(SUM(total_cents),0) sales FROM orders GROUP BY status").fetchall()
                paused = db.execute("SELECT value FROM settings WHERE key='ordering_paused'").fetchone()[0] == "true"
            self.send_json(200, {"users": {row["role"]: row["count"] for row in users}, "stalls": stalls,
                                 "products": products, "orders": [dict(row) for row in rows], "ordering_paused": paused})
            return
        raise ApiError(404, "That API route does not exist.")

    @staticmethod
    def product_json(row, include_unavailable=False):
        item = {"id": row["id"], "name": row["name"], "description": row["description"],
                "category": row["category"], "price": row["price_cents"] / 100, "emoji": row["emoji"],
                "available": bool(row["available"]), "stall_id": row["stall_id"], "stall_name": row["stall_name"]}
        if "stall_description" in row.keys(): item["stall_description"] = row["stall_description"]
        return item

    @staticmethod
    def order_json(db, row):
        items = db.execute("SELECT product_id,name,price_cents,quantity,emoji FROM order_items WHERE order_id=? ORDER BY id", (row["id"],)).fetchall()
        return {"id": row["id"], "buyer": row["buyer_name"], "buyer_email": row["buyer_email"],
                "stall": row["stall_name"], "runner": row["runner_name"], "fulfillment": row["fulfillment"],
                "status": row["status"], "total": row["total_cents"] / 100, "buyer_note": row["buyer_note"],
                "created_at": row["created_at"], "items": [{"product_id": i["product_id"], "name": i["name"],
                "price": i["price_cents"] / 100, "quantity": i["quantity"], "emoji": i["emoji"]} for i in items]}

    def api_post(self, path, data):
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
                if role == "owner": db.execute("INSERT INTO stalls(owner_id,name,created_at) VALUES(?,?,?)", (user_id,stall_name,now()))
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
        if path == "/api/products":
            owner = self.require_role("owner")
            name = clean_text(data.get("name"), "Item name", 80)
            desc = clean_text(data.get("description"), "Description", 240, required=False)
            category = data.get("category")
            if category not in ("Meals", "Snacks", "Drinks"): raise ValueError("Choose a menu category.")
            price = cents(data.get("price"))
            emoji = clean_text(data.get("emoji", "🍽️"), "Food icon", 8)
            with connect() as db:
                cur = db.execute("INSERT INTO products(stall_id,name,description,category,price_cents,emoji,created_at) VALUES(?,?,?,?,?,?,?)",
                                 (owner["stall_id"],name,desc,category,price,emoji,now()))
                row = db.execute("""SELECT p.*,s.id stall_id,s.name stall_name FROM products p JOIN stalls s ON s.id=p.stall_id WHERE p.id=?""", (cur.lastrowid,)).fetchone()
            self.send_json(201, {"product": self.product_json(row)})
            return
        if path == "/api/orders":
            buyer = self.require_role("buyer")
            if data.get("fulfillment") not in ("pickup", "delivery"): raise ValueError("Choose pickup or campus delivery.")
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
                paused = db.execute("SELECT value FROM settings WHERE key='ordering_paused'").fetchone()[0] == "true"
                if paused: raise ApiError(409, "Ordering is temporarily paused.")
                marks = ",".join("?" for _ in ids)
                products = db.execute(f"SELECT p.*,s.id stall_id,s.name stall_name FROM products p JOIN stalls s ON s.id=p.stall_id WHERE p.id IN ({marks}) AND p.available=1", list(ids)).fetchall()
                if len(products) != len(ids): raise ApiError(409, "One or more items are no longer available. Refresh the menu and try again.")
                if len({row["stall_id"] for row in products}) != 1: raise ValueError("Place separate orders for each stall.")
                total = sum(row["price_cents"]*quantities[row["id"]] for row in products)
                cur = db.execute("INSERT INTO orders(buyer_id,stall_id,fulfillment,status,total_cents,buyer_note,created_at,updated_at) VALUES(?,?,?,'placed',?,?,?,?)",
                                 (buyer["id"],products[0]["stall_id"],data["fulfillment"],total,note,now(),now()))
                order_id = cur.lastrowid
                for product in products:
                    db.execute("INSERT INTO order_items(order_id,product_id,name,price_cents,quantity,emoji) VALUES(?,?,?,?,?,?)",
                               (order_id,product["id"],product["name"],product["price_cents"],quantities[product["id"]],product["emoji"]))
            self.send_json(201, {"order_id": order_id})
            return
        if path == "/api/admin/pause":
            self.require_role("admin")
            paused = bool(data.get("paused"))
            with connect() as db: db.execute("UPDATE settings SET value=? WHERE key='ordering_paused'", ("true" if paused else "false",))
            self.send_json(200, {"ordering_paused": paused})
            return
        raise ApiError(404, "That API route does not exist.")

    def api_patch(self, path, data):
        product_match = re.fullmatch(r"/api/products/(\d+)", path)
        if product_match:
            owner = self.require_role("owner")
            product_id = int(product_match.group(1))
            with connect() as db:
                row = db.execute("SELECT p.* FROM products p JOIN stalls s ON s.id=p.stall_id WHERE p.id=? AND s.owner_id=?", (product_id,owner["id"])).fetchone()
                if not row: raise ApiError(404, "Menu item not found.")
                available = data.get("available")
                if not isinstance(available,bool): raise ValueError("Availability must be true or false.")
                db.execute("UPDATE products SET available=? WHERE id=?", (int(available),product_id))
            self.send_json(200, {"ok":True}); return
        order_match = re.fullmatch(r"/api/orders/(\d+)", path)
        if order_match:
            order_id, action = int(order_match.group(1)), data.get("action")
            user = self.current_user()
            with connect() as db:
                order = db.execute("SELECT o.*,s.owner_id FROM orders o JOIN stalls s ON s.id=o.stall_id WHERE o.id=?", (order_id,)).fetchone()
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
                if next_status: db.execute("UPDATE orders SET status=?,updated_at=? WHERE id=?",(next_status,now(),order_id))
                else: db.execute("UPDATE orders SET runner_id=?,updated_at=? WHERE id=?",(runner_id,now(),order_id))
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
            row = db.execute("SELECT u.id,u.name,u.email,u.role,s.id stall_id,s.name stall_name FROM users u LEFT JOIN stalls s ON s.owner_id=u.id WHERE u.id=?",(user_id,)).fetchone()
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
    httpd = ThreadingHTTPServer((args.host,args.port),Handler)
    print(f"BiteHub is running at http://{args.host}:{args.port}")
    print(f"SQLite database: {DB_PATH}")
    try: httpd.serve_forever()
    except KeyboardInterrupt: print("\nStopping BiteHub.")
    finally: httpd.server_close()


if __name__ == "__main__": main()
