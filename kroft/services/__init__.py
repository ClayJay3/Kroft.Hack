"""Service layer behind the routes.

Each module here owns one external integration or long-running concern so the
HTTP routes can stay thin:

msf_client    connect to and keep alive the Metasploit RPC daemon.
msf_console   safe wrappers around the msfrpcd console API.
msf_modules   search / validate / suggest MSF modules and payloads.
msf_workers   background threads that run exploits and post modules.
nmap_scanner  nmap argument validation and the scan worker.
"""
