"""CVE enrichment via the NVD API.

Best-effort lookups (offline-safe) with a simple in-memory cache so repeated
queries for the same service string don't re-hit the NVD API.
"""
import json
import urllib.parse
import urllib.request

from flask import Blueprint, jsonify, request

bp = Blueprint('cve', __name__)

_cve_cache = {}


@bp.route('/api/cve', methods=['GET'])
def cve_lookup():
    """Look up known CVEs for a service string (product + version) via the NVD API.
    Best-effort: returns [] if the lookup fails or there's no internet."""
    q = request.args.get('q', '').strip()
    if not q or len(q) < 3:
        return jsonify({'cves': []})
    if q in _cve_cache:
        return jsonify({'cves': _cve_cache[q], 'cached': True})
    try:
        url = ('https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=10&keywordSearch='
               + urllib.parse.quote(q))
        req = urllib.request.Request(url, headers={'User-Agent': 'Kroft-Scanner'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            payload = json.loads(resp.read().decode())
        out = []
        for item in payload.get('vulnerabilities', [])[:10]:
            c = item.get('cve', {})
            cid = c.get('id', '')
            desc = ''
            for d in c.get('descriptions', []):
                if d.get('lang') == 'en':
                    desc = d.get('value', ''); break
            score = None
            metrics = c.get('metrics', {})
            for mk in ('cvssMetricV31', 'cvssMetricV30', 'cvssMetricV2'):
                if metrics.get(mk):
                    score = metrics[mk][0].get('cvssData', {}).get('baseScore'); break
            out.append({'id': cid, 'score': score, 'summary': desc[:300]})
        out.sort(key=lambda x: (x['score'] or 0), reverse=True)
        _cve_cache[q] = out
        return jsonify({'cves': out})
    except Exception as e:
        return jsonify({'cves': [], 'error': str(e)})
