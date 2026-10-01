# Trusted code worker

The entrypoint is `python3 -I /opt/agent-code/supervisor.py init`, launched only by `packages/code-runtime`. This PID 1 is a trusted UID 0 helper with only `CAP_KILL`; arbitrary payloads run separately through Docker exec as UID 10000. The default Docker seccomp policy remains enabled.

`seed.py workspace <maxFiles> <maxBytes>` runs as UID 10000 before any payload exists. `seed.py shared ...` runs as UID 0 and seals its root-owned tree after accepting the same framed regular-file stream. The trusted caller must not invoke a seed helper again once payload execution begins. There is no socket or model-facing helper API inside the container.

`supervisor.py quiesce` kills all remaining payload-UID processes. Only after its successful response does the broker start the fixed `exporter.py <maxFiles> <maxBytes>` as UID 10000. That trusted reader verifies it is the sole process with this UID and reads ordinary 0600 files/0700 directories without extra capabilities. Arbitrary payload execution cannot resume on the same handle. It exports `/workspace` through a separate channel. An export header is a 4-byte big-endian length followed by bounded JSON; each file record is followed by exact raw bytes. A final count/byte record is mandatory. Logs never share this channel. Exporters reject symlinks, hardlinks, device files, FIFOs, sockets, path collisions, changing files, and a changing final tree.

The host independently validates the export and owns durable commit. Never put commit credentials, host paths, workspace pointers, database access or a Docker socket into this image. Keep the supervisor alive until host commit or failure; only the trusted runtime tears down the container. A killed or OOM container cannot export its former tmpfs.

For the exact limits, permission-sealed shared exception, resource journal, build recipe and verification commands, see `packages/code-runtime/README.md`.
