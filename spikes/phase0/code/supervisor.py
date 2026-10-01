"""Trusted code-image helpers. Never imported from a writable payload directory."""
import json
import os
from pathlib import Path
import signal
import sys
import time

sys.path.insert(0, "/opt/phase0")
from export_protocol import export_tree

PAYLOAD_UID = 10000


def payload_processes():
    processes = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            fields = dict(line.split(":", 1) for line in (entry / "status").read_text().splitlines() if ":" in line)
            uids = [int(value) for value in fields["Uid"].split()]
            if PAYLOAD_UID in uids and not fields["State"].strip().startswith("Z"):
                processes.append(int(entry.name))
        except (FileNotFoundError, ProcessLookupError):
            pass
    return processes


def quiesce():
    deadline = time.monotonic() + 5
    kills = 0
    while time.monotonic() < deadline:
        pids = payload_processes()
        if not pids:
            time.sleep(0.05)
            if not payload_processes():
                return kills
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
                kills += 1
            except ProcessLookupError:
                pass
        time.sleep(0.025)
    raise RuntimeError("payload did not quiesce; export forbidden")


def main():
    if os.getuid() != 0:
        raise RuntimeError("trusted supervisor requires its distinct runtime identity")
    command = sys.argv[1]
    if command == "init":
        # PID 1 stays alive through payload exit and export and reaps orphans.
        while True:
            try:
                while os.waitpid(-1, os.WNOHANG)[0]:
                    pass
            except ChildProcessError:
                pass
            time.sleep(0.025)
    elif command == "quiesce":
        print(json.dumps({"quiesced": True, "killed": quiesce(), "remaining": payload_processes()}))
    elif command == "export":
        quiesce()
        export_tree("/workspace", sys.stdout.buffer)
    else:
        raise ValueError("unsupported trusted command")


if __name__ == "__main__":
    main()
