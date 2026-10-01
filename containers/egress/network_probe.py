"""Runs inside the restricted browser-equivalent network namespace.

JSON evidence reports failures explicitly. All external optional contact is to
example.com; fixture and host targets are explicit owned canaries from harness.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import ssl
import struct
import time

HOST = "fixture.agent-workspaces.test"
results = []


def record(name, ok, detail=None):
    results.append({"check": name, "passed": bool(ok), **({"detail": detail} if detail is not None else {})})


def receive_head(conn):
    data = b""
    while b"\r\n\r\n" not in data and len(data) < 32768:
        chunk = conn.recv(4096)
        if not chunk:
            break
        data += chunk
    return data


def request(proxy, url, method="GET", headers=""):
    with socket.create_connection((proxy, 3128), timeout=3) as conn:
        conn.sendall(f"{method} {url} HTTP/1.1\r\nConnection: close\r\n{headers}\r\n".encode())
        return receive_head(conn)


def tls_connection(proxy, hostname, port, fixture=True):
    conn = socket.create_connection((proxy, 3128), timeout=5)
    conn.sendall(f"CONNECT {hostname}:{port} HTTP/1.1\r\nHost: {hostname}:{port}\r\n\r\n".encode())
    response = receive_head(conn)
    if b" 200 " not in response.split(b"\r\n", 1)[0]:
        conn.close()
        raise RuntimeError("CONNECT was not accepted")
    context = ssl.create_default_context(cafile=str(Path(__file__).with_name("fixture-cert.pem")) if fixture else None)
    return context.wrap_socket(conn, server_hostname=hostname)


def websocket(conn, target):
    conn.sendall(f"GET {target} HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: cGhhc2UwLWZpeHR1cmUtMQ==\r\nSec-WebSocket-Version: 13\r\n\r\n".encode())
    reply = receive_head(conn)
    if b" 101 " not in reply.split(b"\r\n", 1)[0]:
        return False
    payload = b"phase0-ws"
    mask = b"test"
    conn.sendall(bytes([129, 128 | len(payload)]) + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(payload)))
    reply = conn.recv(100)
    return reply == bytes([129, len(payload)]) + payload


def tcp_denied(address, port):
    try:
        with socket.create_connection((address, port), timeout=1):
            return False
    except OSError:
        return True


def dns_query(server, name):
    txid = 0x5173
    packet = struct.pack("!HHHHHH", txid, 0x0100, 1, 0, 0, 0)
    packet += b"".join(bytes([len(label)]) + label.encode() for label in name.split(".")) + b"\0" + struct.pack("!HH", 1, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as conn:
        conn.settimeout(2)
        conn.sendto(packet, (server, 53))
        try:
            response = conn.recv(2048)
            flags, _questions, count = struct.unpack("!HHH", response[2:8])
            return {"received": True, "rcode": flags & 15, "answers": count}
        except OSError:
            return {"received": False, "answers": 0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--proxy", required=True)
    parser.add_argument("--fixture-ip", required=True)
    parser.add_argument("--peer-ip", required=True)
    parser.add_argument("--public-ip")
    parser.add_argument("--host-ip")
    parser.add_argument("--host-port", type=int)
    parser.add_argument("--gateway", action="append", default=[])
    parser.add_argument("--public", action="store_true")
    args = parser.parse_args()
    for _ in range(40):
        if not tcp_denied(args.proxy, 3128):
            break
        time.sleep(0.1)
    try:
        response = request(args.proxy, f"http://{HOST}:8080/health")
        record("fixture_http_via_proxy", b" 200 " in response)
        with tls_connection(args.proxy, HOST, 8443) as conn:
            conn.sendall(f"GET /health HTTP/1.1\r\nHost: {HOST}\r\nConnection: close\r\n\r\n".encode())
            record("fixture_https_via_proxy", b" 200 " in receive_head(conn))
        with socket.create_connection((args.proxy, 3128), timeout=3) as conn:
            record("fixture_websocket_via_proxy", websocket(conn, f"http://{HOST}:8080/ws"))
        with tls_connection(args.proxy, HOST, 8443) as conn:
            record("fixture_secure_websocket_via_proxy", websocket(conn, "/ws"))
        for target in ["http://127.0.0.1/", "http://10.0.0.1/", "http://169.254.169.254/", "http://host.docker.internal/", "http://gateway.docker.internal/", "http://[::1]/", "http://[fe80::1]/", f"http://{args.fixture_ip}:8080/", f"http://{args.proxy}:3128/", "http://2130706433/", "http://127.1/", "http://0x7f000001/"]:
            record("proxy_denies_" + target, b" 403 " in request(args.proxy, target))
        for target in ["127.0.0.1:443", "[::1]:443", "host.docker.internal:443", f"{HOST}:443"]:
            record("connect_denies_" + target, b" 403 " in request(args.proxy, target, "CONNECT"))
        redirect = request(args.proxy, f"http://{HOST}:8080/redirect-private")
        record("private_redirect_returned_as_redirect", b" 302 " in redirect and b"Location: http://127.0.0.1/private" in redirect)
        record("private_redirect_follow_is_denied", b" 403 " in request(args.proxy, "http://127.0.0.1/private"))
        record("subresource_private_destination_denied", b" 403 " in request(args.proxy, "http://host.docker.internal/private"))
        for name, address, port in [("fixture", args.fixture_ip, 8080), ("peer_agent", args.peer_ip, 8080), ("proxy_management", args.proxy, 9222)]:
            record("direct_tcp_" + name + "_denied", tcp_denied(address, port))
        if args.host_ip and args.host_port:
            record("direct_host_canary_denied", tcp_denied(args.host_ip, args.host_port))
        for gateway in args.gateway:
            record("direct_gateway_denied_" + gateway, tcp_denied(gateway, args.host_port or 80))
        if args.public_ip:
            record("direct_public_example_tcp_denied", tcp_denied(args.public_ip, 443))
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as conn:
            conn.settimeout(1)
            try:
                conn.sendto(b"phase0-direct-udp", (args.fixture_ip, 8081))
                data = conn.recv(1024)
                record("direct_udp_to_fixture_denied", not data)
            except OSError:
                record("direct_udp_to_fixture_denied", True)
        dns = dns_query("127.0.0.11", "example.com")
        record("embedded_dns_external_resolution_denied", dns["answers"] == 0, dns)
        dns = dns_query("127.0.0.1", "example.com")
        record("loopback_dns_has_no_upstream", dns["answers"] == 0, dns)
        record("docker_dns_override_is_loopback", "127.0.0.11" in Path("/etc/resolv.conf").read_text() or "127.0.0.1" in Path("/etc/resolv.conf").read_text())
        record("browser_namespace_ipv6_disabled", Path("/proc/sys/net/ipv6/conf/all/disable_ipv6").read_text().strip() == "1")
        if args.public:
            with tls_connection(args.proxy, "example.com", 443, fixture=False) as conn:
                conn.sendall(b"GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n")
                record("public_example_https_via_proxy", b" 200 " in receive_head(conn))
    except Exception as exc:
        record("probe_completed", False, type(exc).__name__ + ": " + str(exc))
    print(json.dumps({"test_only_fixture": True, "checks": results, "passed": all(r["passed"] for r in results)}, indent=2))
    return 0 if all(r["passed"] for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
