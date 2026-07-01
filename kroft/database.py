"""Database engine, session factory, and schema bootstrap.

All persistence in Kroft goes through the SQLAlchemy ORM models in kroft.models.
Modules that need a database session import Session from here and use it as
`db = Session()` / `db.close()`.
"""
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import DB_PATH

# `check_same_thread=False` lets the background scan/exploit worker threads share
# the SQLite connection pool with the request threads.
engine = create_engine(DB_PATH, echo=False, connect_args={'check_same_thread': False})

Base = declarative_base()
Session = sessionmaker(bind=engine)


def init_db():
    """Create any missing tables and apply lightweight migrations.

    Safe to call repeatedly; called once on application startup.
    """
    # Importing the models registers them on `Base` before create_all() runs.
    from . import models  # noqa: F401
    Base.metadata.create_all(engine)
    _ensure_schema()


def _ensure_schema():
    """create_all() won't add new columns to an existing table, so patch them in.

    Keeps databases created by older versions of the app working without a manual
    migration step.
    """
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.exec_driver_sql("PRAGMA table_info(hosts)").fetchall()]
            if 'tags' not in cols:
                conn.exec_driver_sql("ALTER TABLE hosts ADD COLUMN tags VARCHAR(300)")
            conn.commit()
    except Exception as e:
        print(f'[schema migration] {e}', flush=True)
