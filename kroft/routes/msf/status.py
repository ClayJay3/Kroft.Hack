"""MSF RPC status and console-driven db_nmap scan."""
import time

from flask import jsonify, request

from ...scope import in_scope
from ...services.msf_client import get_msf
from ...services.msf_console import console_create, console_destroy, console_write
from . import bp


@bp.route('/api/msf/status', methods=['GET'])
def msf_status():
    msf = get_msf()
    if not msf:
        return jsonify({'connected': False, 'error': 'Cannot reach msfrpcd'})
    try:
        ver = msf.core.version
        if not isinstance(ver, dict):
            return jsonify({'connected': False, 'error': f'Unexpected version response: {ver!r}'})
        return jsonify({'connected': True, 'version': ver.get('version', '?'),
                        'ruby': ver.get('ruby', '?')})
    except Exception as e:
        return jsonify({'connected': False, 'error': str(e)})


@bp.route('/api/msf/scan', methods=['POST'])
def msf_db_scan():
    """Run db_nmap inside metasploit so results land in its DB and ours."""
    data = request.get_json(silent=True) or {}
    target = (data.get('target') or '').strip()
    if not target:
        return jsonify({'error': 'No target'}), 400
    if not in_scope(target):
        return jsonify({'error': f'{target} is outside the configured engagement scope.'}), 403
    msf = get_msf()
    if not msf:
        return jsonify({'error': 'MSF not connected'}), 503
    try:
        cid = console_create(msf)
        console_write(msf, cid, f'db_nmap -sV -O --version-light {target}')
        time.sleep(2)
        console_destroy(msf, cid)
        return jsonify({'ok': True, 'message': f'db_nmap dispatched for {target}'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
