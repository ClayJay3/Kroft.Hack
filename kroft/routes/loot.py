"""Loot / findings endpoints: list, add (deduped), and delete."""
from datetime import datetime

from flask import Blueprint, jsonify, request

from ..database import Session
from ..models import Loot

bp = Blueprint('loot', __name__)


def _add_loot_items(items):
    """Insert loot dicts, de-duplicating on (host_ip, type, value). Returns count added."""
    added = 0
    db = Session()
    try:
        for it in items:
            if not isinstance(it, dict):
                continue
            value = str(it.get('value', '')).strip()
            if not value:
                continue
            host_ip = str(it.get('host_ip') or it.get('host') or '').strip()
            ltype = str(it.get('type', 'info')).strip()[:40] or 'info'
            exists = db.query(Loot).filter_by(host_ip=host_ip, type=ltype, value=value).first()
            if exists:
                continue
            db.add(Loot(host_ip=host_ip, type=ltype, value=value,
                        username=str(it.get('username', '') or '')[:200],
                        service=str(it.get('service', '') or '')[:100],
                        source=str(it.get('source', '') or '')[:200],
                        found_at=datetime.now().strftime('%Y-%m-%d %H:%M:%S')))
            added += 1
        db.commit()
    finally:
        db.close()
    return added


@bp.route('/api/loot', methods=['GET', 'POST'])
def loot_api():
    if request.method == 'POST':
        data = request.get_json(silent=True) or {}
        items = data.get('items') if isinstance(data.get('items'), list) else [data]
        return jsonify({'ok': True, 'added': _add_loot_items(items)})
    host = request.args.get('host', '').strip()
    db = Session()
    try:
        q = db.query(Loot)
        if host:
            q = q.filter_by(host_ip=host)
        rows = q.order_by(Loot.id.desc()).all()
        return jsonify([{
            'id': r.id, 'host_ip': r.host_ip, 'type': r.type, 'value': r.value,
            'username': r.username, 'service': r.service, 'source': r.source,
            'found_at': r.found_at
        } for r in rows])
    finally:
        db.close()


@bp.route('/api/loot/<int:loot_id>', methods=['DELETE'])
def delete_loot(loot_id):
    db = Session()
    try:
        r = db.query(Loot).filter_by(id=loot_id).first()
        if not r:
            return jsonify({'error': 'Not found'}), 404
        db.delete(r); db.commit()
        return jsonify({'ok': True})
    finally:
        db.close()
