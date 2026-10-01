"""Create only labelled, disposable Phase 0 network resources.

No image pull/build is implicit. 'up' prints a JSON contract for the browser
spike. 'check' launches a browser-equivalent unprivileged network probe.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
from pathlib import Path
import re
import shutil
import socket
import subprocess
import threading
import uuid

ROOT = Path(__file__).resolve().parent
LABEL = "agent-workspaces.phase0-egress"
DOCKER = shutil.which("docker") or "/Applications/Docker.app/Contents/Resources/bin/docker"


def docker(*args, check=True, timeout=30):
    result = subprocess.run([DOCKER, *map(str, args)], capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"docker {args[0]} failed: {result.stderr.strip()[:1000]}")
    return result


def inspect(kind, name):
    return json.loads(docker(kind, "inspect", name).stdout)[0]


def save_state(state, state_path):
    state_path.parent.mkdir(parents=True, exist_ok=True)
    pending = state_path.with_suffix(state_path.suffix + ".tmp")
    pending.write_text(json.dumps(state, indent=2) + "\n")
    pending.replace(state_path)


def hardened(memory="128m"):
    return ["--read-only", "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", memory, "--memory-swap", memory,
            "--pids-limit", "64", "--cpus", "0.5", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=8m", "--sysctl", "net.ipv4.ip_forward=0",
            "--sysctl", "net.ipv6.conf.all.disable_ipv6=1", "--sysctl", "net.ipv6.conf.default.disable_ipv6=1", "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=2"]


def browser_network_args():
    return ["--dns", "127.0.0.1", "--dns-search", ".", "--dns-opt", "timeout:1", "--dns-opt", "attempts:1",
            "--sysctl", "net.ipv6.conf.all.disable_ipv6=1", "--sysctl", "net.ipv6.conf.default.disable_ipv6=1"]


def create_network(name, run_id, internal=False):
    args = ["network", "create", "--driver", "bridge", "--label", f"{LABEL}={run_id}"]
    if internal:
        args += ["--internal", "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated", "--opt", "com.docker.network.bridge.gateway_mode_ipv6=isolated"]
    docker(*args, name)
    return inspect("network", name)


def cleanup(state):
    errors = []
    run_id = state["run_id"]
    for kind, entries in [("container", state.get("containers", [])), ("network", state.get("networks", []))]:
        for name in reversed(entries):
            try:
                result = docker(kind, "inspect", name, check=False)
                if result.returncode:
                    continue
                data = json.loads(result.stdout)[0]
                labels = data.get("Config", {}).get("Labels", {}) if kind == "container" else data.get("Labels", {})
                if labels.get(LABEL) != run_id:
                    raise RuntimeError(f"refusing to remove unowned {kind} {name}")
                command = [kind, "rm", "-f", name] if kind == "container" else [kind, "rm", name]
                result = docker(*command, check=False)
                if result.returncode:
                    errors.append(result.stderr.strip())
            except Exception as exc:
                errors.append(str(exc))
    return errors


def up(image, state_path, test_fixture):
    if state_path.exists():
        raise ValueError("state file already exists; use down first or a new file")
    # This command never builds/pulls. Workloads are read-only with bounded logs
    # and tmpfs; leave a separate minimum reserve for runtime bookkeeping.
    if shutil.disk_usage(ROOT).free < 1024 ** 3:
        raise RuntimeError("less than 1 GiB host free disk; refusing runtime provisioning")
    image_data = inspect("image", image)
    run_id = "awp0-egress-" + uuid.uuid4().hex[:10]
    state = {"schema": 1, "run_id": run_id, "image": image_data["Id"], "test_only": bool(test_fixture), "networks": [], "containers": []}
    save_state(state, state_path)
    try:
        internal, outbound = run_id + "-browser", run_id + "-outbound"
        for name, restricted in [(internal, True), (outbound, False)]:
            state["networks"].append(name)
            save_state(state, state_path)
            create_network(name, run_id, restricted)
        subnet = ipaddress.ip_network(inspect("network", internal)["IPAM"]["Config"][0]["Subnet"])
        proxy_ip = str(subnet.network_address + 2)
        proxy_networks = ["--network", f"name={internal},alias=egress,ip={proxy_ip}", "--network", f"name={outbound},gw-priority=1"]
        proxy_env = ["-e", f"EGRESS_BIND={proxy_ip}"]
        if test_fixture:
            for role in ("fixture", "peer"):
                network, container = run_id + "-" + role + "-net", run_id + "-" + role
                state["networks"].append(network)
                save_state(state, state_path)
                create_network(network, run_id, True)
                state["containers"].append(container)
                save_state(state, state_path)
                docker("run", "-d", "--pull", "never", "--name", container, "--label", f"{LABEL}={run_id}", *hardened(), "--network", network, state["image"], "/opt/agent-egress/fixture.py")
                state[role + "_ip"] = inspect("container", container)["NetworkSettings"]["Networks"][network]["IPAddress"]
                if role == "fixture":
                    proxy_networks += ["--network", network]
            proxy_env += ["-e", "EGRESS_TEST_ONLY=1", "-e", f"EGRESS_TEST_FIXTURE_IP={state['fixture_ip']}"]
            state["fixture_url"] = "http://fixture.agent-workspaces.test:8080"
        proxy = run_id + "-proxy"
        state["containers"].append(proxy)
        save_state(state, state_path)
        docker("run", "-d", "--pull", "never", "--name", proxy, "--label", f"{LABEL}={run_id}", *hardened(), *proxy_networks, *proxy_env,
               "--dns-opt", "timeout:2", "--dns-opt", "attempts:1", state["image"], "/opt/agent-egress/proxy.py")
        state.update({"browser_network": internal, "proxy_container": proxy, "proxy_ip": proxy_ip,
                      "browser_environment": {"BROWSER_PROXY_SERVER": "http://egress:3128"}, "required_browser_network_args": browser_network_args()})
        save_state(state, state_path)
        return state
    except Exception as exc:
        errors = cleanup(state)
        if errors:
            state.update({"provisioning_error": str(exc), "cleanup_errors": errors})
            save_state(state, state_path)
        else:
            state_path.unlink(missing_ok=True)
        raise


class Canary(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"owned-host-canary")

    def log_message(self, *_):
        pass


def check(state, public, state_path, probe_timeout=90):
    if not state["test_only"]:
        raise ValueError("fixture integration checks require up --test-fixture")
    evidence = []
    internal = inspect("network", state["browser_network"])
    evidence.append({"check": "browser_network_internal_and_isolated_gateway", "passed": internal["Internal"] and internal["Options"].get("com.docker.network.bridge.gateway_mode_ipv4") == "isolated"})
    evidence.append({"check": "browser_network_ipv6_disabled", "passed": not internal["EnableIPv6"]})
    for name in state["containers"]:
        data = inspect("container", name)
        evidence.append({"check": f"no_published_ports_{name}", "passed": not data["HostConfig"].get("PortBindings") and not data["HostConfig"].get("PublishAllPorts")})
    proxy_data = inspect("container", state["proxy_container"])
    evidence.append({"check": "proxy_is_not_ip_router", "passed": proxy_data["HostConfig"].get("Sysctls", {}).get("net.ipv4.ip_forward") == "0"})
    # A short-lived, empty host endpoint proves denial against a listening service.
    with ThreadingHTTPServer(("127.0.0.1", 0), Canary) as canary:
        thread = threading.Thread(target=canary.serve_forever, daemon=True)
        thread.start()
        probe_name = state["run_id"] + "-probe"
        try:
            host_address = docker("exec", state["proxy_container"], "python3", "-c", "import socket; print(socket.gethostbyname('host.docker.internal'))").stdout.strip()
            canary_proof = docker("exec", state["proxy_container"], "python3", "-c",
                "import socket,sys; s=socket.create_connection((sys.argv[1],int(sys.argv[2])),timeout=3); s.sendall(b'GET / HTTP/1.0\\r\\n\\r\\n'); print(s.recv(4096).decode()); s.close()",
                host_address, str(canary.server_port), check=False)
            evidence.append({"check": "owned_host_canary_is_reachable_from_trusted_outbound_namespace", "passed": canary_proof.returncode == 0 and "200" in canary_proof.stdout})
            if probe_name not in state["containers"]:
                state["containers"].append(probe_name)
            save_state(state, state_path)
            args = ["run", "--rm", "--pull", "never", "--name", probe_name, "--label", f"{LABEL}={state['run_id']}", *hardened(), "--network", state["browser_network"],
                    "--dns", "127.0.0.1", "--dns-search", ".", "--dns-opt", "timeout:1", "--dns-opt", "attempts:1", state["image"], "/opt/agent-egress/network_probe.py",
                    "--proxy", state["proxy_ip"], "--fixture-ip", state["fixture_ip"], "--peer-ip", state["peer_ip"], "--host-ip", host_address, "--host-port", str(canary.server_port)]
            gateways = {entry.get("Gateway") for name in state["networks"] for entry in inspect("network", name)["IPAM"]["Config"]}
            for gateway in sorted(gateways - {None, ""}):
                args += ["--gateway", gateway]
            if public:
                public_addresses = socket.getaddrinfo("example.com", 443, socket.AF_INET, socket.SOCK_STREAM)
                args += ["--public-ip", public_addresses[0][4][0], "--public"]
            result = docker(*args, check=False, timeout=probe_timeout)
            try:
                probe = json.loads(result.stdout)
            except json.JSONDecodeError:
                probe = {"passed": False, "error": result.stderr.strip()[:1000], "stdout": result.stdout[:1000]}
            evidence.extend(probe.get("checks", []))
            evidence.append({"check": "network_probe_completed", "passed": result.returncode == 0 and probe.get("passed") is True})
        except Exception as exc:
            evidence.append({"check": "network_probe_completed", "passed": False, "detail": type(exc).__name__ + ": " + str(exc)[:1000]})
        finally:
            canary.shutdown()
            errors = cleanup({"run_id": state["run_id"], "containers": [probe_name], "networks": []})
            if not errors and probe_name in state["containers"]:
                state["containers"].remove(probe_name)
            evidence.append({"check": "probe_cleanup_completed", "passed": not errors, **({"errors": errors} if errors else {})})
            save_state(state, state_path)
    source_hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in ("proxy.py", "fixture.py", "network_probe.py", "harness.py", "Dockerfile", "fixture-cert.pem")}
    image_sources = docker("exec", state["proxy_container"], "python3", "-c",
        "import hashlib,json,pathlib; p=pathlib.Path('/opt/agent-egress'); print(json.dumps({n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in ['proxy.py','fixture.py','network_probe.py','fixture-cert.pem']}))", check=False)
    return {"recorded_at": datetime.now(timezone.utc).isoformat(), "docker_server_version": docker("version", "--format", "{{.Server.Version}}").stdout.strip(),
            "test_only_fixture": True, "image": state["image"], "source_sha256": source_hashes,
            "image_source_sha256": json.loads(image_sources.stdout) if image_sources.returncode == 0 else None,
            "cleanup_state": str(state_path.resolve()), "checks": evidence, "passed": all(item["passed"] for item in evidence), "limitations": [
        "Passing deterministic checks is a Phase 0 result, not proof against every kernel/browser exploit.",
        "IPv6 is disabled in the browser namespace; proxy IPv6 address classification is unit-tested, not a live IPv6 routing test.",
        "TLS CONNECT validates and pins destination IP; it does not inspect encrypted HTTP payloads or enforce artifact-upload authorization.",
        "No required real-provider login or device MFA is established by the synthetic fixture.",
    ]}


def read_state(path):
    state = json.loads(path.read_text())
    if state.get("schema") != 1 or not re.fullmatch(r"awp0-egress-[a-f0-9]{10}", state.get("run_id", "")):
        raise ValueError("invalid runtime state")
    return state


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    provision = commands.add_parser("up")
    provision.add_argument("--image", required=True)
    provision.add_argument("--state", type=Path, required=True)
    provision.add_argument("--test-fixture", action="store_true")
    verify = commands.add_parser("check")
    verify.add_argument("--state", type=Path, required=True)
    verify.add_argument("--public", action="store_true", help="Also request only https://example.com via proxy and test denied direct route")
    verify.add_argument("--probe-timeout", type=float, default=90, help="Host deadline; a short value supports deliberate timeout/cleanup verification")
    remove = commands.add_parser("down")
    remove.add_argument("--state", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "up":
        result = up(args.image, args.state, args.test_fixture)
    elif args.command == "check":
        result = check(read_state(args.state), args.public, args.state, args.probe_timeout)
    else:
        errors = cleanup(read_state(args.state))
        result = {"passed": not errors, "errors": errors}
        if not errors:
            args.state.unlink()
    print(json.dumps(result, indent=2))
    return 0 if result.get("passed", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
