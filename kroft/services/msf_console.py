"""Safe wrappers around the msfrpcd console API.

Every console operation goes through these helpers. We avoid
`msf.consoles.console()`, whose ConsoleManager evaluates
`rpc.call('console.list')['consoles']` (and subscripts the result) on every call,
reconnects included, so a single bool/odd RPC response anywhere makes the whole
feature crash with "'bool' object is not subscriptable". Calling the RPC directly
lets us check the response shape and fail with a clear message instead.
"""


def console_create(msf):
    """Create a new MSF console; return its id or raise with a clear message."""
    created = msf.call('console.create')
    if not isinstance(created, dict) or 'id' not in created:
        raise RuntimeError(f'console.create returned unexpected response: {created!r}')
    return created['id']


def console_write(msf, cid, cmd):
    if not cmd.endswith('\n'):
        cmd += '\n'
    msf.call('console.write', [cid, cmd])


def console_read(msf, cid):
    """Read a console; always returns a dict with at least data/busy/prompt."""
    resp = msf.call('console.read', [cid])
    if isinstance(resp, dict):
        resp.setdefault('data', '')
        resp.setdefault('busy', False)
        resp.setdefault('prompt', 'msf6 > ')
        return resp
    return {'data': resp if isinstance(resp, str) else '', 'busy': False, 'prompt': 'msf6 > '}


def console_destroy(msf, cid):
    try:
        msf.call('console.destroy', [cid])
    except Exception:
        pass


def strip_msf_banner(text):
    """Remove the big Metasploit start-up banner (ASCII art + version block) that a
    freshly created console prints. It wastes tokens when fed to the AI and adds no
    signal. Everything up to and including the 'Metasploit Documentation' line is
    banner; we also drop the version summary lines if they appear on their own."""
    if not text:
        return text
    idx = text.rfind('Metasploit Documentation')
    if idx != -1:
        nl = text.find('\n', idx)
        text = text[nl + 1:] if nl != -1 else ''
    kept = [ln for ln in text.split('\n')
            if not ln.lstrip().startswith(('=[', '+ -- --=['))]
    return '\n'.join(kept).lstrip('\n')
