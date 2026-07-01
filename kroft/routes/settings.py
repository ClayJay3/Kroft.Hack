"""Engagement settings endpoint (get / update the key-value store)."""
from flask import Blueprint, jsonify, request

from ..database import Session
from ..models import Setting
from ..settings_store import set_setting

bp = Blueprint('settings', __name__)


@bp.route('/api/settings', methods=['GET', 'POST'])
def settings_api():
    if request.method == 'POST':
        data = request.get_json(silent=True) or {}
        for k, v in data.items():
            set_setting(str(k), '' if v is None else str(v))
        return jsonify({'ok': True})
    db = Session()
    try:
        return jsonify({s.key: s.value for s in db.query(Setting).all()})
    finally:
        db.close()
