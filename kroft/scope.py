"""Engagement scope guardrail.

Before Kroft dispatches anything intrusive (an MSF scan or exploit) against a
single host, the target is checked against the operator-configured scope CIDR(s)
stored in settings. This is a safety net to keep activity inside the authorized
engagement boundary.
"""
import ipaddress
import re

from .settings_store import get_setting


def in_scope(ip):
    """True if `ip` is within the configured scope CIDR(s).

    An empty scope allows everything. Unparseable targets (ranges / hostnames)
    are allowed through; the guardrail only constrains single hosts.
    """
    cidrs = (get_setting('scope_cidr') or '').strip()
    if not cidrs:
        return True
    try:
        addr = ipaddress.ip_address(str(ip).split('/')[0].strip())
    except Exception:
        return True
    for c in re.split(r'[,\s]+', cidrs):
        c = c.strip()
        if not c:
            continue
        try:
            if addr in ipaddress.ip_network(c, strict=False):
                return True
        except Exception:
            if str(addr) == c:
                return True
    return False
