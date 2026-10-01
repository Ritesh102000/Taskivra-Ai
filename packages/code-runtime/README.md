# Isolated code runtime (Phase 4)

`DockerCodeRuntimeFactory({dataRoot, dockerPath?, image?})` implements `packages/code/runtime.ts`. The default image is `agent-workspaces-code:4`. Construction, `status()` and reconciliation never pull an image or start a job. Each launch resolves the selected local image to an immutable digest and creates one disposable container. A factory admits one preparing/live execution; the coordinator owns the durable global execution claim across tasks.

The host passes only trusted `CodeSeedFile` manifests: area, container-relative path, source path under the canonical data root, expected bytes and SHA-256. Inputs stream through retained, no-follow regular-file descriptors in 64 KiB chunks, with identity and checksum checks. Private workspace input and selected shared input together must fit 512 MiB. No host file paths, database, API keys, Docker socket, browser profiles, or bind mounts enter the job.

Call `launch`, then `handle.run({argv,cwd:'/workspace',signal,onLog})`. The worker creates `inputs`, `work`, and `outputs` directories. Arbitrary Python, Node or shell code runs only as container UID 10000. `run` returns a bounded trusted outcome; stdout/stderr remain untrusted bytes, even if they resemble events or export records. Only a normal zero exit permits `handle.export({destination,signal})`. The destination must already be an empty, coordinator-owned directory under the canonical data root. The host service commits the verified revision before calling `close()`. `stop()` interrupts the whole container and makes later run/export calls fail.

| Default limit | Bound |
| --- | --- |
| Memory / memory+swap | 1 GiB / 1 GiB |
| CPU / PIDs | 1 CPU / 256 |
| Workspace / temporary tmpfs | 512 MiB / 128 MiB |
| Shared tmpfs | Rounded to selected input size, at least 1 MiB, at most 512 MiB |
| Payload wall time / combined retained logs | 120 seconds / 1 MiB |
| Complete regular-file export | 512 MiB, 4096 files, 8192 visited entries, depth 24 |
| Seeding / export transport deadline | 30 seconds per input area / 60 seconds |

Tmpfs consumes the same memory budget as the payload. These are ceilings, not a guarantee that all maxima fit simultaneously. Memory or kernel OOM termination can destroy the supervisor and its tmpfs; that outcome cannot produce a committed revision. Workspace/shared tmpfs inode counts and `/tmp` inode count are bounded. The artifact service independently applies its tighter per-file and approved-directory rules.

The root filesystem is read-only; capabilities are dropped, with one explicit exception: the trusted PID 1 supervisor runs as UID 0 with only `CAP_KILL`. Payload UID 10000 has no effective capabilities, cannot signal the supervisor, and cannot change identity. The supervisor stays alive after payload exit, kills all non-zombie payload-UID descendants, and requires the process set to remain empty before exporting. The broker then runs a fixed read-only image helper as UID 10000 so ordinary 0600 files and 0700 directories remain readable without extra DAC capabilities. This helper checks that it is the sole process using that UID; the handle cannot run another payload. It opens every Linux source component using directory-relative `O_NOFOLLOW`, rejects links/special files, double-checks stable trees and hashes, and sends a separate bounded export stream. Files made unreadable even to their owner fail closed. The TypeScript host independently validates framing, paths, normalization/case collisions, byte/count limits, regular exclusive output files and SHA-256; files and directories are fsynced. Empty directories are recreated from the fixed layout, not persisted as artifacts.

`/shared` is a root-owned tmpfs populated only before payload launch. Files are sealed 0444 and directories 0555. It is **read-only to the payload through ownership and permissions**, rather than a kernel `ro` mount; this avoids granting `CAP_SYS_ADMIN`, extra identities/capabilities, host binds or persistent unbounded volumes. No post-seal shared-write helper is exposed to the payload. A compromised trusted worker or Docker daemon remains outside this boundary.

