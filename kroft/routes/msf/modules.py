"""Module discovery endpoints: search, suggest, validate, and info."""
from flask import jsonify, request

from ...services.msf_client import get_msf
from ...services.msf_modules import (compatible_payloads, search_modules,
                                     suggest_modules, validate_module)
from . import bp


@bp.route('/api/msf/modules/search', methods=['GET'])
def msf_search():
    q = request.args.get('q', '').strip()
    mtype = request.args.get('type', 'exploit')
    if not q:
        return jsonify([])
    msf = get_msf()
    if not msf:
        return jsonify({'error': 'MSF not connected'}), 503
    return jsonify(search_modules(msf, q, mtype, limit=60))


@bp.route('/api/msf/modules/suggest', methods=['POST'])
def msf_suggest():
    """Given recon keywords (service names, products, ports), return a deduped
    list of REAL, verified MSF modules. The AI uses this to ground its plan in
    modules that actually exist instead of guessing names."""
    data = request.get_json(silent=True) or {}
    keywords = data.get('keywords') or []
    mtype = data.get('type')  # optional type filter; None = all types
    if isinstance(keywords, str):
        keywords = [keywords]
    msf = get_msf()
    if not msf:
        return jsonify({'error': 'MSF not connected'}), 503
    seen, out = set(), []
    for kw in [str(k).strip() for k in keywords if str(k).strip()][:20]:
        for hit in search_modules(msf, kw, mtype, limit=30):
            if hit['fullname'] in seen:
                continue
            seen.add(hit['fullname'])
            out.append(hit)
    # Exploits first, then by rank desc-ish, capped for prompt size
    rank_order = {'excellent': 0, 'great': 1, 'good': 2, 'normal': 3,
                  'average': 4, 'low': 5, 'manual': 6, '': 7}
    out.sort(key=lambda h: (0 if h['type'] == 'exploit' else 1,
                            rank_order.get(str(h.get('rank', '')).lower(), 7)))
    return jsonify(out[:160])


@bp.route('/api/msf/modules/validate', methods=['GET'])
def msf_validate():
    """Quick existence/loadability check for a module, with search-based
    suggestions when it's invalid. Lets the UI confirm a module before dispatch."""
    module_path = request.args.get('module', '').strip()
    mtype = request.args.get('type', 'exploit')
    if not module_path:
        return jsonify({'error': 'No module'}), 400
    msf = get_msf()
    if not msf:
        return jsonify({'error': 'MSF not connected'}), 503
    # Normalize a leading type prefix (e.g. 'exploit/windows/...').
    name = module_path
    if name.lower().startswith(mtype.lower() + '/'):
        name = name.split('/', 1)[1]
    ok, detail = validate_module(msf, mtype, name)
    resp = {'valid': ok, 'module': module_path, 'detail': detail}
    if not ok:
        resp['suggestions'] = suggest_modules(msf, module_path, mtype, limit=10)
    return jsonify(resp)


@bp.route('/api/msf/modules/info', methods=['GET'])
def msf_module_info():
    module_path = request.args.get('module', '')
    mtype = request.args.get('type', 'exploit')
    if not module_path:
        return jsonify({'error': 'No module'}), 400
    msf = get_msf()
    if not msf:
        return jsonify({'error': 'MSF not connected'}), 503
    # Accept names with or without the leading type prefix.
    if module_path.lower().startswith(mtype.lower() + '/'):
        module_path = module_path.split('/', 1)[1]
    # Validate before modules.use(); an invalid name otherwise crashes the
    # library with "'bool' object is not subscriptable".
    ok, detail = validate_module(msf, mtype, module_path)
    if not ok:
        return jsonify({'error': f'Module could not be loaded: {detail}',
                        'suggestions': suggest_modules(msf, module_path, mtype, limit=10)}), 404
    try:
        mod = msf.modules.use(mtype, module_path)
        options = {}
        for opt in mod.options:
            info = mod.optioninfo(opt)
            if not isinstance(info, dict):
                info = {}
            options[opt] = {
                'required': info.get('required', False),
                'default': info.get('default', ''),
                'description': info.get('desc', ''),
                'type': info.get('type', 'string'),
            }
        payloads = compatible_payloads(msf, module_path, getattr(mod, 'target', 0)) if mtype == 'exploit' else []
        return jsonify({
            'name': mod.name, 'description': mod.description,
            'rank': getattr(mod, 'rank', 'normal'),
            'options': options,
            'payloads': payloads[:30],
            'references': getattr(mod, 'references', [])
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500
