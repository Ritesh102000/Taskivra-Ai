#!/usr/bin/env python3
"""Phase 0 Docker gateway spike. Payloads execute exclusively inside containers."""
from __future__ import annotations

import argparse
import base64
from dataclasses import asdict, dataclass
import io
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

from export_protocol import MAX_BYTES, MAX_FILES, MAX_HEADER, commit_export, safe_path

HERE = Path(__file__).resolve().parent
DEFAULT_IMAGE = "agent-workspaces-phase0-code:2026-09-11"
LABEL = "io.agent-workspaces.phase0.code"


@dataclass(frozen=True)
class Limits:
    memory_mib: int = 1024
    workspace_mib: int = 512
    tmp_mib: int = 128
    pids: int = 256
    timeout_seconds: float = 120
    log_bytes: int = 1024 * 1024
    export_bytes: int = MAX_BYTES
    files: int = MAX_FILES


class GatewayError(RuntimeError):
    pass


def docker(*args, timeout=30, data=None):
    result = subprocess.run(["docker", *args], input=data, capture_output=True, timeout=timeout)
    if result.returncode:
        raise GatewayError(result.stderr.decode(errors="replace")[-2000:])
    return result.stdout


def bounded_process(argv, timeout, max_bytes, on_abort, stdout_file=None):
    """Bound total output and wall time. No shell, and never run a payload here."""
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    output = {"stdout": bytearray(), "stderr": bytearray()}
    total = 0
    deadline = time.monotonic() + timeout
    abort = None
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                abort = "timeout"
                break
            for key, _ in selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                available = max(0, max_bytes - total)
                accepted = chunk[:available]
                if key.data == "stdout" and stdout_file is not None:
                    stdout_file.write(accepted)
                else:
                    output[key.data].extend(accepted)
                total += len(chunk)
                if total > max_bytes:
                    abort = "output_limit"
                    break
            if abort:
                break
        if abort:
            # Killing only a Docker CLI does not stop its in-container payload.
            # Kill our exact container first, which also drops uncommitted tmpfs.
            on_abort()
            process.kill()
        try:
            code = process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            on_abort()
            process.kill()
            code = process.wait(timeout=5)
            abort = abort or "transport_timeout"
        return {"exit_code": code, "abort": abort, "stdout": bytes(output["stdout"]), "stderr": bytes(output["stderr"]), "observed_bytes": total}
    finally:
        selector.close()
        process.stdout.close()
        process.stderr.close()
        if process.poll() is None:
            on_abort()
            process.kill()
            process.wait(timeout=5)


