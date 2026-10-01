"""Bounded Phase 0 forward proxy. The Docker network is also required.

No TLS interception, credentials, payload logging, management API, or policy
mutation endpoint. CONNECT is restricted to TLS on 443. Tests have one explicit
fixture-only host/IP mapping; the production default has no private exception.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import select
import socket
import socketserver
import threading
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

HEADER_LIMIT = 32 * 1024
BODY_LIMIT = 100 * 1024 * 1024
TRANSFER_LIMIT = 128 * 1024 * 1024
CONNECT_TIMEOUT = 8
IDLE_TIMEOUT = 20
SESSION_TIMEOUT = 300
FIXTURE_HOST = "fixture.agent-workspaces.test"
TOKEN = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
HOST_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
BLOCKED_NAMES = {"localhost", "host.docker.internal", "gateway.docker.internal", "metadata.google.internal"}
TRANSITION_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "64:ff9b::/96", "64:ff9b:1::/48", "2002::/16", "2001::/32", "::ffff:0:0/96",
))


class Denied(ValueError):
    pass


def normalize_host(value: str) -> str:
    if not value or any(ord(c) < 33 or ord(c) == 127 for c in value) or any(c in value for c in "\\%/@?#"):
        raise Denied("invalid destination host")
    host = value.rstrip(".").lower()
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise Denied("invalid destination host") from exc
    if len(host) > 253 or not all(HOST_LABEL.fullmatch(label) for label in host.split(".")):
        raise Denied("invalid destination host")
    return host


def public_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if not address.is_global or address.is_multicast or address.is_reserved or address.is_loopback or address.is_link_local:
        return False
    if address.version == 6 and any(address in network for network in TRANSITION_NETWORKS):
        return False
    # Keep classifications fail-closed even on Python versions with older IANA data.
    if address.version == 4 and address in ipaddress.ip_network("192.0.0.0/24"):
        return False
    return True


@dataclass(frozen=True)
class Endpoint:
    family: int
    address: str
    port: int

    @property
    def sockaddr(self):
        return (self.address, self.port, 0, 0) if self.family == socket.AF_INET6 else (self.address, self.port)


class Policy:
    def __init__(self, fixture_ip: str | None = None, resolver=None):
        self.resolver = resolver or socket.getaddrinfo
        self.fixture_ip = str(ipaddress.ip_address(fixture_ip)) if fixture_ip else None
        if self.fixture_ip and ipaddress.ip_address(self.fixture_ip).version != 4:
            raise ValueError("test fixture requires an exact IPv4 container address")

    @classmethod
    def from_environment(cls):
        enabled = os.environ.get("EGRESS_TEST_ONLY") == "1"
        fixture_ip = os.environ.get("EGRESS_TEST_FIXTURE_IP")
        if fixture_ip and not enabled:
            raise ValueError("fixture IP requires explicit EGRESS_TEST_ONLY=1")
        if enabled and not fixture_ip:
            raise ValueError("test-only mode requires exact fixture IP")
        return cls(fixture_ip=fixture_ip if enabled else None)

    def resolve(self, host: str, port: int, tunnel: bool = False) -> list[Endpoint]:
        host = normalize_host(host)
        if self.fixture_ip and host == FIXTURE_HOST and port == (8443 if tunnel else 8080):
            return [Endpoint(socket.AF_INET, self.fixture_ip, port)]
        if port != (443 if tunnel else 80):
            raise Denied("destination port is outside initial web policy")
        if host in BLOCKED_NAMES or host.endswith((".localhost", ".local", ".internal", ".test")):
            raise Denied("local or service destination is denied")
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            try:
                answers = self.resolver(host, port, type=socket.SOCK_STREAM)
            except OSError as exc:
                raise Denied("destination could not be resolved") from exc
        else:
            answers = [(socket.AF_INET6 if literal.version == 6 else socket.AF_INET, socket.SOCK_STREAM, 0, "", (str(literal), port))]
        endpoints = []
        for family, socktype, _proto, _name, sockaddr in answers:
            if family not in (socket.AF_INET, socket.AF_INET6) or socktype != socket.SOCK_STREAM or not public_address(sockaddr[0]):
                raise Denied("destination resolution includes a non-public address")
            endpoint = Endpoint(family, sockaddr[0], port)
            if endpoint not in endpoints:
                endpoints.append(endpoint)
        if not endpoints or len(endpoints) > 32:
            raise Denied("invalid destination resolution")
        return endpoints


def connect_pinned(endpoints: list[Endpoint]):
    """Never pass a hostname to connect: policy's already-checked IP is pinned."""
    last_error = None
    for endpoint in endpoints[:4]:
        connection = socket.socket(endpoint.family, socket.SOCK_STREAM)
        connection.settimeout(CONNECT_TIMEOUT)
        try:
            connection.connect(endpoint.sockaddr)
            return connection
        except OSError as exc:
            last_error = exc
            connection.close()
    raise OSError("permitted destination connection failed") from last_error


