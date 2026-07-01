"""nmap argument validation, result merging, and the scan worker thread.

User-supplied nmap flags are never passed through verbatim. sanitize_args()
allow-lists each token against ALLOWED_ARG_PATTERN, and resolve_conflicts() drops
mutually exclusive flags. run_scan() runs in a background thread, persisting
discovered hosts through the merge logic so a narrow follow-up scan never clobbers
data a broader scan already gathered.
"""
import json
import re
import shlex
from datetime import datetime

import nmap

from ..database import Session
from ..models import Host
from ..state import active_jobs, jobs_lock

# nmap argument validation
ALLOWED_ARG_PATTERN = re.compile(
    r'^('
    r'-s[STAWMNFXUYOn]|'
    r'-Pn|-sn|-n|--traceroute|-PS\S*|-PA\S*|-PU\S*|-PE|-PP|-PM|'
    r'-p\s+[\w,\-:]+|--top-ports\s+\d+|-F|-r|'
    r'-sV|-O|--osscan-guess|--version-intensity\s+\d+|'
    r'-sC|--script\s+[\w,\-]+|--script-args\s+\S+|--script-trace|'
    r'-T[0-5]|--min-rate\s+\d+|--max-retries\s+\d+|--host-timeout\s+\S+|'
    r'-f|-D\s+\S+|-S\s+[\d.]+|-g\s+\d+|'
    r'-A|-6|--reason|--packet-trace|--data-string\s+\S+|'
    r'--exclude\s+[\w.,/]+|-iR\s+\d+'
    r')$'
)

# Flags that consume a following value token (e.g. "-p 80").
_TWO_PART_FLAGS = {'-p', '--top-ports', '--version-intensity', '--min-rate', '--max-retries',
                   '--host-timeout', '-D', '-S', '-g', '--exclude', '-iR', '--script',
                   '--script-args', '--data-string'}


def sanitize_args(raw_args):
    """Allow-list nmap arguments token by token.

    Returns `(safe_args_string, warnings)`. Anything not matching the allow-list
    is dropped and reported in `warnings` rather than executed.
    """
    if not raw_args or not raw_args.strip():
        return '', []
    warnings, safe_parts = [], []
    try:
        tokens = shlex.split(raw_args)
    except ValueError as e:
        return '', [f'Could not parse arguments: {e}']
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok in _TWO_PART_FLAGS and i + 1 < len(tokens):
            combined = f'{tok} {tokens[i+1]}'
            (safe_parts if ALLOWED_ARG_PATTERN.match(combined) else warnings).append(
                combined if ALLOWED_ARG_PATTERN.match(combined) else f'Skipped: {combined}')
            i += 2
        else:
            (safe_parts if ALLOWED_ARG_PATTERN.match(tok) else warnings).append(
                tok if ALLOWED_ARG_PATTERN.match(tok) else f'Skipped: {tok}')
            i += 1
    return ' '.join(safe_parts), warnings


def resolve_conflicts(args_str):
    """Drop flags that conflict with a higher-level scan mode already requested."""
    args = args_str.split()
    if '-sn' in args:
        for c in ['-sV', '-O', '--osscan-guess', '-sS', '-sT', '-sA', '-sW', '-sM', '-sN', '-sF', '-sX', '-sU', '-sY', '-A']:
            if c in args:
                args.remove(c)
    if '-A' in args:
        for c in ['-sV', '-O', '-sC', '--traceroute']:
            if c in args:
                args.remove(c)
    return ' '.join(args)


# nmap scan result merging
def ports_to_lines(ports_list):
    """Render a structured ports list back to the human-readable open_ports text."""
    lines = []
    for p in ports_list:
        svc    = p.get('service', 'unknown')
        detail = f"{p.get('product', '')} {p.get('version', '')}".strip()
        lines.append(f"{p.get('port')}/{p.get('proto')}: {svc}" + (f' ({detail})' if detail else ''))
    return lines