Before Docker create, the runtime durably records its intent and ownership labels. Cleanup verifies the full owner/run labels and immutable container ID, then removes only that ID. Startup skips live owner PIDs and active in-process instances; abandoned resources are removed. An uncertain Docker create preserves its intent, marks status unavailable and fences admission until successful reconciliation; shutdown reports unresolved uncertainty as incomplete cleanup. If Docker is unavailable, cleanup fails visibly and the journal remains. Node does not expose `openat`; host ancestor checks rely on coordinator-owned directories, as documented by the existing artifact I/O boundary.

## Setup and dependencies

```sh
npm run code:setup
npm run code:check
```

Standard setup verifies the retained Phase 0 image ID `sha256:20d943322762c150371abd5ad8bbc77ba33412dd7f3f0da6ab23bcc9c1a7d3c6`, uses a small whitelisted temporary context, and builds COPY-only with `--pull=false --network=none`. It requires 8 GiB free host disk. The default image supplies Python and Node standard libraries; no additional packages are installed automatically.

An explicit owner-reviewed dependency build can use:

```sh
node packages/code-runtime/setup.mjs --build --recipe containers/code/dependency-example.json --allow-network
```

The checked-in example pins the tiny `six` wheel and its official PyPI SHA-256; it is an example/test recipe, not a default dependency. Python recipes require exact package versions, wheel hashes, and an exact Alpine `py3-pip` bootstrap version. Pip permits wheels only, checks hashes, and requires dependency pins/hashes too. Node recipes specify `node:[{name,version}]` and require matching `package.json` and v3 `package-lock.json` beside the recipe; lock entries need exact registry URLs and integrity hashes. `npm ci` disables install scripts, audit and funding. Both installers run in Docker build only and verify the resulting direct package versions before image labels advertise them. Payload jobs keep network disabled. Python uses `/opt/code-venv`; CommonJS Node imports use `/opt/code-node/node_modules` through `NODE_PATH`. Node ESM bare-package resolution does not use `NODE_PATH`; use CommonJS `require` or an explicitly resolved module path.

An optional final `--tag agent-workspaces-code:<version>` builds/checks a separate version. Runtime `status()` re-resolves the configured tag, so a rebuilt default is available to the next job without restarting; existing jobs retain their original digest. Re-running standard `code:setup` returns the default tag to standard libraries. The retained image digest is the reproducibility boundary: Alpine bootstrap transitive packages are not vendored, and a future repository change can require a refreshed reviewed recipe.

Reference behavior: [Docker runtime constraints](https://docs.docker.com/engine/containers/run/), [tmpfs limits](https://docs.docker.com/engine/storage/tmpfs/), [pip hash-checked installs](https://pip.pypa.io/en/stable/topics/secure-installs/), [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/), [six 1.17.0 metadata](https://pypi.org/pypi/six/1.17.0/json).

## Verification

```sh
npx tsx --test tests/phase4/runtime.test.ts
AW_CODE_DOCKER_TEST=1 npx tsx --test --test-concurrency=1 tests/phase4/runtime-docker.test.ts tests/phase4/runtime-recovery.test.ts
AW_CODE_DOCKER_TEST=1 npx tsx --test --test-concurrency=1 tests/phase4/runtime-boundaries.test.ts tests/phase4/runtime-permissions.test.ts
# Explicit small network-enabled dependency build test; default image remains unchanged:
AW_CODE_DEPENDENCY_TEST=1 npx tsx --test tests/phase4/runtime-dependency.test.ts
```

Live tests use small limits and synthetic files. Evidence is written under `evidence/`, including image/source identities. They cover Python/Node exact output hashes, payload UID/capabilities, no network/host/browser/socket access, sealed shared writes, quiesced detached processes, restrictive file permissions, links/special files/case collisions, timeout/log/memory/file/inode/PID limits, Stop, forged control logs, actual coordinator SIGKILL, startup cleanup, preservation of another live factory's worker, 72 MiB streamed export, and cancellation during launch/export. The separate opt-in dependency test builds tiny hashed Python and locked Node dependencies, imports them with network disabled, and proves a bad hash preserves the previous image. No model or browser execution is needed.
