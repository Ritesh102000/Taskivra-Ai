"""Trusted framed input receiver, run before any payload exists. No host paths."""
import os
from pathlib import Path
import sys

sys.path.insert(0, "/opt/agent-code")
from export_protocol import validate_export


def seed(area, files, size):
    if area not in ("workspace", "shared") or not 1 <= files <= 4096 or not 1 <= size <= 512 * 1024 * 1024:
        raise ValueError("invalid input limits")
    if os.getuid() != (10000 if area == "workspace" else 0):
        raise ValueError("wrong input receiver identity")
    root = Path("/" + area)
    manifest = validate_export(sys.stdin.buffer, root, files, size)
    if area == "workspace":
        for name in ("inputs", "work", "outputs"):
            (root / name).mkdir(exist_ok=True)
    else:
        # The mount is writable only to the trusted root identity during seeding.
        # No payload can own/chmod/remove these entries after sealing.
        for entry in manifest:
            (root / entry["path"]).chmod(0o444)
        for directory, _, _ in os.walk(root, topdown=False):
            Path(directory).chmod(0o555)
    print('{"seeded":true}', flush=True)


if __name__ == "__main__":
    seed(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))
