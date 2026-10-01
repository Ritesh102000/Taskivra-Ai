# Phase 0 code containment spike

This is an isolated feasibility runner, not the application or Phase 4 service.
The Mac runs trusted gateway and validation code only. Python/Node payloads run
inside disposable Linux ARM64 containers.

## Reproduce

From the repository root, using a running Docker-compatible ARM64 runtime:

```sh
python3 -m unittest discover -s tests/phase0 -p 'code_export_test.py' -v
python3 tests/phase0/code_integration.py
python3 spikes/phase0/code/runner.py
```

The runner requires the existing image; it never implicitly pulls one. Building
is a deliberate setup action. Verify at least 8 GiB free host disk beforehand:

```sh
docker build --platform linux/arm64 --build-arg PYTHON_APK_VERSION=3.12.14-r0 -t agent-workspaces-phase0-code:2026-09-11 spikes/phase0/code
```

The base is pinned to the ARM64 manifest of Node 24.14.0 / Alpine 3.23. Python's
top-level APK is pinned to 3.12.14-r0. `evidence/image.json` records the produced
immutable image ID and complete installed package versions. The gateway resolves
the local tag to that immutable ID before creating a job. Transitive APK archives
are not vendored; future byte-identical rebuilding needs a retained package
repository snapshot or image archive. Initial payload packages are Python's and
Node's standard libraries. No pip/npm packages or document parsers are added.

## Boundary and lifecycle

1. Create a labeled container with no network, read-only root, private IPC,
   no published ports, no host mounts, no secrets, a memory/swap ceiling, CPU/PID
   limits, and bounded tmpfs `/workspace` and `/tmp` including inode limits.
2. A trusted PID 1 Python supervisor runs as UID 0 with **only CAP_KILL**. This is
   an explicit narrow exception to the general non-root recommendation: it can
   reap or kill payload processes without sharing their identity. It has no
   Docker socket, writable host mount, network, DAC override, SETUID, SETGID,
   SYS_ADMIN, or debugger endpoint. Its program and imports are on read-only root.
3. The runtime launches each payload through `docker exec --user 10000:10000`,
   with a cleared environment, zero effective capabilities and
   `no-new-privileges`. The payload cannot signal or overwrite its supervisor.
   A fixed approved shared fixture is baked into read-only `/shared`; dynamic
   shared-snapshot staging belongs to Phase 4.
4. The host takes the payload exit status from the runtime exec channel and
   bounds stdout/stderr separately from the trusted export channel. A timeout or
   log overflow kills the exact owned container, losing only uncommitted tmpfs.
5. After payload exit, a trusted helper repeatedly kills all live processes with
   the payload UID, including detached descendants, then verifies that none
   remain. PID 1 keeps tmpfs alive and reaps orphaned children. Failure to obtain
   quiescence prevents export; teardown kills the remaining container.
6. The trusted exporter rejects links, special files, unsafe paths and changed
   files using component-by-component no-follow opens, identity checks, and
   before/after hashes. It streams regular files in a bounded framed protocol.
7. The host independently validates framing, paths, collisions, counts, bytes,
   and SHA-256, writes private staging, and atomically replaces a revision
   pointer only after receiving a complete validated end record. On failure the
   previous pointer and bytes remain. Filesystem/database crash reconciliation
   and durable storage quotas are later-phase work; no database is created here.
8. Remove only the exact container whose ownership label matches its generated
   name. No image pruning, unrelated container cleanup, or host data removal.

Payloads cannot declare publication or status by printing JSON or control frames.
This spike commits local workspace files only; it has no artifact-publishing API.

## Actual evidence

On 11 September 2026 the recorded suite passed **16 host export tests** and
**16 real Docker containment cases**. See `evidence/integration.json` and
`evidence/image.json` for actual timestamps, image ID, controls and measurements.

The Docker cases cover Python/Node input-to-output, UID/capability/environment and
network boundaries, immutable shared/root paths, detached descendant quiescence,
symlink/hardlink/FIFO rejection, hard container death, fake-success logs, runaway
CPU timeout, log overflow, workspace/tmpfs byte and inode limits, memory pressure,
and process pressure. Every case removes its own container. Negative cases pass
only when failure is contained and the previous revision remains unchanged.

The small integration profile is 256 MiB RAM, 32 MiB workspace, 16 MiB temporary
storage, 64 PIDs, 4 seconds, 64 KiB logs, 256 export files and 8 MiB export bytes.
The separate smoke run used the planning defaults (1 GiB RAM, 512/128 MiB tmpfs,
256 PIDs, 120 seconds). These are measured containment settings, not a throughput
or two-agent concurrency recommendation. On this Docker kernel, inactive tunnel
interfaces are visible even with network mode `none`; only loopback is UP,
there are no IPv4 routes, and external/private/gateway connection probes fail.

Still unproved here: a stop UI/task fence, dynamic shared input grants,
cross-service integration, application crash recovery, document package support,
Mac sleep/wake behavior, and sustained simultaneous browser/code workloads.

## References

- [Docker run isolation and resource controls](https://docs.docker.com/engine/containers/run/)
- [Docker tmpfs lifecycle](https://docs.docker.com/engine/storage/tmpfs/)
- [Docker network none](https://docs.docker.com/engine/network/drivers/none/)
- [Official Node image](https://hub.docker.com/_/node)
