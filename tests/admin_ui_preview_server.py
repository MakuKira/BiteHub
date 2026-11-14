"""Disposable local server for browser-checking the admin stalls screen.

Run from the project root with ``python tests/admin_ui_preview_server.py``.
It uses a fresh temporary SQLite database and a synthetic admin account only.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server


def main() -> None:
    test_directory = tempfile.TemporaryDirectory(prefix="bitehub-admin-ui-preview-")
    server.DB_PATH = Path(test_directory.name) / "bitehub-admin-preview.sqlite3"
    server.DATABASE_URL = ""
    server.REQUIRE_POSTGRES = False
    server.dispatch_push = lambda *_args, **_kwargs: None
    server.initialize()
    email = "admin@bitehub.test"
    password = "AdminPreviewPass123!"
    server.create_admin(email, "BiteHub UI Test Admin", password)
    port = int(os.environ.get("BITEHUB_ADMIN_PREVIEW_PORT", "8010"))
    httpd = server.ThreadingHTTPServer(("127.0.0.1", port), server.Handler)
    print(f"Isolated BiteHub admin preview: http://127.0.0.1:{port}/", flush=True)
    print(f"Synthetic test login: {email} / {password}", flush=True)
    print("Database: temporary SQLite only; no Supabase or Production connection.", flush=True)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
        test_directory.cleanup()


if __name__ == "__main__":
    main()
