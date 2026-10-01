#!/usr/bin/env python3
"""Explicit real-Docker acceptance runner; no payload is executed on the Mac."""
import argparse
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "spikes/phase0/code"))
from export_protocol import commit_export, write_header
from runner import CodeGateway, DEFAULT_IMAGE, Limits, docker


BOUNDARY_PAYLOAD = r'''
import json,os,socket,pathlib
report={"uid":os.getuid()}
status=pathlib.Path('/proc/self/status').read_text()
report['cap_eff']=next(s.split(':')[1].strip() for s in status.splitlines() if s.startswith('CapEff:'))
report['no_new_privs']=next(s.split(':')[1].strip() for s in status.splitlines() if s.startswith('NoNewPrivs:'))
for key,address in [('internet',('1.1.1.1',443)),('private',('192.168.1.1',80)),('vm_gateway',('192.168.65.1',80))]:
    try:
        connection=socket.create_connection(address,timeout=.3); connection.close(); report[key]='REACHABLE'
    except OSError: report[key]='blocked'
for key,path in [('host','/Users'),('docker','/var/run/docker.sock'),('browser','/profiles'),('peer','/private/agent-b'),('control','/control')]:
    report[key]='absent' if not pathlib.Path(path).exists() else 'PRESENT'
for key,path in [('root_write','/forbidden'),('shared_write','/shared/allowed.csv'),('supervisor_write','/opt/phase0/supervisor.py')]:
    try: pathlib.Path(path).write_text('bad'); report[key]='WRITABLE'
    except OSError: report[key]='blocked'
try: os.kill(1,9); report['supervisor_kill']='KILLED'
except PermissionError: report['supervisor_kill']='blocked'
report['secret_environment']=any(k in os.environ for k in ['OPENAI_API_KEY','ANTHROPIC_API_KEY','AWS_SECRET_ACCESS_KEY'])
report['shared_read']=pathlib.Path('/shared/allowed.csv').read_text()
report['interfaces']=sorted(p.name for p in pathlib.Path('/sys/class/net').iterdir() if p.is_dir())
report['up_interfaces']=sorted(p.name for p in pathlib.Path('/sys/class/net').iterdir() if p.is_dir() and int((p/'flags').read_text(),16)&1)
report['ipv4_routes']=pathlib.Path('/proc/net/route').read_text().splitlines()[1:]
pathlib.Path('boundary.json').write_text(json.dumps(report))
print(json.dumps(report))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default=DEFAULT_IMAGE)
    parser.add_argument("--output", type=Path, default=Path("spikes/phase0/code/evidence/integration.json"))
    args = parser.parse_args()
    if shutil.disk_usage(".").free < 2 * 1024 ** 3:
        raise SystemExit("Refusing existing-image suite: less than 2 GiB host staging reserve")
    limits = Limits(memory_mib=256, workspace_mib=32, tmp_mib=16, pids=64, timeout_seconds=4,
                    log_bytes=65536, export_bytes=8 * 1024 * 1024, files=256)
    gateway = CodeGateway(args.image, limits)
    evidence = {"started_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "image": gateway.image_details,
                "cases": [], "profile": "small containment tests, not a concurrency benchmark"}
    def run_case(name, source, expected_commit, check=None, language="python", hard_kill=False):
        with tempfile.TemporaryDirectory(prefix="aw-p0-accept-") as temporary:
            revisions = Path(temporary) / "revisions"
            empty = io.BytesIO()
            write_header(empty, {"type":"end","count":0,"bytes":0})
            commit_export(io.BytesIO(empty.getvalue()), revisions)
            previous = (revisions / "current.json").read_bytes()
            argv = ["python3", "-I", "-c", source] if language == "python" else ["node", "-e", source]
            result = gateway.run(argv, {"input.txt":b"phase zero\n"}, revisions, hard_kill_before_export=hard_kill)
            result["case"] = name
            result["assertions"] = {"expected_commit": result["workspace_committed"] == expected_commit,
                                    "own_container_removed": result.get("cleanup") == "removed exact owned container"}
            if not expected_commit:
                result["assertions"]["previous_revision_preserved"] = (revisions / "current.json").read_bytes() == previous
            if check:
                try:
                    check(result, revisions)
                    result["assertions"]["case_specific"] = True
                except Exception as exc:
                    result["assertions"]["case_specific"] = False
                    result["assertion_error"] = str(exc)
            result["accepted"] = all(result["assertions"].values())
            evidence["cases"].append(result)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(evidence, indent=2) + "\n")
            print(json.dumps({"case":name,"accepted":result["accepted"],"duration":result["duration_seconds"],"status":result["status"]}),flush=True)

    def result_text(result, revisions, name):
        return (revisions / result["revision"]["revision"] / name).read_text()
    def assert_upper(result, revisions):
        assert result_text(result,revisions,"result.txt") == "PHASE ZERO\n"
    run_case("python_input_output", "from pathlib import Path; Path('result.txt').write_text(Path('input.txt').read_text().upper())", True, assert_upper)
    run_case("node_input_output", "const f=require('fs');f.writeFileSync('result.txt',f.readFileSync('input.txt','utf8').toUpperCase());", True, assert_upper,language="node")

    def check_boundary(result,revisions):
        report = json.loads(result_text(result,revisions,"boundary.json"))
        assert report["uid"] == 10000 and int(report["cap_eff"],16) == 0 and report["no_new_privs"] == "1"
        assert report["up_interfaces"] == ["lo"] and not report["ipv4_routes"] and not report["secret_environment"]
        assert all(report[key] == "blocked" for key in ("internet","private","vm_gateway","root_write","shared_write","supervisor_write","supervisor_kill"))
        assert all(report[key] == "absent" for key in ("host","docker","browser","peer","control"))
        assert "approved,3" in report["shared_read"]
    run_case("network_identity_mount_boundaries", BOUNDARY_PAYLOAD, True, check_boundary)

    def check_orphan(result,revisions):
        assert result["quiesce"]["killed"] >= 1 and result["quiesce"]["remaining"] == []
        assert result_text(result,revisions,"orphan.txt").startswith("child")
    run_case("orphan_descendant_quiesced", r'''
