"""Start a local BiteHub copy against the private Supabase development database."""
from __future__ import annotations

import getpass
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import quote
import venv


ROOT = Path(__file__).resolve().parent
VENV_DIR = ROOT / ".venv"
VENV_PYTHON = VENV_DIR / "Scripts" / "python.exe"
POOLER_USERNAME = "bitehub_api_login.jmfyhpkfvjdvhsrfkrxj"
POOLER_HOST = "aws-0-ap-southeast-1.pooler.supabase.com"
DATABASE_NAME = "postgres"


def main() -> int:
    if not VENV_PYTHON.is_file():
        print("Preparing BiteHub's local Python environment...")
        venv.EnvBuilder(with_pip=True).create(VENV_DIR)

    dependencies = subprocess.run(
        [str(VENV_PYTHON), "-c", "import psycopg, psycopg_pool"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if dependencies.returncode:
        print("Installing BiteHub's database dependencies...")
        subprocess.run(
            [str(VENV_PYTHON), "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")],
            cwd=ROOT,
            check=True,
        )

    if not sys.stdin.isatty():
        raise SystemExit("Run this from an interactive VS Code or PowerShell terminal for hidden password input.")

    database_password = ""
    connection_url = ""
    child_environment = None
    try:
        database_password = getpass.getpass(
            f"Enter the reset password for Supabase role {POOLER_USERNAME} (input hidden): "
        )
        if not database_password:
            raise SystemExit("No database-role password was entered.")

        encoded_password = quote(database_password, safe="")
        connection_url = (
            f"postgresql://{POOLER_USERNAME}:{encoded_password}"
            f"@{POOLER_HOST}:5432/{DATABASE_NAME}"
        )

        child_environment = os.environ.copy()
        child_environment["BITEHUB_DATABASE_URL"] = connection_url
        print("Connecting to Supabase; BiteHub will start at http://127.0.0.1:8001 after initialization.")
        process = subprocess.run(
            [
                str(VENV_PYTHON),
                "-u",
                str(ROOT / "server.py"),
                "--host",
                "127.0.0.1",
                "--port",
                "8001",
            ],
            cwd=ROOT,
            env=child_environment,
            check=False,
        )
        if process.returncode != 0:
            print("BiteHub exited before completing startup. The hidden password prompt is closed; do not enter a password at the PowerShell prompt.")
        return process.returncode
    finally:
        database_password = ""
        connection_url = ""
        if child_environment is not None:
            child_environment.pop("BITEHUB_DATABASE_URL", None)


if __name__ == "__main__":
    raise SystemExit(main())
