#!/usr/bin/env python3
"""Run only local boundary tests. Container/model integration is explicit."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
test_dir = ROOT / "tests/phase0"
failed = []
for path in sorted(test_dir.glob("*.py")):
    if not (path.stem.endswith("test") or path.stem.startswith("test") or "test" in path.stem):
        continue
    result = subprocess.run([sys.executable, str(path)], cwd=ROOT)
    if result.returncode:
        failed.append(path.name)
for path in sorted(test_dir.glob("*.test.mjs")):
    result = subprocess.run(["node", "--test", str(path)], cwd=ROOT)
    if result.returncode:
        failed.append(path.name)
if failed:
    raise SystemExit("Failed test files: " + ", ".join(failed))
print("Local tests passed. Container and live model gates require separate evidence.")
