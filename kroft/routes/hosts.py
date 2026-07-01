"""Host (asset) inventory endpoints: list, delete, tag, and export."""
import json

from flask import Blueprint, Response, jsonify, request

from ..database import Session
from ..models import Host

bp = Blueprint('hosts', __name__)


@bp.route('/api/hosts', methods=['GET'])
def get_hosts():
    db = Session()
    try:
        hosts = db.query(Host).all()
        return jsonify([{
            'id': h.id, 'ip': h.ip_address, 'mac': h.mac_address,
            'hostname': h.hostname, 'os': h.os_guess,
            'ports': h.open_ports, 'ports_json': json.loads(h.ports_json or '[]'),
            'status': h.status, 'last_seen': h.last_seen, 'tags': h.tags or ''
        } for h in hosts])
    finally:
        db.close()


@bp.route('/api/hosts/<int:host_id>', methods=['DELETE'])
def delete_host(host_id):
    db = Session()
    try:
        h = db.query(Host).filter_by(id=host_id).first()
        if not h:
            return jsonify({'error': 'Not found'}), 404
        db.delete(h); db.commit()
        return jsonify({'ok': True})
    finally:
        db.close()


@bp.route('/api/hosts/<int:host_id>/tags', methods=['POST'])
def set_host_tags(host_id):
    data = request.get_json(silent=True) or {}
    tags = data.get('tags', '')
    if isinstance(tags, list):
        tags = ','.join(str(t).strip() for t in tags if str(t).strip())
    db = Session()
    try:
        h = db.query(Host).filter_by(id=host_id).first()
        if not h:
            return jsonify({'error': 'Not found'}), 404
        h.tags = (tags or '').strip()[:300]; db.commit()
        return jsonify({'ok': True, 'tags': h.tags})
    finally:
        db.close()


@bp.route('/api/hosts/export', methods=['GET'])
def export_hosts():
    fmt = request.args.get('format', 'json').lower()
    db = Session()
    try:
        hosts = db.query(Host).all()
        rows = [{
            'ip': h.ip_address, 'hostname': h.hostname or '', 'mac': h.mac_address or '',
            'os': h.os_guess or '', 'tags': h.tags or '', 'status': h.status or '',
            'last_seen': h.last_seen or '', 'ports': (h.open_ports or '').replace('\n', ' | ')
        } for h in hosts]
    finally:
        db.close()
    if fmt == 'csv':
        import csv
        import io
        buf = io.StringIO()
        cols = ['ip', 'hostname', 'mac', 'os', 'tags', 'status', 'last_seen', 'ports']
        w = csv.DictWriter(buf, fieldnames=cols); w.writeheader(); w.writerows(rows)
        return Response(buf.getvalue(), mimetype='text/csv',
                        headers={'Content-Disposition': 'attachment; filename=kroft_assets.csv'})
    return Response(json.dumps(rows, indent=2), mimetype='application/json',
                    headers={'Content-Disposition': 'attachment; filename=kroft_assets.json'})
