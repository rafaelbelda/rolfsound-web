#!/usr/bin/env python3
# main.py
"""
rolfsound-control entry point.
"""

import logging
import sys
from logging.handlers import RotatingFileHandler

import uvicorn

from utils.config import load as load_config, get


def setup_logging() -> None:
    root = logging.getLogger()
    if root.handlers:
        return
    
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    
    root.setLevel(logging.DEBUG)
    fmt = logging.Formatter(
        "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    log_file_level = get("log_file_level", logging.INFO)

    fh = RotatingFileHandler(
        "control.log", maxBytes=5 * 1024 * 1024, backupCount=2, encoding="utf-8"
    )
    fh.setLevel(log_file_level)
    fh.setFormatter(fmt)

    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter("%(levelname)-8s | %(name)s | %(message)s"))

    root.addHandler(fh)
    root.addHandler(ch)


def main() -> None:
    setup_logging()
    logger = logging.getLogger("main")

    load_config()
    port = get("server_port", 8766)

    logger.info(f"Starting rolfsound-control on port {port}")

    from api.app import create_app
    app = create_app()

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        log_level="info",
        access_log=False
    )

if __name__ == "__main__":
    main()