"""Per-host engagement report aggregation endpoint."""
from flask import Blueprint, jsonify

from ..database import Session
from ..models import ExploitLog, Host, Loot

bp = Blueprint('reports', __name__)


@bp.route('/api/report/<ip>', methods=['GET'])
def report_data(ip):
    """Gather everything known about a host so the AI can write an engagement report."""
    db = Session()
    try:
        h = db.query(Host).filter_by(ip_address=ip).first()
        host = None
        if h:
            host = {'ip': h.ip_address, 'hostname': h.hostname, 'os': h.os_guess,
                    'ports': h.open_ports, 'tags': h.tags, 'last_seen': h.last_seen}
        logs = db.query(ExploitLog).filter_by(target_ip=ip).order_by(ExploitLog.id.desc()).all()
        loot = db.query(Loot).filter_by(host_ip=ip).order_by(Loot.id.desc()).all()
        return jsonify({
            'host': host,
            'exploit_logs': [{'module': l.module, 'status': l.status,
                              'result': (l.result or '')[:600], 'started_at': l.started_at,
                              'finished_at': l.finished_at} for l in logs],
            'loot': [{'type': r.type, 'value': r.value, 'username': r.username,
                      'service': r.service, 'source': r.source} for r in loot],
        })
    finally:
        db.close()
