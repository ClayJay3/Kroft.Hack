"""Central configuration for the Kroft Security Matrix.

Every tunable value is read from the environment with a sensible default, so the
app runs out-of-the-box for local development and can be configured via
docker-compose / environment variables in production.
"""
import os

# Database
# SQLite by default. The path is relative to the working directory, which keeps
# the bundled `kroft_assets.db` next to the app exactly as before.
DB_PATH = os.environ.get('KROFT_DB', 'sqlite:///kroft_assets.db')

# Metasploit RPC (msfrpcd)
MSF_HOST     = os.environ.get('MSF_HOST', '127.0.0.1')
MSF_PORT     = int(os.environ.get('MSF_PORT', 55553))
MSF_PASSWORD = os.environ.get('MSF_PASSWORD', 'msfrpc')

# Ollama (Kroft.AI's LLM backend)
# The browser talks to Ollama directly; the server only uses this to list the
# models that are available, so the UI can offer them in a dropdown.
#
# Default is empty: the endpoint is configured at runtime from the Settings page
# (persisted in the DB key/value store) and overrides this. The env var only acts
# as a deployment-time fallback when nothing has been set in the UI yet.
OLLAMA_BASE = os.environ.get('OLLAMA_BASE', '')

# Web server
HOST = os.environ.get('KROFT_HOST', '0.0.0.0')
PORT = int(os.environ.get('KROFT_PORT', 5000))
# Debug is OFF by default (production-safe). Set KROFT_DEBUG=1 for the local dev
# reloader + interactive debugger. NEVER enable it in production: Werkzeug's
# debugger exposes an arbitrary-code-execution console, and the reloader would
# start a second MSF connection thread.
DEBUG = os.environ.get('KROFT_DEBUG', '0') not in ('0', 'false', 'False', '')
