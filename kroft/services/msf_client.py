"""Metasploit RPC connection manager.

A single background thread establishes and continuously health-checks the
connection to `msfrpcd`. Routes and workers call get_msf() to grab a live client
right away (or `None` if msfrpcd is currently unreachable); they never block
waiting for a connection.
"""
import threading
import time

from .. import config

_client = None
_connected = False
_lock = threading.Lock()
_started = False


def _maintain_loop():
    """Background loop to establish and maintain the MSF RPC connection."""
    global _client, _connected

    # Delayed import to ensure the environment is fully loaded.
    from pymetasploit3.msfrpc import MsfRpcClient

    host, port, pwd = config.MSF_HOST, config.MSF_PORT, config.MSF_PASSWORD

    while True:
        with _lock:
            is_conn = _connected

        if not is_conn:
            try:
                print(f"[*] Attempting to connect to MSF RPC at {host}:{port}...")
                client = MsfRpcClient(pwd, server=host, port=port, ssl=False)
                with _lock:
                    _client = client
                    _connected = True
                print("[+] Successfully connected to MSF RPC!")
            except Exception as e:
                print(f"[-] MSF connection failed: {e}. Retrying in 10s...")
        else:
            # Verify the connection is still alive by requesting the version.
            try:
                with _lock:
                    if _client:
                        result = _client.core.version
                        if not isinstance(result, dict):
                            raise ValueError(f'core.version returned {result!r}')
            except Exception as e:
                print(f"[-] MSF connection lost ({e}). Reconnecting...")
                with _lock:
                    _client = None
                    _connected = False

        # Wait 10 seconds before polling/retrying again.
        time.sleep(10)


def start_connection_manager():
    """Start the background connection manager thread (idempotent)."""
    global _started
    with _lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_maintain_loop, daemon=True).start()


def get_msf():
    """Return a live `MsfRpcClient` or `None` instantly, without blocking."""
    with _lock:
        if _connected:
            return _client
    return None
