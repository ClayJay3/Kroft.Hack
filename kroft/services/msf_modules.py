"""Helpers for discovering, validating and describing Metasploit modules.

These all talk to the live module database over RPC and check the shape of every
response. msfrpcd (and pymetasploit3) sometimes return a bare bool where a
dict/list is expected, which would otherwise crash callers with "'bool' object is
not subscriptable". Guarding here keeps the routes simple.
"""


def compatible_payloads(msf, module_path, target=0):
    """Compatible payloads for an exploit/target as a list, or [] on any odd
    response. Goes straight to the RPC and checks the shape, because
    pymetasploit3's ExploitModule.targetpayloads() just does
    rpc.call(...)['payloads'], and some msfrpcd builds return a bare bool there,
    which raises "'bool' object is not subscriptable"."""
    try:
        resp = msf.call('module.target_compatible_payloads', [module_path, target])
        if isinstance(resp, dict) and isinstance(resp.get('payloads'), list):
            return resp['payloads']
    except Exception:
        pass
    return []


def validate_module(msf, mtype, module_path):
    """Check a module can be loaded before handing its name to pymetasploit3's
    modules.use(). For an unknown/invalid module, msfrpcd returns an error dict
    like {'error': True, ...}, and modules.use() then iterates it as if it were
    the options map -> True['required'] -> "'bool' object is not subscriptable".
    Returns (ok: bool, detail: str)."""
    try:
        opts = msf.call('module.options', [mtype, module_path])
    except Exception as e:
        return False, f'could not query module ({e})'
    if not isinstance(opts, dict):
        return False, f'msfrpcd returned {opts!r}'
    if opts.get('error'):
        return False, opts.get('error_message') or opts.get('error_class') or 'module not found'
    # A real options map has a descriptor dict for every option.
    if opts and not all(isinstance(v, dict) for v in opts.values()):
        return False, 'unexpected module.options response'
    return True, ''


def _normalize_search_hit(m):
    """Normalize one module.search result dict to a stable, AI-friendly shape."""
    if not isinstance(m, dict):
        return None
    fullname = (m.get('fullname') or m.get('name') or '').strip()
    if not fullname:
        return None
    return {
        'fullname': fullname,
        'type': m.get('type') or fullname.split('/', 1)[0],
        'rank': m.get('rank', ''),
        'disclosure_date': m.get('disclosure_date') or m.get('disclosuredate') or '',
        'description': (m.get('description') or m.get('name') or '').strip()[:300],
    }


def search_modules(msf, query, mtype=None, limit=60):
    """Search the live MSF module DB and return a normalized, deduped list.
    Guards the RPC response so a non-list never propagates a crash upward.
    mtype: restrict to a type prefix ('exploit', 'auxiliary', 'post', ...);
    None or 'any'/'all' returns every type."""
    try:
        results = msf.modules.search(query)
    except Exception:
        return []
    if not isinstance(results, list):
        return []
    out, seen = [], set()
    want = None if mtype in (None, 'any', 'all') else mtype
    for m in results:
        hit = _normalize_search_hit(m)
        if not hit or hit['fullname'] in seen:
            continue
        if want and not hit['fullname'].startswith(want):
            continue
        seen.add(hit['fullname'])
        out.append(hit)
        if len(out) >= limit:
            break
    return out


def suggest_modules(msf, module_path, mtype, limit=8):
    """Best-effort 'did you mean' suggestions for a bad/unknown module path.
    Searches the live module DB with progressively broader queries derived from
    the name, most-specific first, so even a wrong name yields real alternatives."""
    parts = [p for p in module_path.split('/') if p]
    tail = parts[-1] if parts else module_path
    queries = []
    if len(tail) >= 3:
        queries.append(tail)                                  # whole tail, e.g. 'webdav_upload'
    queries += sorted({w for w in tail.split('_') if len(w) >= 3}, key=len, reverse=True)
    queries += [p for p in reversed(parts[:-1]) if len(p) >= 3]  # broader path parts
    out, seen, tried = [], set(), set()
    for q in queries:
        if q in tried:
            continue
        tried.add(q)
        for hit in search_modules(msf, q, mtype, limit=limit):
            if hit['fullname'] not in seen:
                seen.add(hit['fullname'])
                out.append(hit)
        if len(out) >= limit:
            break
    return out[:limit]
