"""Process-wide, in-memory state shared between request handlers and the
background worker threads.

These registries are intentionally not persisted: they describe *live* activity
(scans in flight, exploit attempts, open sessions, interactive consoles) for the
current run of the server. Always mutate them while holding the matching lock.

⚠️  SINGLE PROCESS ONLY. Because this state lives in module-level dicts, the app
must run as ONE process. Threads are fine (and used heavily), but multiple
worker *processes* (e.g. `gunicorn --workers 2`) each get their own copy of
these registries, so jobs/sessions would appear and vanish depending on which
worker served the request. Deploy with a single worker; scaling out would mean
moving this state into a shared store (e.g. Redis).
"""
import threading

# nmap scan jobs:                 { job_id: {id, target, status, ...} }
active_jobs = {}
# msf exploit / auxiliary / post jobs: { job_id: {id, target, module, status, ...} }
exploit_jobs = {}
# active shell / meterpreter sessions: { session_id: {id, type, target, log, ...} }
msf_sessions = {}

jobs_lock = threading.Lock()   # guards active_jobs
msf_lock = threading.Lock()    # guards exploit_jobs and msf_sessions

# Persistent interactive consoles for the in-browser MSF terminal:
#   { console_id: {'id': str, 'created_at': str} }
msf_consoles = {}
console_lock = threading.Lock()
