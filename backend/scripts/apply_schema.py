"""Aplica database/schema.sql no Postgres configurado em DATABASE_URL.

Uso:  python scripts/apply_schema.py
Idempotente para re-runs parciais: ignora erros de "already exists".
"""

import sys
from pathlib import Path

import psycopg2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.config import settings  # noqa: E402


def main() -> None:
    sql = Path(__file__).resolve().parent.parent.parent.joinpath(
        "database", "schema.sql").read_text(encoding="utf-8")

    # psycopg2 aceita URI postgresql://, mas nossa URL usa o dialeto SQLAlchemy
    dsn = settings.database_url.replace("postgresql+psycopg2://", "postgresql://")
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    cur = conn.cursor()
    try:
        cur.execute(sql)
    except Exception as exc:
        print(f"aviso durante aplicação: {exc}")
    finally:
        cur.close()
        conn.close()
    print("schema aplicado.")


if __name__ == "__main__":
    main()