def merge_ports(old_json, new_list):
    """Merge freshly scanned ports into the previously stored set without losing
    earlier (possibly broader/more aggressive) scan data. Fresh results win
    field-by-field, but: a narrow scan that never touched a port won't delete it,
    and a detail-less re-scan won't blank out a product/version we already had."""
    try:
        old_list = json.loads(old_json or '[]')
    except (ValueError, TypeError):
        old_list = []

    merged = {}
    for p in old_list:
        merged[(p.get('proto'), p.get('port'))] = dict(p)

    for p in new_list:
        key = (p.get('proto'), p.get('port'))
        if key in merged:
            cur = merged[key]
            svc = p.get('service')
            if svc and svc != 'unknown':
                cur['service'] = svc
            if p.get('product'):
                cur['product'] = p['product']
            if p.get('version'):
                cur['version'] = p['version']
        else:
            merged[key] = dict(p)

    return sorted(merged.values(),
                  key=lambda x: (str(x.get('proto')), int(x.get('port') or 0)))


# nmap scan worker
def run_scan(target, custom_args, job_id):
    """Background worker: scan `target` and persist discovered hosts.

    Tracks progress on `active_jobs[job_id]` so the UI can poll status.
    """
    nm = nmap.PortScanner()
    try:
        safe_args, warnings = sanitize_args(custom_args)
        if not safe_args:
            safe_args = '-sV --version-light -F -T3'
        safe_args = resolve_conflicts(safe_args)
        with jobs_lock:
            active_jobs[job_id]['args_used'] = safe_args
            if warnings:
                active_jobs[job_id]['warnings'] = warnings

        nm.scan(hosts=target, arguments=safe_args)

        db = Session()
        try:
            now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            for host in nm.all_hosts():
                if nm[host].state() != 'up':
                    continue
                mac      = nm[host]['addresses'].get('mac', 'Unknown')
                hostname = nm[host].hostname()
                ports_data, ports_list = [], []
                for proto in nm[host].all_protocols():
                    for port in sorted(nm[host][proto].keys()):
                        pi = nm[host][proto][port]
                        svc     = pi.get('name', 'unknown')
                        product = pi.get('product', '')
                        version = pi.get('version', '')
                        detail  = f'{product} {version}'.strip()
                        line    = f'{port}/{proto}: {svc}' + (f' ({detail})' if detail else '')
                        ports_data.append(line)
                        ports_list.append({'port': port, 'proto': proto, 'service': svc,
                                           'product': product, 'version': version})
                os_guess = 'Unknown'
                if nm[host].get('osmatch'):
                    b = nm[host]['osmatch'][0]
                    os_guess = f"{b.get('name','?')} ({b.get('accuracy','?')}%)"
                existing = db.query(Host).filter_by(ip_address=host).first()
                if existing:
                    # Merge, don't clobber: a narrow follow-up scan (e.g. one port,
                    # no -O/-sV) must not wipe out OS/port/version data a broader
                    # manual scan already gathered.
                    merged = merge_ports(existing.ports_json, ports_list)
                    existing.ports_json = json.dumps(merged)
                    existing.open_ports = '\n'.join(ports_to_lines(merged))
                    if mac and mac != 'Unknown':
                        existing.mac_address = mac
                    if hostname:
                        existing.hostname = hostname
                    if os_guess != 'Unknown':
                        existing.os_guess = os_guess
                    existing.status = 'up'
                    existing.last_seen = now
                else:
                    db.add(Host(ip_address=host, mac_address=mac, hostname=hostname,
                                os_guess=os_guess, open_ports='\n'.join(ports_data),
                                ports_json=json.dumps(ports_list), status='up', last_seen=now))
            db.commit()
        finally:
            db.close()

        up = [h for h in nm.all_hosts() if nm[h].state() == 'up']
        with jobs_lock:
            active_jobs[job_id].update(status='Completed',
                finished_at=datetime.now().strftime('%H:%M:%S'), hosts_found=len(up))
    except Exception as e:
        with jobs_lock:
            active_jobs[job_id].update(status='Failed', error=str(e))
        print(f'[scan error] {job_id}: {e}')
