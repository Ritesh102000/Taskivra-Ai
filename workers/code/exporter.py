"""Fixed trusted reader started only after the root supervisor quiesces the payload.

Using the payload's filesystem identity permits ordinary 0600 files/0700 folders
without granting DAC capabilities to PID 1. No arbitrary payload may run again.
"""
import os
import sys

sys.path.insert(0, "/opt/agent-code")
from export_protocol import export_tree
from supervisor import payload_processes, PAYLOAD_UID


def assert_quiescent():
    if os.getuid() != PAYLOAD_UID or payload_processes() != [os.getpid()]:
        raise RuntimeError("another payload-identity process exists; export forbidden")


if __name__ == "__main__":
    files, size = map(int, sys.argv[1:3])
    if not 1 <= files <= 4096 or not 1 <= size <= 512 * 1024 * 1024:
        raise ValueError("invalid export limits")
    assert_quiescent()
    export_tree("/workspace", sys.stdout.buffer, files, size)
    assert_quiescent()
