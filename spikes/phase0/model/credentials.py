#!/usr/bin/env python3
"""Enter an OpenAI key privately and save it in this project's macOS Keychain item."""
import getpass
import hmac
import os
import re
import subprocess
import sys

SERVICE = "com.agent-workspaces.openai"
ACCOUNT = "owner"


def read_key():
    key = os.environ.get("OPENAI_API_KEY")
    if key:
        return key
    result = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", SERVICE,
                             "-a", ACCOUNT, "-w"], capture_output=True, text=True, timeout=30)
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError("OpenAI key missing. Run npm run phase0:key in your terminal.")
    return result.stdout.strip()


def store_key(key):
    # A restricted alphabet prevents injection into security's interactive parser.
    # The key travels over stdin, never argv, a file, a log, or shell history.
    if not re.fullmatch(r"sk-[A-Za-z0-9_-]{16,512}", key):
        raise ValueError("The key must be an OpenAI secret key without whitespace.")
    line = f'add-generic-password -U -s {SERVICE} -a {ACCOUNT} -w {key}\n'
    result = subprocess.run(["/usr/bin/security", "-i"], input=line,
                            capture_output=True, text=True, timeout=60)
    # Some security interactive versions return 0 even after a command failure.
    if result.returncode or "SecKeychain" in result.stderr or "error" in result.stderr.lower():
        raise RuntimeError("Keychain could not save the key; inspect Keychain Access permissions.")
    verify = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", SERVICE,
                             "-a", ACCOUNT, "-w"], capture_output=True, text=True, timeout=30)
    if verify.returncode or not hmac.compare_digest(verify.stdout.strip(), key):
        raise RuntimeError("Keychain save could not be verified.")


if __name__ == "__main__":
    if sys.platform != "darwin" or not sys.stdin.isatty():
        raise SystemExit("Run this command interactively in your Mac terminal; do not paste keys into chat.")
    try:
        store_key(getpass.getpass("OpenAI API key (hidden): "))
        print("Saved to the Agent Workspaces item in macOS Keychain.")
    except (ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        raise SystemExit(str(exc)) from None
