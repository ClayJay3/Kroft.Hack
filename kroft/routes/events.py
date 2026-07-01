"""Event-feed endpoint consumed by the Cyberspace visualizer."""
from flask import Blueprint, jsonify, request

from ..events import events_since

bp = Blueprint('events', __name__)


@bp.route('/api/events', methods=['GET'])
def get_events():
    try:
        since = int(request.args.get('since', 0))
    except (TypeError, ValueError):
        since = 0
    evs, last_seq = events_since(since)
    return jsonify({'events': evs, 'last_seq': last_seq})
