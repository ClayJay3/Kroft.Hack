"""Live shell / meterpreter session listing and interaction."""
import time
from datetime import datetime

from flask import jsonify, request

from ...services.msf_client import get_msf
from ...state import msf_lock, msf_sessions
from . import bp


@bp.route('/api/msf/sessions', methods=['GET'])
def msf_sessions_list():
    # Sync from live MSF, always updating existing sessions so type changes
    # (e.g. shell to meterpreter after shell_to_meterpreter) are reflected
    msf = get_msf()
    if msf:
        try:
            live = msf.sessions.list
            if not isinstance(live, dict):
                live = {}
            with msf_lock:
                for sid, info in live.items():
                    sid_str = str(sid)
                    if sid_str not in msf_sessions:
                        msf_sessions[sid_str] = {
                            'id': sid_str,
                            'type': info.get('type', 'shell'),
                            'target': info.get('target_host', '?'),
                            'tunnel': info.get('tunnel_local', ''),
                            'info': info.get('info', ''),
                            'opened_at': '-',
                            'module': info.get('via_exploit', 'unknown'),
                            'log': []
                        }
                    else:
                        # Always refresh live fields; catches shell-to-meterpreter upgrades
                        msf_sessions[sid_str]['type']   = info.get('type', msf_sessions[sid_str]['type'])
                        msf_sessions[sid_str]['target'] = info.get('target_host', msf_sessions[sid_str]['target'])
                        msf_sessions[sid_str]['tunnel'] = info.get('tunnel_local', msf_sessions[sid_str]['tunnel'])
                        msf_sessions[sid_str]['info']   = info.get('info', msf_sessions[sid_str]['info'])
                # Remove dead sessions
                live_ids = {str(k) for k in live.keys()}
                dead = [k for k in list(msf_sessions.keys()) if k not in live_ids]
                for k in dead:
                    del msf_sessions[k]
        except Exception as e:
            print(f'[session sync error] {e}')
    with msf_lock:
        return jsonify(list(msf_sessions.values()))


@bp.route('/api/msf/sessions/<sid>/exec', methods=['POST'])
def session_exec(sid):
    data = request.get_json(silent=True) or {}
    cmd  = data.get('cmd', '').strip()
    if not cmd:
        return jsonify({'error': 'No command'}), 400
    msf = get_msf()
    if not msf:
        return jsonify({'error': 'MSF not connected'}), 503
    try:
        # Determine session type from our cache
        with msf_lock:
            sinfo = msf_sessions.get(str(sid), {})
        stype = sinfo.get('type', 'shell')

        session = msf.sessions.session(str(sid))

        if stype == 'meterpreter':
            # Meterpreter: run_with_output blocks until complete
            try:
                output = session.run_with_output(cmd, timeout=15)
            except Exception:
                session.write(cmd + '\n')
                time.sleep(1.5)
                output = session.read()
        else:
            # Plain shell: uses the MSF ring-buffer API via the RPC console.
            # session.write() + session.read() works for shell sessions too,
            # but we need to flush the ring buffer properly.
            session.write(cmd + '\n')
            # Give the remote side time to respond; poll for up to 8s
            output = ''
            deadline = time.time() + 8
            while time.time() < deadline:
                time.sleep(0.4)
                chunk = session.read()
                if chunk:
                    output += chunk
                    # If we got data and it looks like a prompt, stop early
                    if chunk.strip().endswith('$') or chunk.strip().endswith('#'):
                        break
                elif output:
                    # Got data before, now silence, so we're done
                    break

        output = output or ''
        with msf_lock:
            if str(sid) in msf_sessions:
                msf_sessions[str(sid)]['log'].append({
                    'cmd': cmd, 'output': output,
                    'ts': datetime.now().strftime('%H:%M:%S')
                })
        return jsonify({'output': output})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/api/msf/sessions/<sid>/read', methods=['GET'])
def session_read(sid):
    """Poll for unsolicited output (banner, prompt, etc.) without sending a command."""
    msf = get_msf()
    if not msf:
        return jsonify({'output': ''})
    try:
        session = msf.sessions.session(str(sid))
        output = session.read() or ''
        return jsonify({'output': output})
    except Exception as e:
        return jsonify({'output': '', 'error': str(e)})


@bp.route('/api/msf/sessions/<sid>/kill', methods=['POST'])
def session_kill(sid):
    msf = get_msf()
    if msf:
        try:
            msf.sessions.session(sid).stop()
        except Exception:
            pass
    with msf_lock:
        msf_sessions.pop(sid, None)
    return jsonify({'ok': True})
