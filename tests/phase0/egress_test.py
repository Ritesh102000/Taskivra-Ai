import importlib.util
import os
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "spikes" / "phase0" / "egress" / "proxy.py"
spec = importlib.util.spec_from_file_location("phase0_proxy", SOURCE)
proxy = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = proxy
spec.loader.exec_module(proxy)


def answers(*ips):
    return [(socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 80)) for ip in ips]


class EgressPolicyTests(unittest.TestCase):
    def test_denies_nonpublic_literals_and_transition_addresses(self):
        for ip in ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "240.1.1.1", "192.0.2.1", "192.0.0.9", "::1", "::", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::1"]:
            with self.subTest(ip=ip), self.assertRaises(proxy.Denied):
                proxy.Policy().resolve(ip, 80)

    def test_all_dns_answers_must_be_public(self):
        policy = proxy.Policy(resolver=lambda *a, **kw: answers("93.184.216.34", "127.0.0.1"))
        with self.assertRaises(proxy.Denied):
            policy.resolve("example.com", 80)

    def test_dns_revalidated_and_addresses_pinned(self):
        with patch.object(proxy.socket, "socket") as socket_factory:
            resolver = unittest.mock.Mock(side_effect=[answers("93.184.216.34"), answers("10.0.0.1")])
            policy = proxy.Policy(resolver=resolver)
            proxy.connect_pinned(policy.resolve("example.com", 80))
            socket_factory.return_value.connect.assert_called_once_with(("93.184.216.34", 80))
            with self.assertRaises(proxy.Denied):
                policy.resolve("example.com", 80)
            self.assertEqual(resolver.call_count, 2)

    def test_public_ipv4_ipv6_and_only_standard_web_ports(self):
        self.assertEqual(proxy.Policy().resolve("93.184.216.34", 80)[0].address, "93.184.216.34")
        self.assertEqual(proxy.Policy().resolve("2606:4700::1111", 443, True)[0].family, socket.AF_INET6)
        for port, tunnel in [(22, False), (443, False), (80, True), (8443, True), (3128, False)]:
            with self.subTest(port=port, tunnel=tunnel), self.assertRaises(proxy.Denied):
                proxy.Policy().resolve("93.184.216.34", port, tunnel)

    def test_service_names_rejected_before_dns(self):
        resolver = unittest.mock.Mock()
        for host in ["localhost", "LOCALHOST.", "x.localhost", "host.docker.internal", "gateway.docker.internal", "metadata.google.internal", "printer.local", "fixture.agent-workspaces.test"]:
            with self.subTest(host=host), self.assertRaises(proxy.Denied):
                proxy.Policy(resolver=resolver).resolve(host, 80)
        resolver.assert_not_called()

    def test_fixture_exception_is_explicit_exact_and_not_transitive(self):
        policy = proxy.Policy(fixture_ip="172.25.0.2")
        self.assertEqual(policy.resolve(proxy.FIXTURE_HOST, 8080)[0].address, "172.25.0.2")
        self.assertEqual(policy.resolve(proxy.FIXTURE_HOST, 8443, True)[0].port, 8443)
        for host, port in [("172.25.0.2", 8080), (proxy.FIXTURE_HOST, 80), ("other.agent-workspaces.test", 8080), ("host.docker.internal", 8080)]:
            with self.subTest(host=host, port=port), self.assertRaises(proxy.Denied):
                policy.resolve(host, port)
        with patch.dict(os.environ, {"EGRESS_TEST_FIXTURE_IP": "172.25.0.2"}, clear=True), self.assertRaises(ValueError):
            proxy.Policy.from_environment()
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(proxy.Policy.from_environment().fixture_ip)


class ProxyParsingTests(unittest.TestCase):
    def test_normal_get_and_websocket(self):
        parsed = proxy.parse_request(b"GET http://example.com/x?q=1 HTTP/1.1\r\nHost: example.com")
        self.assertEqual(parsed[:5], ("GET", "example.com", 80, "example.com", "/x?q=1"))
        parsed = proxy.parse_request(b"GET ws://example.com/socket HTTP/1.1\r\nHost: example.com\r\nUpgrade: websocket\r\nConnection: Upgrade")
        self.assertTrue(parsed[-1])

    def test_smuggling_and_unsupported_protocols_rejected(self):
        cases = [
            b"GET http://example.com/ HTTP/1.1\r\nHost: localhost",
            b"GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nHost: example.com",
            b"POST http://example.com/ HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1",
            b"POST http://example.com/ HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked",
            b"GET http://user:pass@example.com/ HTTP/1.1",
            b"GET file:///etc/passwd HTTP/1.1",
            b"GET ftp://example.com/file HTTP/1.1",
            b"GET http://example.com/ HTTP/1.1\r\n X: folded",
            b"GET http://example.com/ HTTP/1.1\r\nUpgrade: h2c",
            b"CONNECT example.com:443/path HTTP/1.1",
            b"CONNECT example.com:443 HTTP/1.1\r\nContent-Length: 5",
            b"GET http://[fe80::1%eth0]/ HTTP/1.1",
            b"POST http://example.com/ HTTP/1.1\r\nContent-Length: 1\r\nConnection: content-length",
            b"POST http://example.com/ HTTP/1.1\r\nUpgrade: websocket",
        ]
        for raw in cases:
            with self.subTest(raw=raw), self.assertRaises(proxy.Denied):
                proxy.parse_request(raw)

    def test_port_zero_is_not_silently_mapped_to_default(self):
        parsed = proxy.parse_request(b"GET http://example.com:0/ HTTP/1.1")
        self.assertEqual(parsed[2], 0)
        with self.assertRaises(proxy.Denied):
            proxy.Policy().resolve(parsed[1], parsed[2])


if __name__ == "__main__":
    unittest.main()
