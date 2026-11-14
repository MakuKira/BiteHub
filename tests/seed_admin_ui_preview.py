"""Seed synthetic stalls into the temporary admin UI preview server."""

from __future__ import annotations

import http.cookiejar
import json
import urllib.error
import urllib.request


BASE_URL = "http://127.0.0.1:8010"
PASSWORD = "PreviewOwnerPass123!"


def request(path: str, method: str = "GET", data: dict | None = None, opener=None):
    headers = {"Accept": "application/json"}
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE_URL + path, data=body, headers=headers, method=method)
    client = opener or urllib.request.build_opener()
    try:
        with client.open(req, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


def checked(path: str, method: str = "GET", data: dict | None = None, opener=None):
    status, payload = request(path, method, data, opener)
    if not 200 <= status < 300:
        raise RuntimeError(f"{method} {path} failed ({status}): {payload}")
    return payload


def login(email: str, password: str):
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    checked("/api/login", "POST", {"email": email, "password": password}, client)
    return client


def signup_owner(name: str, email: str, stall_name: str):
    checked("/api/admin/stall-policy", "PATCH", {"mode": "allow_all"}, admin)
    response = checked("/api/signup", "POST", {
        "name": name, "email": email, "password": PASSWORD,
        "role": "owner", "stall_name": stall_name,
    })
    return response["user"], login(email, PASSWORD)


def add_products(owner_client, prefix: str, count: int):
    for index in range(1, count + 1):
        checked("/api/products", "POST", {
            "name": f"{prefix} Food {index}",
            "description": "Synthetic admin filter preview item",
            "category": "Meals", "price": 25 + index,
        }, owner_client)


admin = login("admin@bitehub.test", "AdminPreviewPass123!")
alpha, alpha_client = signup_owner("Four Item Owner", "four@bitehub.test", "Alpha Four Foods")
add_products(alpha_client, "Alpha", 4)

checked("/api/admin/stall-policy", "PATCH", {"mode": "limited"}, admin)
pending_response = checked("/api/signup", "POST", {
    "name": "Pending Owner", "email": "pending@bitehub.test", "password": PASSWORD,
    "role": "owner", "stall_name": "Pending Pantry",
})
pending = pending_response["user"]

paused, paused_client = signup_owner("Paused Owner", "paused@bitehub.test", "Paused Picks")
add_products(paused_client, "Paused", 1)
checked(f"/api/admin/stalls/{paused['stall_id']}", "PATCH", {"status": "paused"}, admin)

checked("/api/admin/stall-policy", "PATCH", {"mode": "allow_all"}, admin)
print(json.dumps({
    "seeded": [
        {"stall": "Alpha Four Foods", "status": alpha["stall_status"], "products": 4},
        {"stall": "Pending Pantry", "status": pending["stall_status"], "products": 0},
        {"stall": "Paused Picks", "status": "paused", "products": 1},
    ],
    "database": "temporary SQLite test database only",
}, indent=2))
