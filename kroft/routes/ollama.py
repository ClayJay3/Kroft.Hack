"""Ollama integration endpoint.

The Kroft.AI assistant in the browser talks to Ollama directly; this server-side
endpoint only lists the models available on the configured Ollama server so the
UI can offer them in a dropdown.
"""
import json
import urllib.request

from flask import Blueprint, jsonify

from ..config import OLLAMA_BASE
from ..settings_store import get_setting

bp = Blueprint('ollama', __name__)


@bp.route('/api/ollama/models', methods=['GET'])
def ollama_models():
    """Fetch available models from the Ollama server and return them.

    The endpoint is taken from the Settings page (DB), falling back to the
    OLLAMA_BASE env var. If nothing is configured we report that plainly so the
    UI can prompt the operator to set it.
    """
    base = (get_setting('ollama_base') or OLLAMA_BASE or '').strip().rstrip('/')
    if not base:
        return jsonify({'error': 'Ollama endpoint not configured', 'models': []}), 400
    try:
        req = urllib.request.Request(
            base + '/api/tags',
            headers={'Accept': 'application/json'},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            payload = json.loads(resp.read().decode())
        models = [m.get('name') for m in payload.get('models', []) if m.get('name')]
        return jsonify({'models': models})
    except Exception as e:
        return jsonify({'error': str(e), 'models': []}), 502
