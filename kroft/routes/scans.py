"""nmap scan dispatch and job status endpoints."""
import re
import threading
import uuid
from datetime import datetime

from flask import Blueprint, jsonify, request

from ..services.nmap_scanner import run_scan
from ..state import active_jobs, jobs_lock

bp = Blueprint('scans', __name__)


@bp.route('/api/jobs', methods=['GET'])
def get_jobs():
    with jobs_lock:
        jobs_list = sorted(active_jobs.values(), key=lambda j: j.get('started_at', ''), reverse=True)
    return jsonify(jobs_list)


@bp.route('/api/scan', methods=['POST'])
def start_scan():
    data = request.get_json(silent=True) or {}
    target = (data.get('target') or '').strip()
    custom_args = (data.get('custom_args') or '').strip()
    if not target:
        return jsonify({'error': 'No target specified'}), 400
    if not re.match(r'^[\w.\-/,: ]+$', target):
        return jsonify({'error': 'Invalid target format'}), 400
    job_id = str(uuid.uuid4())
    with jobs_lock:
        active_jobs[job_id] = {
            'id': job_id, 'target': target, 'status': 'Running',
            'started_at': datetime.now().strftime('%H:%M:%S'),
            'finished_at': None, 'hosts_found': None,
            'args_used': None, 'warnings': [], 'error': None,
        }
    threading.Thread(target=run_scan, args=(target, custom_args, job_id), daemon=True).start()
    return jsonify({'message': f'Scan initiated for {target}', 'job_id': job_id})
