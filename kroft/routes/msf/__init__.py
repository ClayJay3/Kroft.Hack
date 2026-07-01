"""Metasploit endpoints, grouped by concern.

All submodules register their routes on the single shared `bp` blueprint:

status     RPC status + db_nmap scan.
modules    search / suggest / validate / info for modules.
exploit    exploit & post/aux dispatch, job tracking, output, logs.
sessions   open shell / meterpreter session interaction.
console    one-shot command execution and the interactive console.
"""
from flask import Blueprint

bp = Blueprint('msf', __name__)

# Import submodules so their @bp.route handlers attach to the blueprint.
from . import status, modules, exploit, sessions, console  # noqa: E402,F401