def read_head(connection: socket.socket) -> tuple[bytes, bytes]:
    head = bytearray()
    deadline = time.monotonic() + IDLE_TIMEOUT
    while b"\r\n\r\n" not in head:
        if len(head) >= HEADER_LIMIT or time.monotonic() > deadline:
            raise Denied("request headers exceed limits")
        chunk = connection.recv(min(4096, HEADER_LIMIT - len(head)))
        if not chunk:
            raise Denied("incomplete request headers")
        head.extend(chunk)
    raw, remaining = bytes(head).split(b"\r\n\r\n", 1)
    return raw, remaining


def parse_request(raw: bytes):
    try:
        lines = raw.decode("iso-8859-1").split("\r\n")
        method, target, version = lines[0].split(" ")
    except ValueError as exc:
        raise Denied("invalid request line") from exc
    if method not in {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT"} or version not in {"HTTP/1.0", "HTTP/1.1"}:
        raise Denied("unsupported HTTP method or version")
    if any(ord(c) < 33 or ord(c) > 126 for c in target) or "\\" in target:
        raise Denied("invalid request target")
    headers = []
    for line in lines[1:]:
        if len(headers) >= 100 or ":" not in line:
            raise Denied("invalid request headers")
        key, value = line.split(":", 1)
        if not TOKEN.fullmatch(key) or any(ord(c) < 32 and c != "\t" or ord(c) == 127 for c in value):
            raise Denied("invalid request headers")
        headers.append((key.lower(), value.strip()))
    for unique in ("host", "content-length", "transfer-encoding", "upgrade", "expect"):
        if sum(key == unique for key, _ in headers) > 1:
            raise Denied("duplicate framing header")
    values = dict(headers)
    connection_tokens = [token.strip().lower() for key, value in headers if key == "connection" for token in value.split(",")]
    if any(not TOKEN.fullmatch(token) or token in {"host", "content-length", "transfer-encoding"} for token in connection_tokens):
        raise Denied("invalid hop-by-hop framing declaration")
    if "transfer-encoding" in values or "expect" in values:
        raise Denied("streamed or expect-continue upload is unsupported in this spike")
    length = values.get("content-length", "0")
    if not length.isascii() or not length.isdecimal() or len(length) > 10 or int(length) > BODY_LIMIT:
        raise Denied("invalid or excessive request body size")
    length = int(length)
    if method == "CONNECT":
        parsed = urlsplit("//" + target)
        if parsed.path or parsed.query or parsed.fragment or length:
            raise Denied("invalid CONNECT target")
    else:
        parsed = urlsplit(target)
        if parsed.scheme not in {"http", "ws"} or parsed.fragment:
            raise Denied("absolute HTTP or WebSocket target required")
    if parsed.username is not None or parsed.password is not None:
        raise Denied("userinfo in destination is denied")
    try:
        host = normalize_host(parsed.hostname or "")
        port = parsed.port if parsed.port is not None else (443 if method == "CONNECT" else 80)
    except ValueError as exc:
        raise Denied("invalid destination authority") from exc
    authority = f"[{host}]" if ":" in host else host
    if port != (443 if method == "CONNECT" else 80):
        authority += f":{port}"
    if "host" in values:
        try:
            declared = urlsplit("//" + values["host"])
            declared_host = normalize_host(declared.hostname or "")
            declared_port = declared.port if declared.port is not None else (443 if method == "CONNECT" else 80)
        except ValueError as exc:
            raise Denied("invalid Host header") from exc
        if declared_host != host or declared_port != port or declared.path or declared.username is not None:
            raise Denied("Host header conflicts with destination")
    upgrade = values.get("upgrade", "").lower() == "websocket"
    if "upgrade" in values and not upgrade:
        raise Denied("only WebSocket upgrade is supported")
    if upgrade and (method != "GET" or length):
        raise Denied("WebSocket upgrade requires a bodyless GET")
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    return method, host, port, authority, path, headers, length, upgrade


def relay(left, right, *, bidirectional: bool):
    start = time.monotonic()
    total = 0
    readers = [right, left] if bidirectional else [right]
    while time.monotonic() - start < SESSION_TIMEOUT:
        ready, _, _ = select.select(readers, [], [], IDLE_TIMEOUT)
        if not ready:
            return
        for source in ready:
            data = source.recv(64 * 1024)
            if not data:
                return
            total += len(data)
            if total > TRANSFER_LIMIT:
                return
            destination = right if source is left else left
            destination.sendall(data)


class ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(IDLE_TIMEOUT)
        started_response = False
        try:
            raw, remaining = read_head(self.request)
            method, host, port, authority, path, headers, length, upgrade = parse_request(raw)
            endpoints = self.server.policy.resolve(host, port, method == "CONNECT")
            with connect_pinned(endpoints) as upstream:
                upstream.settimeout(IDLE_TIMEOUT)
                if method == "CONNECT":
                    if remaining:
                        raise Denied("pipelined CONNECT data is unsupported")
                    self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    started_response = True
                    # CONNECT may carry HTTPS/WSS, never a plaintext arbitrary protocol.
                    first = bytearray()
                    while len(first) < 5:
                        part = self.request.recv(5 - len(first))
                        if not part:
                            return
                        first.extend(part)
                    if first[0] != 22 or first[1] != 3 or first[2] > 4 or not 0 < int.from_bytes(first[3:5], "big") <= 18432:
                        raise Denied("CONNECT requires TLS handshake")
                    upstream.sendall(first)
                    relay(self.request, upstream, bidirectional=True)
                else:
                    tokens = {token.strip().lower() for key, value in headers if key == "connection" for token in value.split(",")}
                    excluded = tokens | {"host", "connection", "proxy-connection", "proxy-authorization", "keep-alive", "te", "trailer", "upgrade"}
                    forwarded = [(key, value) for key, value in headers if key not in excluded and not key.startswith("proxy-")]
                    forwarded.extend([("host", authority), ("connection", "Upgrade" if upgrade else "close")])
                    if upgrade:
                        forwarded.append(("upgrade", "websocket"))
                    head = f"{method} {path} HTTP/1.1\r\n" + "".join(f"{key}: {value}\r\n" for key, value in forwarded) + "\r\n"
                    if len(remaining) > length:
                        raise Denied("pipelined HTTP requests are unsupported")
                    upstream.sendall(head.encode("iso-8859-1"))
                    upstream.sendall(remaining)
                    todo = length - len(remaining)
                    body_deadline = time.monotonic() + SESSION_TIMEOUT
                    while todo:
                        if time.monotonic() > body_deadline:
                            raise Denied("upload time limit exceeded")
                        chunk = self.request.recv(min(todo, 64 * 1024))
                        if not chunk:
                            raise Denied("incomplete request body")
                        upstream.sendall(chunk)
                        todo -= len(chunk)
                    started_response = True
                    if upgrade:
                        response_head, response_extra = read_head(upstream)
                        self.request.sendall(response_head + b"\r\n\r\n" + response_extra)
                        is_upgrade = response_head.split(b"\r\n", 1)[0].split(b" ")[1:2] == [b"101"]
                        relay(self.request, upstream, bidirectional=is_upgrade)
                    else:
                        relay(self.request, upstream, bidirectional=False)
        except (Denied, OSError, ValueError, IndexError) as exc:
            if not started_response:
                status = 403 if isinstance(exc, Denied) else 502
                body = ("Destination or request denied\n" if status == 403 else "Permitted upstream unavailable\n").encode()
                try:
                    self.request.sendall(f"HTTP/1.1 {status} {'Forbidden' if status == 403 else 'Bad Gateway'}\r\nConnection: close\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
                except OSError:
                    pass
            # No URL, query, credentials, headers, or payload in logs.
            print(json.dumps({"event": "proxy_request_failed", "category": type(exc).__name__}), flush=True)


class ProxyServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 32

    def __init__(self, address, policy):
        self.policy = policy
        self.slots = threading.BoundedSemaphore(32)
        super().__init__(address, ProxyHandler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


if __name__ == "__main__":
    policy = Policy.from_environment()
    bind = os.environ.get("EGRESS_BIND", "0.0.0.0")
    with ProxyServer((bind, 3128), policy) as server:
        print(json.dumps({"event": "proxy_ready", "test_only": bool(policy.fixture_ip)}), flush=True)
        server.serve_forever(poll_interval=0.25)
