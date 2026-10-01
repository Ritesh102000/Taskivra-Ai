"""Deterministic, synthetic Phase 3 website. Never a production service."""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from email.parser import BytesParser
from email.policy import default as email_policy
from pathlib import Path
import socket
import ssl
import threading
from urllib.parse import parse_qs

ROOT = Path(__file__).resolve().parent


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def reply(self, body, status=200, headers=()):
        body = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        for key, value in headers:
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_GET(self):
        if self.path == "/reviewed-actions":
            return self.reply('''<!doctype html><title>Reviewed action fixture</title><h1>Reviewed changes</h1>
<label>Record title <input id="record" oninput="document.querySelector('#status').textContent='Entered: '+this.value"></label>
<label>Record state <select id="state" onchange="document.querySelector('#status').textContent='Selected: '+this.value"><option value="draft">Draft</option><option value="ready">Ready</option></select></label>
<button id="save" onclick="document.querySelector('#status').textContent='Saved: '+document.querySelector('#record').value+' / '+document.querySelector('#state').value">Save record</button>
<button onclick="setTimeout(()=>{document.querySelector('#save').textContent='Delete record'},1000)">Change target later</button>
<p id="status">No changes</p>''', headers=[("Content-Type", "text/html")])
        if self.path == "/download":
            return self.reply("phase3-download-fixture\n", headers=[("Content-Type", "text/plain"), ("Content-Disposition", 'attachment; filename="fixture-download.txt"')])
        if self.path == "/transfers":
            return self.reply('''<!doctype html><title>Transfers fixture</title><h1>File transfers</h1>
<form action="/upload" method="post" enctype="multipart/form-data"><label>Selected file <input type="file" name="document"></label><button>Submit upload</button></form>
<a href="/download">Download fixture</a><a href="/popup">Popup page</a>''', headers=[("Content-Type", "text/html")])
        if self.path == "/cross-origin-upload":
            return self.reply('''<!doctype html><title>Cross origin fixture</title><form action="/upload" method="post"><label>Selected file <input type="file" name="document"></label><button formaction="https://example.com/upload">Cross origin upload</button></form>''', headers=[("Content-Type", "text/html")])
        if self.path == "/popup":
            return self.reply('''<!doctype html><title>Popup fixture</title><h1>Popup fixture</h1><a href="/account" target="_blank" rel="opener">Open account popup</a>''', headers=[("Content-Type", "text/html")])
        if self.path == "/health":
            return self.reply("phase0-fixture-ok\n")
        if self.path == "/redirect-private":
            return self.reply("private redirect", 302, [("Location", "http://127.0.0.1/private")])
        if self.path == "/redirect-fixture":
            return self.reply("fixture redirect", 302, [("Location", "http://fixture.agent-workspaces.test:8080/health")])
        if self.path == "/subresource-private":
            return self.reply('<!doctype html><img src="http://127.0.0.1/private"><script>fetch("http://host.docker.internal/private").catch(()=>{});</script>', headers=[("Content-Type", "text/html")])
        if self.path == "/ws" and self.headers.get("Upgrade", "").lower() == "websocket":
            key = self.headers.get("Sec-WebSocket-Key", "")
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            self.connection.settimeout(5)
            first = self.rfile.read(2)
            if len(first) != 2 or not (first[1] & 128) or first[1] & 127 > 125:
                return
            mask = self.rfile.read(4)
            data = self.rfile.read(first[1] & 127)
            data = bytes(value ^ mask[i % 4] for i, value in enumerate(data))
            self.wfile.write(bytes([129, len(data)]) + data)
            self.wfile.flush()
            self.close_connection = True
            return
        if self.path.startswith("/account"):
            cookie = self.headers.get("Cookie", "")
            name = next((part.strip()[8:] for part in cookie.split(";") if part.strip().startswith("fixture=")), "signed out")
            return self.reply(f"<!doctype html><title>Fixture account</title><h1>Account: {name}</h1><a href='/'>Home</a>", headers=[("Content-Type", "text/html")])
        return self.reply("""<!doctype html><html><title>Agent Workspaces fixture</title><body>
<h1>Phase 0 login fixture</h1><p>Synthetic credentials only. No external service.</p>
<form action="/login" method="post"><label>User <input name="username" autocomplete="username"></label>
<label>Password <input name="password" type="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button></form><a href="/account">Account</a></body></html>""", headers=[("Content-Type", "text/html")])

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 4096:
            return self.reply("too large", 413)
        body = self.rfile.read(length)
        if self.path == "/upload":
            message = BytesParser(policy=email_policy).parsebytes(("Content-Type: " + self.headers.get("Content-Type", "") + "\r\n\r\n").encode() + body)
            parts = list(message.iter_parts()) if message.is_multipart() else []
            document = next((part.get_payload(decode=True) for part in parts if part.get_param("name", header="content-disposition") == "document"), None)
            if document is None:
                return self.reply("missing document", 400)
            digest = hashlib.sha256(document).hexdigest()
            return self.reply(f"<!doctype html><title>Upload fixture</title><h1>Received {len(document)} bytes</h1><p>SHA256: {digest}</p>", headers=[("Content-Type", "text/html")])
        values = parse_qs(body.decode())
        if self.path != "/login":
            return self.reply("unknown", 404)
        name = values.get("username", ["fixture-user"])[0]
        if not name.isalnum() or len(name) > 40:
            return self.reply("invalid synthetic username", 400)
        return self.reply("signed in", 303, [("Location", "/account"), ("Set-Cookie", f"fixture={name}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400")])


def udp_canary():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as server:
        server.bind(("0.0.0.0", 8081))
        while True:
            data, address = server.recvfrom(1024)
            server.sendto(b"fixture-udp:" + data, address)


if __name__ == "__main__":
    plain = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
    secure = ThreadingHTTPServer(("0.0.0.0", 8443), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(ROOT / "fixture-cert.pem", ROOT / "fixture-key.pem")
    secure.socket = context.wrap_socket(secure.socket, server_side=True)
    threading.Thread(target=plain.serve_forever, daemon=True).start()
    threading.Thread(target=udp_canary, daemon=True).start()
    print("test_fixture_ready", flush=True)
    secure.serve_forever()