class CodeGateway:
    def __init__(self, image=DEFAULT_IMAGE, limits=Limits()):
        self.limits = limits
        details = json.loads(docker("image", "inspect", image))[0]
        if details["Architecture"] != "arm64":
            raise GatewayError("expected locally available ARM64 image; no implicit pull")
        if details["Config"].get("Volumes"):
            raise GatewayError("image declares implicit writable volumes")
        self.image = details["Id"]  # Immutable for the complete run.
        self.image_details = {"id": self.image, "architecture": details["Architecture"], "size_bytes": details["Size"]}

    def flags(self, name):
        limits = self.limits
        return ["create", "--pull=never", "--platform", "linux/arm64", "--name", name,
                "--label", LABEL + "=" + name, "--network", "none", "--read-only",
                "--cap-drop", "ALL", "--cap-add", "KILL", "--security-opt", "no-new-privileges=true",
                "--user", "0:0", "--memory", f"{limits.memory_mib}m", "--memory-swap", f"{limits.memory_mib}m",
                "--cpus", "1", "--pids-limit", str(limits.pids), "--ipc", "private", "--shm-size", "1m",
                "--ulimit", "core=0:0", "--ulimit", "nofile=256:256", "--log-driver", "none",
                "--tmpfs", f"/workspace:rw,noexec,nosuid,nodev,size={limits.workspace_mib}m,nr_inodes={limits.files + 128},uid=10000,gid=10000,mode=0755",
                "--tmpfs", f"/tmp:rw,noexec,nosuid,nodev,size={limits.tmp_mib}m,nr_inodes=1024,mode=1777",
                "--env", "PYTHONDONTWRITEBYTECODE=1", self.image]

    def _owned(self, name):
        info = json.loads(docker("inspect", name))[0]
        if info["Config"].get("Labels", {}).get(LABEL) != name:
            raise GatewayError("refusing to touch container without exact ownership label")
        return info

    def _kill(self, name):
        info = self._owned(name)
        if info["State"]["Running"]:
            docker("kill", name, timeout=10)

    def _seed(self, name, files):
        if len(files) > self.limits.files or sum(len(data) for data in files.values()) > self.limits.export_bytes:
            raise GatewayError("input snapshot exceeds limits")
        encoded = {safe_path(path): base64.b64encode(value).decode() for path, value in files.items()}
        script = ("import sys,json,base64,pathlib; "
                  "d=json.load(sys.stdin); "
                  "[(p.parent.mkdir(parents=True,exist_ok=True),p.write_bytes(base64.b64decode(v,validate=True))) "
                  "for k,v in d.items() for p in [pathlib.Path('/workspace')/k]]")
        docker("exec", "-i", "--user", "10000:10000", name, "python3", "-I", "-c", script,
               data=json.dumps(encoded).encode())

    def run(self, argv, inputs, revisions: Path, *, hard_kill_before_export=False):
        if not argv or any(not isinstance(value, str) or "\0" in value for value in argv):
            raise GatewayError("invalid payload argv")
        name = "aw-p0-code-" + uuid.uuid4().hex[:16]
        result = {"container": name, "image": self.image_details, "limits": asdict(self.limits),
                  "workspace_committed": False, "payload_status_source": "docker exec exit status", "scope": "phase0 spike"}
        created = False
        start = time.monotonic()
        try:
            docker(*self.flags(name))
            created = True
            docker("start", name)
            config = self._owned(name)
            result["runtime_controls"] = {"network": config["HostConfig"]["NetworkMode"],
                "readonly_root": config["HostConfig"]["ReadonlyRootfs"], "binds": config["HostConfig"].get("Binds"),
                "ports": config["HostConfig"].get("PortBindings"), "cap_drop": config["HostConfig"]["CapDrop"],
                "supervisor_caps": config["HostConfig"]["CapAdd"], "tmpfs": config["HostConfig"]["Tmpfs"],
                "memory_bytes": config["HostConfig"]["Memory"], "pids_limit": config["HostConfig"]["PidsLimit"]}
            self._seed(name, inputs)
            payload = bounded_process(["docker", "exec", "--user", "10000:10000", "--workdir", "/workspace", name,
                                       "/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp",
                                       "PYTHONDONTWRITEBYTECODE=1", *argv],
                                      self.limits.timeout_seconds, self.limits.log_bytes, lambda: self._kill(name))
            result["payload"] = {key: value.decode(errors="replace") if isinstance(value, bytes) else value for key, value in payload.items()}
            if payload["abort"]:
                raise GatewayError("payload " + payload["abort"] + "; tmpfs discarded")
            if hard_kill_before_export:
                self._kill(name)
            state = self._owned(name)["State"]
            if not state["Running"] or state.get("OOMKilled"):
                raise GatewayError("container died before export; previous revision retained")
            result["quiesce"] = json.loads(docker("exec", "--user", "0:0", name, "python3", "-I", "/opt/phase0/supervisor.py", "quiesce", timeout=10))
            if payload["exit_code"] != 0:
                raise GatewayError("payload failed; previous revision retained")
            with tempfile.TemporaryFile() as staging:
                exported = bounded_process(["docker", "exec", "--user", "0:0", name, "python3", "-I", "/opt/phase0/supervisor.py", "export"],
                                           30, self.limits.export_bytes + (MAX_HEADER + 4) * (self.limits.files + 1),
                                           lambda: self._kill(name), stdout_file=staging)
                if exported["abort"] or exported["exit_code"]:
                    raise GatewayError("export failed: " + exported["stderr"].decode(errors="replace")[-1000:])
                if not self._owned(name)["State"]["Running"]:
                    raise GatewayError("container died during export")
                staging.seek(0)
                result["revision"] = commit_export(staging, revisions, self.limits.files, self.limits.export_bytes)
                result["workspace_committed"] = True
            result["status"] = "passed"
        except (GatewayError, ValueError, OSError, subprocess.SubprocessError) as exc:
            result["status"] = "failed_closed"
            result["error"] = str(exc)
        finally:
            result["duration_seconds"] = round(time.monotonic() - start, 3)
            if created:
                try:
                    self._owned(name)
                    docker("rm", "--force", name, timeout=15)
                    result["cleanup"] = "removed exact owned container"
                except Exception as exc:
                    result["cleanup"] = "requires reconciliation: " + str(exc)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default=DEFAULT_IMAGE)
    parser.add_argument("--output", type=Path, default=HERE / "evidence" / "smoke.json")
    args = parser.parse_args()
    gateway = CodeGateway(args.image)
    with tempfile.TemporaryDirectory(prefix="aw-p0-code-") as directory:
        result = gateway.run(["python3", "-I", "-c", "from pathlib import Path; Path('result.txt').write_text(Path('input.txt').read_text().upper())"],
                             {"input.txt": b"phase zero\n"}, Path(directory) / "revisions")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"status": result["status"], "evidence": str(args.output)}))
    return 0 if result["workspace_committed"] else 1


if __name__ == "__main__":
    sys.exit(main())
