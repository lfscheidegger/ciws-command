#!/usr/bin/env python3
"""Tiny static dev server that disables caching.

The default `python -m http.server` lets the browser cache ES modules, which can
serve a stale entry module after edits. This sends no-store on every response so
the preview always reflects the files on disk.
"""
import http.server
import os
import socketserver
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8011
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", port), NoCacheHandler) as httpd:
        print(f"Serving {os.getcwd()} on http://localhost:{port} (no-cache)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
