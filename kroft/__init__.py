"""Kroft Security Matrix, the Flask application package.

A guided network reconnaissance and exploitation console: nmap-driven asset
discovery, a thin orchestration layer over the Metasploit RPC daemon, loot/CVE
tracking, and an in-browser AI advisor (Kroft.AI).

create_app() builds the configured Flask application.
"""
import os

from flask import Flask


def create_app():
    """Application factory: build, configure, and wire up the Flask app."""
    # Templates and static assets live at the project root (project_root/templates
    # and project_root/static), one level up from this package, so the existing
    # single-page UI renders unchanged.
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    app = Flask(
        __name__,
        template_folder=os.path.join(root_dir, 'templates'),
        static_folder=os.path.join(root_dir, 'static'),
        static_url_path='/static',
    )

    # Create tables / run migrations.
    from .database import init_db
    init_db()

    # Start the background Metasploit RPC connection manager.
    from .services.msf_client import start_connection_manager
    start_connection_manager()

    # Register all HTTP routes.
    from .routes import register_blueprints
    register_blueprints(app)

    # Record interesting activity for the Cyberspace visualizer's event feed.
    from .activity import register_activity_feed
    register_activity_feed(app)

    return app
