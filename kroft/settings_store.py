"""Small key/value store backed by the Setting table.

Used for engagement-wide configuration that should persist across restarts, most
importantly the scope CIDR(s) that the scope guardrail enforces.
"""
from .database import Session
from .models import Setting


def get_setting(key, default=None):
    db = Session()
    try:
        row = db.query(Setting).filter_by(key=key).first()
        return row.value if row else default
    finally:
        db.close()


def set_setting(key, value):
    db = Session()
    try:
        row = db.query(Setting).filter_by(key=key).first()
        if row:
            row.value = value
        else:
            db.add(Setting(key=key, value=value))
        db.commit()
    finally:
        db.close()
