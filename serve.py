#!/usr/bin/env python3
"""Serve Screen Recorder on http://localhost and open it in your browser.

Browsers only allow screen capture on secure pages, and http://localhost counts
as secure, so this server listens on localhost only.

Usage:
    python3 serve.py              # port 8000, or the next free one
    python3 serve.py --port 9000
    python3 serve.py --no-browser

On Windows, use "py serve.py" or "python serve.py". Requires Python 3.7+.
Stop the server with Ctrl+C.
"""

import argparse
import errno
import http.server
import os
import sys
import threading
import webbrowser

HOST = "127.0.0.1"
ROOT = os.path.dirname(os.path.abspath(__file__))

# Python's guess comes from the OS registry on Windows and can be wrong
# (for example text/plain for .js), which stops ES modules from loading.
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".md": "text/markdown; charset=utf-8",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".mp4": "video/mp4",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **MIME_TYPES}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Always serve fresh files, so an edited module is never mixed with a cached one.
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.server.quiet:
            super().log_message(fmt, *args)


def make_server(start_port, attempts=20):
    for port in range(start_port, start_port + attempts):
        try:
            server = http.server.ThreadingHTTPServer((HOST, port), Handler)
            return server, port
        except OSError as exc:
            if exc.errno in (errno.EADDRINUSE, getattr(errno, "WSAEADDRINUSE", -1), 10048):
                continue
            raise
    sys.exit(f"No free port between {start_port} and {start_port + attempts - 1}. Try --port.")


def main():
    parser = argparse.ArgumentParser(description="Serve Screen Recorder on localhost.")
    parser.add_argument("--port", type=int, default=8000, help="first port to try (default 8000)")
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    parser.add_argument("--quiet", action="store_true", help="don't log each request")
    args = parser.parse_args()

    if not os.path.isfile(os.path.join(ROOT, "index.html")):
        sys.exit("index.html not found next to serve.py. Run this from the screen-recorder folder.")

    server, port = make_server(args.port)
    server.quiet = args.quiet
    url = f"http://localhost:{port}/"
    print(f"Screen Recorder is running at {url}")
    print("Press Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
