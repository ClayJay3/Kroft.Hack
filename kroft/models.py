"""SQLAlchemy ORM models. This is the data that persists across an engagement.

Host        assets discovered by nmap / db_nmap.
ExploitLog  a record of every exploit / auxiliary / post run.
Loot        credentials, hashes, keys and other findings.
Setting     key/value app settings (e.g. the engagement scope).
"""
from sqlalchemy import Column, Integer, String, Text

from .database import Base


class Host(Base):
    __tablename__ = 'hosts'
    id            = Column(Integer, primary_key=True)
    ip_address    = Column(String(50), unique=True)
    mac_address   = Column(String(50))
    hostname      = Column(String(100))
    os_guess      = Column(String(200))
    open_ports    = Column(Text)   # newline-separated "port/proto: svc (product ver)"
    ports_json    = Column(Text)   # JSON list for structured use
    status        = Column(String(20))
    last_seen     = Column(String(30))
    tags          = Column(String(300))   # comma-separated user labels


class ExploitLog(Base):
    __tablename__ = 'exploit_logs'
    id            = Column(Integer, primary_key=True)
    target_ip     = Column(String(50))
    module        = Column(String(200))
    options       = Column(Text)   # JSON
    status        = Column(String(30))   # running / succeeded / failed
    result        = Column(Text)
    session_id    = Column(String(50))
    started_at    = Column(String(30))
    finished_at   = Column(String(30))


class Loot(Base):
    __tablename__ = 'loot'
    id          = Column(Integer, primary_key=True)
    host_ip     = Column(String(50))
    type        = Column(String(40))    # credential / hash / key / ssid / token / file / info
    value       = Column(Text)
    username    = Column(String(200))   # optional (credentials)
    service     = Column(String(100))   # optional (ssh / smb / http / ...)
    source      = Column(String(200))   # module or how it was found
    found_at    = Column(String(30))


class Setting(Base):
    __tablename__ = 'settings'
    key         = Column(String(60), primary_key=True)
    value       = Column(Text)
