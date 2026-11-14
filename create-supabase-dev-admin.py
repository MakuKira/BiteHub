"""Create one PNS school-admin account in the pinned BiteHub-Dev project.

The project host and pooler role are fixed here. All credentials are entered
locally through hidden prompts and are never written to logs or source files.
This utility does not connect to the BiteHub Production project.
"""
from __future__ import annotations

import getpass
import hashlib
import re
import secrets
import sys
from datetime import datetime, timezone


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
        print("Run this from an interactive VS Code or PowerShell terminal for hidden password input.")
        return 1

    db_password = ""
    admin_password = ""
    confirmation = ""
    conn = None
    try:
        db_password = getpass.getpass(
            f"Enter the current password for the BiteHub-Dev database role {POOLER_USERNAME} (hidden): "
        )
        if not db_password:
            print("No database-role password was entered; nothing changed.")
            return 1

        conn = psycopg.connect(
            host=POOLER_HOST,
            port=5432,
            dbname=DATABASE_NAME,
            user=POOLER_USERNAME,
            password=db_password,
            sslmode="require",
            connect_timeout=10,
            options="-c search_path=bitehub_app,public",
            application_name="bitehub-dev-admin-creation",
        )

        with conn.cursor() as cursor:
            cursor.execute("SELECT current_database(), current_user, current_schema()")
            database_name, database_user, database_schema = cursor.fetchone()
            if (
                database_name != DATABASE_NAME
                or database_user not in {"bitehub_api_login", POOLER_USERNAME}
                or database_schema != "bitehub_app"
            ):
                conn.rollback()
                print("Connection identity did not match the pinned BiteHub-Dev backend; nothing changed.")
                return 1

            cursor.execute(
                "SELECT name FROM bitehub_app.schools WHERE id = 'pns'"
            )
            school = cursor.fetchone()
            if not school or school[0] != "Palawan National School":
                conn.rollback()
                print("The expected PNS school row was not found in BiteHub-Dev; nothing changed.")
                return 1

        print(f"Connected to BiteHub-Dev ({PROJECT_REF}); Production is not part of this action.")
        email = getpass.getpass("New admin email (hidden): ").strip().lower()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            conn.rollback()
            print("That email format is invalid; nothing changed.")
            return 1

        name = input("Admin display name: ").strip()
        if not name or len(name) > 80:
            conn.rollback()
            print("Enter a display name from 1 to 80 characters; nothing changed.")
            return 1

        admin_password = getpass.getpass("New admin password (10+ characters, hidden): ")
        confirmation = getpass.getpass("Enter the new admin password again (hidden): ")
        if admin_password != confirmation:
            conn.rollback()
            print("The password entries did not match; nothing changed.")
            return 1
        if len(admin_password) < 10:
            conn.rollback()
            print("Use at least 10 characters; nothing changed.")
            return 1
        if len(admin_password) > 1024:
            conn.rollback()
            print("Use 1,024 characters or fewer; nothing changed.")
            return 1

        salt = secrets.token_bytes(16)
        password_hash = hashlib.pbkdf2_hmac(
            "sha256", admin_password.encode("utf-8"), salt, PASSWORD_ROUNDS
        ).hex()

        with conn.cursor() as cursor:
            # The schema's case-insensitive unique index includes soft-deleted
            # rows too, so refuse any existing email rather than promote or
            # overwrite another account.
            cursor.execute(
                "SELECT id FROM bitehub_app.users WHERE lower(email) = %s LIMIT 1",
                (email,),
            )
            if cursor.fetchone():
                conn.rollback()
                print("An account already uses that email in BiteHub-Dev; no account was changed.")
                return 1

            cursor.execute(
                """INSERT INTO bitehub_app.users
                   (name, email, password_hash, password_salt, role, school_id, created_at)
                   VALUES (%s, %s, %s, %s, 'admin', 'pns', %s)
                   RETURNING id, role, school_id""",
                (
                    name,
                    email,
                    password_hash,
                    salt.hex(),
                    datetime.now(timezone.utc),
                ),
            )
            created_id, created_role, created_school = cursor.fetchone()
            if created_role != "admin" or created_school != "pns":
                conn.rollback()
                print("The inserted account did not verify as a PNS admin; nothing was committed.")
                return 1

        conn.commit()
        print("BiteHub-Dev PNS admin account created successfully.")
        print("Sign in locally at http://localhost:8001/ with the credentials entered here.")
        print("No passkey was created; register one after signing in if desired.")
        return 0
    except Exception as error:
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
        print(f"Account creation stopped ({type(error).__name__}); no credentials were printed.")
        print("Confirm the BiteHub-Dev database-role password and inspect Dev before retrying.")
        return 1
    finally:
        if conn is not None:
            conn.close()
        db_password = ""
        admin_password = ""
        confirmation = ""


if __name__ == "__main__":
    raise SystemExit(main())
