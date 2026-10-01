#!/usr/bin/env python3
"""Read-only environment inventory. --write saves sanitized evidence only."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def command(argv, timeout=15):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return {"exit_code": result.returncode, "stdout": result.stdout.strip()[:8192],
                "stderr": result.stderr.strip()[:2048]}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"exit_code": None, "error": type(exc).__name__}


def inventory():
    disk = shutil.disk_usage(ROOT)
    mem = command(["sysctl", "-n", "hw.memsize"])
    docker = command(["docker", "info", "--format",
                      '{"version":{{json .ServerVersion}},"architecture":{{json .Architecture}},'
                      '"memory_bytes":{{json .MemTotal}},"cpus":{{json .NCPU}}}'])
    report = {
        "recorded_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "host": {"system": platform.system(), "macos": platform.mac_ver()[0],
                 "architecture": platform.machine(), "cpus": os.cpu_count(),
                 "memory_bytes": int(mem["stdout"]) if mem.get("stdout", "").isdigit() else None},
        "storage": {"total_bytes": disk.total, "available_bytes": disk.free,
                    "available_gib": round(disk.free / 2**30, 2),
                    "large_image_build_ready": disk.free >= 8 * 2**30,
                    "note": "8 GiB is a conservative spike preflight threshold, not an MVP capacity measurement."},
        "tools": {name: command([name, "--version"]) for name in ["node", "npm", "python3", "docker"]},
        "docker": {"state": "ready" if docker.get("exit_code") == 0 else "unavailable"},
        "openai": {"environment_key_present": bool(os.environ.get("OPENAI_API_KEY")),
                   "keychain": "not read by inventory", "live_model_request": "not performed"},
        "scope": "Inventory only; this report does not establish any container isolation or model gate."
    }
    if docker.get("exit_code") == 0:
        try:
            report["docker"].update(json.loads(docker["stdout"]))
        except (ValueError, KeyError):
            report["docker"]["state"] = "unparseable"
    else:
        report["docker"]["action"] = "Start the installed Docker Desktop runtime, then rerun."
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    report = inventory()
    encoded = json.dumps(report, indent=2) + "\n"
    if args.write:
        path = ROOT / "docs/phase0/evidence/environment.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(encoded)
    print(encoded, end="")
