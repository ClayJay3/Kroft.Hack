"""Translate interesting HTTP requests into Cyberspace event pulses.

Registered as an after_request hook, this watches for the handful of routes that
represent the AI/operator actually doing something with the Kroft brain (reading
the asset DB, looking modules up, storing loot, querying NVD, dispatching an
exploit) and records one light event per action (see kroft.events).

Routine UI polling (/api/hosts, /api/jobs, /api/msf/sessions, and so on) is
ignored so the visualizer's packet traffic stays meaningful rather than a constant
blur. Live state for those is read straight from the normal API.
"""
from .events import record


def register_activity_feed(app):
    @app.after_request
    def _emit_event(resp):
        try:
            kind, host, detail = _classify(_RequestView(resp))
            if kind:
                record(kind, host, detail)
        except Exception:
            pass   # telemetry must never break a real response
        return resp


class _RequestView:
    """Tiny accessor so _classify doesn't import flask.request at module load."""
    def __init__(self, _resp):
        from flask import request
        self.path = request.path
        self.method = request.method
        self.args = request.args
        self.view_args = request.view_args or {}
        self._json = request.get_json(silent=True) or {}

    def body(self):
        return self._json


def _classify(r):
    """Return (kind, host, detail) for a request, or (None, '', '') to ignore it."""
    p, m = r.path, r.method
    b = r.body()

    if p == '/api/loot' and m == 'POST':
        items = b.get('items') if isinstance(b.get('items'), list) else [b]
        host = ''
        for it in items:
            if isinstance(it, dict):
                host = str(it.get('host_ip') or it.get('host') or '')
                if host:
                    break
        return 'loot_stored', host, ''

    if p == '/api/cve' and m == 'GET':
        return 'cve_lookup', '', r.args.get('q', '')

    if p.startswith('/api/report/') and m == 'GET':
        return 'report', r.view_args.get('ip', ''), ''

    if p == '/api/scan' and m == 'POST':
        return 'scan_dispatch', str(b.get('target', '')), ''

    if p == '/api/msf/scan' and m == 'POST':
        return 'scan_dispatch', str(b.get('target', '')), ''

    if p == '/api/msf/exploit' and m == 'POST':
        return 'exploit_dispatch', str(b.get('target_ip', '')), str(b.get('module', ''))

    if p == '/api/msf/post' and m == 'POST':
        return 'module_run', '', str(b.get('module', ''))

    if p == '/api/msf/console_exec' and m == 'POST':
        return 'console_exec', '', ''

    if p.startswith('/api/msf/sessions/') and p.endswith('/exec') and m == 'POST':
        return 'session_cmd', '', str(b.get('cmd', ''))

    if p.startswith('/api/msf/modules/'):
        detail = r.args.get('q') or r.args.get('module') or ''
        if not detail and m == 'POST':
            kw = b.get('keywords') or []
            if isinstance(kw, list):
                detail = ','.join(str(k) for k in kw[:5])
        return 'module_lookup', '', detail

    return None, '', ''
