"""One-shot command execution and the persistent interactive MSF console.

`/api/msf/console_exec` runs a batch of commands on a throwaway console and
returns the banner-stripped, truncated output. Kroft.AI's clickable command
blocks use it. The `/api/msf/console/*` routes back the in-browser xterm terminal
with a long-lived console.
"""
import re
import time
from datetime import datetime

from flask import jsonify, request

from ...services.msf_client import get_msf
from ...services.msf_console import (console_create, console_destroy,
                                     console_read, console_write,
                                     strip_msf_banner)
from ...state import console_lock, msf_consoles
from . import bp


@bp.route('/api/msf/console_exec', methods=['POST'])
def msf_console_exec():
    """Execute arbitrary MSF console commands (use/set/run/sessions -l etc.)
    and return the captured output. Used by Kroft.AI clickable command blocks."""
    data = request.get_json(silent=True) or {}
    commands = data.get('commands', [])   # list of command strings
    if not commands:
        return jsonify({'error': 'No commands provided'}), 400
    msf = get_msf()
    if not msf:
        return jsonify({'error': 'MSF not connected'}), 503
    try:
        cid = console_create(msf)

        # Send all commands; strip full-line and inline comments before sending
        sent = []
        for cmd in commands:
            stripped = cmd.strip()
            if not stripped or stripped.startswith('#'):
                continue  # skip blank lines and full-line comments
            # Strip inline comments (e.g. "run # does X" -> "run")
            clean = re.split(r'\s+#\s+', stripped)[0].strip()
            if clean:
                console_write(msf, cid, clean)
                sent.append(clean)
                time.sleep(0.25)

        # Poll for output, up to 90 s, stopping after 6 consecutive empty reads
        combined = ''
        deadline = time.time() + 90
        idle = 0
        while time.time() < deadline:
            time.sleep(1.0)
            chunk = console_read(msf, cid).get('data', '')
            if chunk:
                combined += chunk
                idle = 0
            else:
                idle += 1
                if idle >= 6 and combined:
                    break
        console_destroy(msf, cid)

        # Strip the startup banner before anything else sees the output.
        combined = strip_msf_banner(combined)

        # Truncate very long output (e.g. local_exploit_suggester with 2400 modules):
        # dumping it all into the AI context is useless. Keep head + tail + a summary line.
        MAX_CHARS = 4000
        truncated = False
        display_output = combined
        if len(combined) > MAX_CHARS:
            truncated = True
            head = combined[:2000]
            tail = combined[-1500:]
            total_lines = combined.count('\n')
            display_output = (
                head +
                f'\n\n[... {total_lines} lines / {len(combined)} chars, middle truncated for AI context ...]\n\n' +
                tail
            )

        return jsonify({
            'output': display_output,
            'full_length': len(combined),
            'truncated': truncated,
            'commands_sent': sent,
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/api/msf/console/create', methods=['POST'])
def msf_console_create():
    """Create (or reuse) a persistent MSF console for the interactive terminal."""
    msf = get_msf()
    if not msf:
        return jsonify({'error': 'MSF not connected'}), 503
    try:
        cid = str(console_create(msf))
        with console_lock:
            msf_consoles[cid] = {
                'id': cid,
                'created_at': datetime.now().strftime('%H:%M:%S'),
            }
        # Drain the initial banner
        time.sleep(0.5)
        banner = ''
        try:
            banner = console_read(msf, cid).get('data', '')
        except Exception:
            pass
        return jsonify({'console_id': cid, 'banner': banner})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/api/msf/console/<cid>/write', methods=['POST'])
def msf_console_write(cid):
    """Send a line of input to the persistent MSF console."""
    msf = get_msf()
    if not msf:
        return jsonify({'error': 'MSF not connected'}), 503
    data = request.get_json(silent=True) or {}
    cmd  = data.get('input', '')
    try:
        console_write(msf, cid, cmd)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/api/msf/console/<cid>/read', methods=['GET'])
def msf_console_read(cid):
    """Poll the persistent MSF console for pending output."""
    msf = get_msf()
    if not msf:
        return jsonify({'data': '', 'busy': False})
    try:
        resp = console_read(msf, cid)
        return jsonify({'data': resp.get('data', ''),
                        'busy': resp.get('busy', False),
                        'prompt': resp.get('prompt', 'msf6 > ')})
    except Exception as e:
        return jsonify({'data': '', 'busy': False, 'error': str(e)})


@bp.route('/api/msf/console/<cid>/destroy', methods=['POST'])
def msf_console_destroy(cid):
    """Destroy a persistent MSF console."""
    msf = get_msf()
    if msf:
        console_destroy(msf, cid)
    with console_lock:
        msf_consoles.pop(cid, None)
    return jsonify({'ok': True})
