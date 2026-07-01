"""HTTP layer: thin Flask blueprints, one per domain.

Each blueprint owns a slice of the API and hands heavy work off to the service
layer. register_blueprints() attaches them all to the application.
"""


def register_blueprints(app):
    from .main import bp as main_bp
    from .hosts import bp as hosts_bp
    from .scans import bp as scans_bp
    from .settings import bp as settings_bp
    from .loot import bp as loot_bp
    from .reports import bp as reports_bp
    from .cve import bp as cve_bp
    from .ollama import bp as ollama_bp
    from .events import bp as events_bp
    from .msf import bp as msf_bp

    for bp in (main_bp, hosts_bp, scans_bp, settings_bp, loot_bp,
               reports_bp, cve_bp, ollama_bp, events_bp, msf_bp):
        app.register_blueprint(bp)