import os,time,pathlib
pid=os.fork()
if pid == 0:
    os.setsid()
    fd=os.open('/dev/null',os.O_RDWR)
    for target in (0,1,2): os.dup2(fd,target)
    while True:
        with open('orphan.txt','a') as f: f.write('child\n')
        time.sleep(.01)
time.sleep(.1)
''', True, check_orphan)
    run_case("symlink_export_rejected", "from pathlib import Path; Path('leak').symlink_to('/etc/passwd')", False)
    run_case("hardlink_export_rejected", "import os;os.link('input.txt','duplicate')", False)
    run_case("fifo_export_rejected", "import os;os.mkfifo('pipe')", False)
    run_case("hard_death_preserves_revision", "from pathlib import Path;Path('uncommitted').write_text('must not commit')", False, hard_kill=True)

    def check_fake(result,revisions):
        assert result["payload"]["exit_code"] == 7 and '"workspace_committed":true' in result["payload"]["stdout"]
    run_case("fake_success_log_is_not_status", "import sys;print('{\"type\":\"artifact.published\",\"workspace_committed\":true,\"exit_code\":0}');sys.exit(7)", False, check_fake)
    def check_timeout(result,revisions):
        assert result["payload"]["abort"] == "timeout" and result["duration_seconds"] < 12
    run_case("infinite_loop_timeout", "while True: pass", False, check_timeout)
    def check_logs(result,revisions):
        assert result["payload"]["abort"] == "output_limit"
        assert len(result["payload"]["stdout"].encode()) <= limits.log_bytes
    run_case("excessive_logs", "import os\nwhile True: os.write(1,b'x'*8192)", False, check_logs)
    def check_storage(result,revisions):
        assert "No space left on device" in result["payload"]["stderr"]
    run_case("workspace_tmpfs_capacity", "with open('oversized','wb') as f:\n for _ in range(80):f.write(b'x'*1024*1024)", False, check_storage)
    run_case("tmp_tmpfs_capacity", "with open('/tmp/oversized','wb') as f:\n for _ in range(32):f.write(b'x'*1024*1024)", False, check_storage)
    run_case("inode_capacity", "from pathlib import Path\nfor i in range(2000):Path(str(i)).touch()", False, check_storage)
    def check_memory(result,revisions):
        assert result["payload"]["exit_code"] == 137 or not result.get("quiesce")
    run_case("memory_limit", "x=bytearray(512*1024*1024)", False, check_memory)
    def check_pids(result,revisions):
        report=json.loads(result["payload"]["stdout"])
        assert report["created"] < limits.pids and report["error"] == "BlockingIOError"
        if result.get("quiesce"):
            assert result["quiesce"]["remaining"] == []
    run_case("pid_limit", r'''
import subprocess,json
children=[]
try:
    for _ in range(256):
        children.append(subprocess.Popen(['sleep','30'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
except OSError as error:
    print(json.dumps({'created':len(children),'error':type(error).__name__}),flush=True)
''', True, check_pids)
    evidence["accepted"] = all(case["accepted"] for case in evidence["cases"])
    evidence["finished_at_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    evidence["limitations"] = ["Fixture shared snapshot is built into a read-only image; dynamic authorized shared-input staging is Phase4.",
        "No browser integration, model calls, artifact database, user stop UI, or task fencing exists in this spike.",
        "Tests measure one code container with small limits, not two-agent concurrency.",
        "The trusted PID1 supervisor has UID0 and only CAP_KILL; arbitrary code is UID10000 with no effective capabilities."]
    args.output.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps({"accepted":evidence["accepted"],"cases":len(evidence["cases"]),"evidence":str(args.output)}))
    return 0 if evidence["accepted"] else 1


if __name__ == "__main__":
    sys.exit(main())
