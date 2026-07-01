"""A small in-memory event feed for the Cyberspace visualizer.

Whenever the server does something interesting on the operator's behalf (stores
loot, looks a module up in the Metasploit DB, queries NVD for CVEs, dispatches an
exploit) we drop a light, timestamped event onto a bounded ring buffer. The 3D
visualizer polls events_since() and turns each one into a packet streaking to or
from the Kroft core.

This is cosmetic telemetry: it never blocks a request and is safe to lose. Live
state (hosts, jobs, sessions) is read from the normal API; this feed only carries
the discrete "something just happened" pulses.
"""
import threading
import time

_lock = threading.Lock()
_events = []     # list of {seq, ts, kind, host, detail}
_seq = 0
_MAX = 2000      # ring-buffer cap; oldest events are dropped past this


def record(kind, host='', detail=''):
    """Append an event. Returns the stored dict (with its sequence number)."""
    global _seq
    with _lock:
        _seq += 1
        ev = {'seq': _seq, 'ts': time.time(), 'kind': kind,
              'host': host or '', 'detail': (detail or '')[:200]}
        _events.append(ev)
        if len(_events) > _MAX:
            del _events[:len(_events) - _MAX]
        return ev


def events_since(since_seq):
    """Return (events newer than since_seq, current latest seq)."""
    with _lock:
        if since_seq <= 0:
            # First poll: hand back only the recent tail so we don't replay history.
            return list(_events[-200:]), _seq
        return [e for e in _events if e['seq'] > since_seq], _seq
