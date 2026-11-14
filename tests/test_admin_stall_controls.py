"""Isolated integration tests for admin stall policies and removal actions."""

from __future__ import annotations

import http.cookiejar
import gc
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server  # noqa: E402


class AdminStallControlsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory(prefix="bitehub-admin-controls-")
        server.DB_PATH = Path(cls.temp_dir.name) / "bitehub-test.sqlite3"
        server.DATABASE_URL = ""
        server.REQUIRE_POSTGRES = False
        server.dispatch_push = lambda *_args, **_kwargs: None
        server.Handler.log_message = lambda *_args, **_kwargs: None
        # Simulate a Dev preview that was imported while PostgreSQL was
        # configured, then switched to SQLite before initialization.
        for capability in (
            "PASSKEYS_AVAILABLE", "ORDER_MESSAGES_AVAILABLE", "GUEST_PUSH_AVAILABLE",
            "ORDER_CANCELLATION_AVAILABLE", "GUEST_FEEDBACK_AVAILABLE",
            "NOTIFICATION_INBOX_AVAILABLE", "WEEKLY_MENU_AVAILABLE",
        ):
            setattr(server, capability, False)
        cls._original_connect = server.connect
        cls._original_sqlite_connect = server.sqlite3.connect
        cls._sqlite_connections = []

        def cross_thread_sqlite_connect(*args, **kwargs):
            kwargs["check_same_thread"] = False
            return cls._original_sqlite_connect(*args, **kwargs)

        server.sqlite3.connect = cross_thread_sqlite_connect

        def tracked_connect():
            connection = cls._original_connect()
            cls._sqlite_connections.append(connection)
            return connection

        server.connect = tracked_connect
        server.initialize()
        server.create_admin("admin@bitehub.test", "Test Administrator", "AdminTestPass123!")
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.httpd.daemon_threads = True
        cls.base_url = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.admin = cls.login("admin@bitehub.test", "AdminTestPass123!")

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=3)
        for connection in cls._sqlite_connections:
            connection.close()
        server.connect = cls._original_connect
        server.sqlite3.connect = cls._original_sqlite_connect
        gc.collect()
        cls.temp_dir.cleanup()

    @classmethod
    def opener(cls):
        jar = http.cookiejar.CookieJar()
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    @classmethod
    def request(cls, path, method="GET", data=None, opener=None):
        headers = {"Accept": "application/json"}
        raw = None
        if data is not None:
            raw = json.dumps(data).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(cls.base_url + path, data=raw, headers=headers, method=method)
        client = opener or urllib.request.build_opener()
        try:
            with client.open(req, timeout=5) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    @classmethod
    def login(cls, email, password):
        client = cls.opener()
        status, payload = cls.request("/api/login", "POST",
            {"email": email, "password": password}, client)
        if status != 200:
            raise AssertionError(f"Login failed ({status}): {payload}")
        return client

    @classmethod
    def set_mode(cls, mode):
        status, payload = cls.request("/api/admin/stall-policy", "PATCH", {"mode": mode}, cls.admin)
        if status != 200:
            raise AssertionError(f"Could not set mode {mode!r} ({status}): {payload}")
        return payload

    def test_sqlite_initialization_reenables_dev_capabilities(self):
        self.assertTrue(server.ORDER_MESSAGES_AVAILABLE)
        self.assertTrue(server.GUEST_PUSH_AVAILABLE)
        self.assertTrue(server.ORDER_CANCELLATION_AVAILABLE)
        self.assertTrue(server.GUEST_FEEDBACK_AVAILABLE)
        self.assertTrue(server.NOTIFICATION_INBOX_AVAILABLE)
        self.assertTrue(server.WEEKLY_MENU_AVAILABLE)
        self.assertEqual(server.PASSKEYS_AVAILABLE, server.WEBAUTHN_AVAILABLE)

        status, payload = self.request("/api/admin/passkeys/status", opener=self.admin)
        self.assertEqual(status, 200 if server.WEBAUTHN_AVAILABLE else 503, payload)
        if server.WEBAUTHN_AVAILABLE:
            self.assertEqual(payload["count"], 0)

    def test_notification_inbox_returns_persisted_order_alert(self):
        with server.connect() as db:
            admin_id = db.execute("SELECT id FROM users WHERE email=?", ("admin@bitehub.test",)).fetchone()["id"]
        server.persist_inbox_notifications([admin_id], payload={
            "title": "BiteHub test alert",
            "body": "A new order update is ready.",
            "url": "/#buyer-orders",
            "tag": "bitehub-test-order-1",
        })

        status, inbox = self.request("/api/notifications/inbox", opener=self.admin)
        self.assertEqual(status, 200, inbox)
        self.assertEqual(inbox["unread_count"], 1)
        self.assertEqual(inbox["notifications"][0]["title"], "BiteHub test alert")

    @classmethod
    def create_owner(cls, label, mode="allow_all"):
        cls.set_mode(mode)
        email = f"{label.lower().replace(' ', '-')}-{threading.get_ident()}@bitehub.test"
        status, payload = cls.request("/api/signup", "POST", {
            "name": f"Owner {label}", "email": email,
            "password": "OwnerTestPass123!", "role": "owner", "stall_name": f"{label} Stall",
        })
        if status != 201:
            raise AssertionError(f"Owner signup failed ({status}): {payload}")
        return email, payload["user"], cls.login(email, "OwnerTestPass123!")

    @staticmethod
    def product_payload(name="Test item"):
        return {"name": name, "description": "Isolated admin control test", "category": "Meals", "price": 42}

    def test_allow_all_approves_new_stall_signup(self):
        self.set_mode("allow_all")
        email, owner, _client = self.create_owner("Allow All")
        self.assertEqual(owner["email"], email)
        self.assertEqual(owner["stall_status"], "approved")

    def test_stop_all_blocks_signup_catalog_product_creation_and_orders(self):
        _email, owner, owner_client = self.create_owner("Stop Mode Existing")
        status, created = self.request("/api/products", "POST", self.product_payload(), owner_client)
        self.assertEqual(status, 201)
        if server.WEEKLY_MENU_AVAILABLE:
            with server.connect() as db:
                db.execute("INSERT INTO weekly_menu_slots(stall_id,product_id,weekday,service_period,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                    (owner["stall_id"], created["product"]["id"], 1, "Lunch", server.now(), server.now()))
        self.set_mode("stop_all")

        status, response = self.request("/api/signup", "POST", {
            "name": "Blocked Owner", "email": "blocked-owner@bitehub.test",
            "password": "OwnerTestPass123!", "role": "owner", "stall_name": "Blocked Stall",
        })
        self.assertEqual(status, 409)
        self.assertIn("paused", response["error"].lower())

        status, response = self.request("/api/products", "POST", self.product_payload("Blocked food"), owner_client)
        self.assertEqual(status, 409)
        self.assertIn("stopped", response["error"].lower())

        status, catalog = self.request("/api/products")
        self.assertEqual(status, 200)
        self.assertEqual(catalog["products"], [])
        self.assertEqual(catalog["featured_products"], [])
        self.assertEqual(catalog["weekly_menu"], [])
        status, _ = self.request(f"/api/stalls/{owner['stall_id']}")
        self.assertEqual(status, 404)
        status, response = self.request("/api/guest/orders", "POST", {"fulfillment": "pickup", "items": []})
        self.assertEqual(status, 409)
        self.assertIn("sales are temporarily stopped", response["error"].lower())

    def test_limited_signup_waits_for_admin_approval_before_publishing(self):
        email, owner, owner_client = self.create_owner("Limited Applicant", "limited")
        self.assertEqual(owner["email"], email)
        self.assertEqual(owner["stall_status"], "pending")
        status, _ = self.request("/api/products", "POST", self.product_payload(), owner_client)
        self.assertEqual(status, 409)

        status, result = self.request(f"/api/admin/stalls/{owner['stall_id']}", "PATCH",
            {"status": "approved"}, self.admin)
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "approved")
        status, result = self.request("/api/products", "POST", self.product_payload("Approved item"), owner_client)
        self.assertEqual(status, 201)
        self.assertEqual(result["product"]["name"], "Approved item")

    def test_admin_food_removal_preserves_order_line_and_can_be_restored(self):
        _email, owner, owner_client = self.create_owner("Product Removal")
        status, created = self.request("/api/products", "POST", self.product_payload("Historic item"), owner_client)
        self.assertEqual(status, 201)
        product = created["product"]
        status, order = self.request("/api/guest/orders", "POST", {
            "guest_name": "Test Guest", "fulfillment": "pickup",
            "items": [{"product_id": product["id"], "quantity": 1}],
        })
        self.assertEqual(status, 201, order)

        status, result = self.request(f"/api/admin/products/{product['id']}", "DELETE", opener=self.admin)
        self.assertEqual(status, 200)
        self.assertTrue(result["order_history_preserved"])
        with server.connect() as db:
            line = db.execute("SELECT product_id,name,price_cents FROM order_items WHERE order_id=?", (order["order_id"],)).fetchone()
            archived = db.execute("SELECT available,deleted_at FROM products WHERE id=?", (product["id"],)).fetchone()
        self.assertEqual(line["product_id"], product["id"])
        self.assertEqual(line["name"], "Historic item")
        self.assertEqual(line["price_cents"], 4200)
        self.assertFalse(archived["available"])
        self.assertIsNotNone(archived["deleted_at"])
        status, catalog = self.request("/api/products")
        self.assertEqual(status, 200)
        self.assertNotIn(product["id"], {item["id"] for item in catalog["products"]})

        status, activity = self.request("/api/admin/activity", opener=self.admin)
        self.assertEqual(status, 200, activity)
        removal = next(entry for entry in activity["entries"]
            if entry["action"] == "delete_product" and entry["target_id"] == product["id"])
        self.assertTrue(removal["can_restore"])

        status, restored = self.request(f"/api/admin/activity/{removal['id']}/restore", "POST", {}, self.admin)
        self.assertEqual(status, 200, restored)
        with server.connect() as db:
            active = db.execute("SELECT available,deleted_at FROM products WHERE id=?", (product["id"],)).fetchone()
        self.assertTrue(active["available"])
        self.assertIsNone(active["deleted_at"])
        status, catalog = self.request("/api/products")
        self.assertEqual(status, 200)
        self.assertIn(product["id"], {item["id"] for item in catalog["products"]})

        status, repeated = self.request(f"/api/admin/activity/{removal['id']}/restore", "POST", {}, self.admin)
        self.assertEqual(status, 409, repeated)

    def test_admin_stall_removal_disables_login_but_preserves_orders(self):
        email, owner, owner_client = self.create_owner("Account Removal")
        status, created = self.request("/api/products", "POST", self.product_payload("Archived stall item"), owner_client)
        self.assertEqual(status, 201)
        status, order = self.request("/api/guest/orders", "POST", {
            "guest_name": "Order History Guest", "fulfillment": "pickup",
            "items": [{"product_id": created["product"]["id"], "quantity": 1}],
        })
        self.assertEqual(status, 201, order)

        status, result = self.request(f"/api/admin/stalls/{owner['stall_id']}", "DELETE", opener=self.admin)
        self.assertEqual(status, 200)
        self.assertTrue(result["history_preserved"])
        with server.connect() as db:
            account = db.execute("SELECT deleted_at FROM users WHERE id=?", (owner["id"],)).fetchone()
            stall = db.execute("SELECT status FROM stalls WHERE id=?", (owner["stall_id"],)).fetchone()
            product = db.execute("SELECT available FROM products WHERE id=?", (created["product"]["id"],)).fetchone()
            history = db.execute("SELECT id FROM orders WHERE id=?", (order["order_id"],)).fetchone()
        self.assertIsNotNone(account["deleted_at"])
        self.assertEqual(stall["status"], "paused")
        self.assertFalse(product["available"])
        self.assertIsNotNone(history)
        status, session = self.request("/api/session", opener=owner_client)
        self.assertEqual(status, 200)
        self.assertIsNone(session["user"])
        status, _ = self.request("/api/login", "POST", {"email": email, "password": "OwnerTestPass123!"})
        self.assertEqual(status, 401)


if __name__ == "__main__":
    unittest.main(verbosity=2)
