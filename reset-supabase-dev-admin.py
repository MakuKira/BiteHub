"""Reset one existing BiteHub Development school-admin password.

This helper is intentionally pinned to the BiteHub-Dev Supabase project. It
does not accept a connection string or a project ref from the user, and it
never prints database or admin passwords, password hashes, or email addresses.
"""
from __future__ import annotations

import getpass
import hashlib
import re
import secrets
import sys


PROJECT_REF = "jmfyhpkfvjdvhsrfkrxj"
POOLER_USERNAME = f"bitehub_api_login.{PROJECT_REF}"
POOLER_HOST = "aws-0-ap-southeast-1.pooler.supabase.com"
DATABASE_NAME = "postgres"
PASSWORD_ROUNDS = 310_000


def main() -> int:
    try:
        import psycopg
    except ImportError:
        print("PostgreSQL support is missing. Run this with BiteHub's .venv Python.")
        return 1

    if not sys.stdin.isatty():
        print("Run this from an interactive VS Code or PowerShell terminal.")
        return 1

    db_password = getpass.getpass(
        f"Enter the current password for the BiteHub-Dev database role {POOLER_USERNAME} (hidden): "
    )
    if not db_password:
        print("No database-role password was entered; nothing changed.")
        return 1

    conn = None
    admin_password = ""
    confirmation = ""
    try:
        conn = psycopg.connect(
            host=POOLER_HOST,
            port=5432,
            dbname=DATABASE_NAME,
            user=POOLER_USERNAME,
            password=db_password,
            sslmode="require",
            connect_timeout=10,
            options="-c search_path=bitehub_app,public",
            application_name="bitehub-dev-admin-password-recovery",
        )

        with conn.cursor() as cursor:
            cursor.execute("SELECT current_database(), current_user")
            database_name, database_user = cursor.fetchone()
            if database_name != DATABASE_NAME or database_user not in {
                "bitehub_api_login",
                POOLER_USERNAME,
            }:
                raise RuntimeError("The connection did not identify as the expected BiteHub-Dev backend role.")

        print("Connected to BiteHub-Dev. Production is not part of this reset.")
        email = getpass.getpass("Email for your existing school-admin account (hidden): ").strip().lower()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            print("That email format is invalid; nothing changed.")
            return 1

        admin_password = getpass.getpass("Enter a new admin password (10+ characters, hidden): ")
        confirmation = getpass.getpass("Enter the new admin password again (hidden): ")
        if admin_password != confirmation:
            print("The entries did not match; nothing changed.")
            return 1
        if len(admin_password) < 10:
            print("Use at least 10 characters; nothing changed.")
            return 1
        if len(admin_password) > 1024:
            print("Use 1,024 characters or fewer; nothing changed.")
            return 1

        salt = secrets.token_bytes(16)
        password_hash = hashlib.pbkdf2_hmac(
            "sha256", admin_password.encode("utf-8"), salt, PASSWORD_ROUNDS
        ).hex()

        with conn.cursor() as cursor:
            cursor.execute(
                """SELECT id FROM bitehub_app.users
                   WHERE lower(email) = %s AND role = 'admin' AND school_id = 'pns'
                     AND deleted_at IS NULL
                   FOR UPDATE""",
                (email,),
            )
            admin_rows = cursor.fetchall()
            if len(admin_rows) != 1:
                conn.rollback()
                if not admin_rows:
                    print("No active PNS school-admin account matched that email in BiteHub-Dev; nothing changed.")
                else:
                    print("More than one matching admin row was found; nothing changed.")
                return 1

            admin_id = admin_rows[0][0]
            cursor.execute(
                """UPDATE bitehub_app.users
                   SET password_hash = %s, password_salt = %s
                   WHERE id = %s AND role = 'admin' AND school_id = 'pns'
                     AND deleted_at IS NULL""",
                (password_hash, salt.hex(), admin_id),
            )
            if cursor.rowcount != 1:
                conn.rollback()
                print("The admin row changed during recovery; nothing was committed.")
                return 1

            cursor.execute("DELETE FROM bitehub_app.sessions WHERE user_id = %s", (admin_id,))
            revoked_sessions = cursor.rowcount

        conn.commit()
        print("BiteHub-Dev admin password reset completed.")
        print(f"Signed out {revoked_sessions} existing Dev session(s). Passkeys were left unchanged.")
        return 0
    except Exception as error:
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
        print(f"Reset stopped ({type(error).__name__}); no password change was committed.")
        print("Confirm the BiteHub-Dev database-role password and try again.")
        return 1
    finally:
        if conn is not None:
            conn.close()
        db_password = ""
        admin_password = ""
        confirmation = ""


if __name__ == "__main__":
    raise SystemExit(main())
