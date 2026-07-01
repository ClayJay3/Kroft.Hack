"""Entry point for the Kroft Security Matrix.

The application itself lives in the `kroft` package; this module just builds it
and runs the server. It's kept here so `python app.py` (and the Docker `CMD`)
keep working unchanged.

`app` is also the WSGI callable, so a production server can target it directly,
but it has to run as a single process (see the note in `kroft/state.py`):

    gunicorn --workers 1 --threads 8 app:app      # or: waitress-serve --threads=8 app:app

Debug mode is controlled by the KROFT_DEBUG env var (off by default); see
`kroft/config.py`.
"""
from kroft import create_app
from kroft.config import DEBUG, HOST, PORT

app = create_app()

if __name__ == '__main__':
    # Flask's built-in server. Fine for local use / single operator; for a real
    # deployment put a single-worker WSGI server in front (see module docstring).
    app.run(host=HOST, port=PORT, debug=DEBUG)
