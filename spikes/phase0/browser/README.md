# Phase 0 browser feasibility

This is a Linux ARM64 browser worker and a small owner viewport for feasibility checks. It is not the Electron application, agent loop, durable scheduler, file service, or completed Phase 3 browser feature.

## What was proved

The [integration evidence](evidence/integration.json) records a real Docker Desktop run on 11 September 2026. Chromium 153.0.8010.12 starts as UID 1000 with a functioning renderer namespace and seccomp sandbox. The framed gateway opens multiple tabs, returns selected-tab JPEGs, accepts pointer/keyboard input, denies forged tabs and stale observations, transfers exclusive control to the owner, completes a synthetic form login, and returns a fresh observation to the agent. Two isolated workers keep their cookies separate. Their fixture snapshots used 208.1 MiB and 171.9 MiB, with 97 and 84 PIDs respectively; these are measured fixture observations, not capacity guarantees or representative browsing benchmarks. A subsequent real viewer check exposed navigation racing the immediate observation after Enter. The [navigation regression](evidence/navigation-regression.json) passed on the corrected image: only observations are retried, and the Enter response itself must identify the coherent account page. No submission is repeated.

The external egress topology and denial evidence are owned by `../egress`. Browser proxy options and Playwright routing are defense in depth. They are not the network boundary. Each worker must use its own Docker internal bridge with gateway mode `isolated`, alongside only its required proxy. The client verifies the network's internal/isolated configuration before launch. The special fixture hostname mapping is enabled only by the explicit test topology.

## Versions and security boundary

- Base: verified ARM64 `node:26.7.0-bookworm-slim` manifest `sha256:2b028cd57303b2761d24173789c85a013558d6cf20e78f51723385f368b6e34d`.
- JavaScript: `playwright-core` **1.63.0**, exact package lock and registry integrity recorded in this directory.
- Browser: Chromium Headless Shell **153.0.8010.12**, Playwright revision **1243**; FFmpeg revision **1011** is an installed browser dependency, not an enabled recording feature.
- Tested image: immutable local ID in the evidence. The gateway resolves the local tag to its inspected image ID and uses `--pull=never` for each session. `evidence/image-packages.txt` records the installed Debian package set. Future rebuilds must recapture the package set and image ID; apt repositories are not frozen snapshots in this feasibility Dockerfile.
- Runtime: non-root UID/GID 1000, read-only root, no capabilities, no-new-privileges, reviewed seccomp, private 512 MiB `/dev/shm`, 2 GiB memory/no extra swap, 2 CPUs, 256 PIDs, 256 MiB temporary profile, 128 MiB temporary filesystem. No host mounts, Docker socket, provider keys, published ports, host PID/network/IPC, or remote automation listener.
- `chromiumSandbox: true` is explicit. Playwright's default `--disable-dev-shm-usage` is removed to actually use the bounded private shared memory. No `--no-sandbox`, `SYS_ADMIN`, `SYS_CHROOT`, privileged mode, or host namespace sharing is used.

The compact custom image installs only Chromium Headless Shell and its dependencies. The stock multi-browser Playwright development image was inspected but not downloaded. Its ARM64 compressed layers total roughly 893 MiB; the custom choice reduced disk demand. A temporary low-disk condition paused large builds; subsequent worker corrections were COPY-only, network-disabled builds from the local image.

## Sandbox evidence and seccomp review

Headless Shell does not implement the `chrome://sandbox` WebUI (`ERR_INVALID_URL`), so startup checks the actual renderer processes. A trusted constant HTML probe starts renderers, then the worker requires every observed renderer to have a different user namespace and PID namespace from the Node worker, an additional seccomp-BPF filter (renderer 2, worker 1), `NoNewPrivs: 1`, and zero effective capabilities. It rejects disabling flags and refuses readiness when attestation fails. The probe closes before accepting public commands. This demonstrates renderer sandboxing; it does not assert that every utility process has a separate Chromium sandbox or that containers defeat all kernel/browser exploits.

`seccomp-upstream.json` comes from the version-tagged [Playwright v1.63.0 source](https://raw.githubusercontent.com/microsoft/playwright/v1.63.0/utils/docker/seccomp_profile.json), SHA-256 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`. The effective `seccomp.json`, SHA-256 `3631248070df5c902743ad87d596aa48fbbb6d9d1c2218d2b2903731a20fa68c`, preserves the default-deny policy and upstream namespace calls. Its reviewed changes are:

1. Remove the unconditional/minimum-kernel `ptrace` allowance. Capability-conditional rules remain inactive because all container capabilities are dropped.
2. Return `ENOSYS` for `clone3`, allowing libc to use `clone` while not granting unconstrained `clone3`.
3. Allow the `chroot` syscall without granting the host `CAP_SYS_CHROOT` capability. Chromium must chroot inside its own user namespace. The stock profile permits chroot only when the container has that capability; the initial real run failed at this boundary. The kernel still enforces capability/namespace checks, and the container's host effective/bounding capabilities remain zero.

The container-level seccomp profile is necessarily broader than each renderer's Chromium filter. It is a reviewed Phase 0 baseline, not a production security certification. See [Playwright Docker guidance](https://playwright.dev/docs/docker) and [Docker seccomp guidance](https://docs.docker.com/engine/security/seccomp/).

## Transport and takeover

Every frame is four-byte unsigned big-endian length followed by UTF-8 JSON. Requests are at most 256 KiB; responses at most 2 MiB; pending work at most 32. Browser actions are serialized. The trusted gateway supplies actor/generation; these fields must never be exposed as model-controlled authorization. The model-side client defaults to `agent`, even after human takeover. No arbitrary evaluate, shell, Playwright object, CDP connection, or file path API exists.

`control.take` immediately increments the generation and enters `transitioning`; queued agent work is fenced while the current action settles. Its sensitive late result is withheld and marked `outcome_unknown`. Human control is announced only after settling. `control.release` increments the generation again and obtains a fresh selected-tab observation. Human input, page frames, and errors containing typed values are not logged; Docker logging is disabled. The owner viewport uses a loopback server, an ephemeral token, strict Host/Origin checks, no-store responses and a restrictive CSP. Keyboard events enter a bounded queue and use the newest observation revision at dispatch.

Failures and timeouts close the transport/capabilities. Cleanup checks a random per-launch label, resolves the owned container's immutable ID, and only then stops it. A name collision cannot authorize stopping another container.

## Run the checks

From the repository root:

```sh
node --test tests/phase0/browser.test.mjs
```

Build the pinned ARM64 image when needed; this setup command downloads the locked JavaScript package, Chromium, and operating-system dependencies:

```sh
docker build --platform linux/arm64 \
  -t agent-workspaces-phase0-browser:1.63.0 spikes/phase0/browser
```

After image setup and [egress fixture provisioning](../egress/README.md), use the per-agent network names returned by that topology:

```sh
BROWSER_NETWORK=<agent-a-isolated-network> \
BROWSER_NETWORK_B=<agent-b-isolated-network> \
node tests/phase0/browser.integration.mjs
```

The second network is optional for a single-worker test. Both networks must be distinct; no images are downloaded by this command. Evidence printed to stdout contains checks, metadata and bounded runtime statistics, not login frames or inputs.

For the owner viewer:

```sh
BROWSER_NETWORK=<agent-isolated-network> \
BROWSER_PROXY_SERVER=http://egress:3128 \
node spikes/phase0/browser/viewer.mjs
```

Open the printed loopback URL with its ephemeral fragment token. Choose **Take control**, enter `http://fixture.agent-workspaces.test:8080`, and use synthetic credentials only. The page is a selected-tab image with forwarded pointer/keyboard input. **Return to agent** clears the owner image. Stop the viewer to discard its profile and remove the worker. No background agent runs in this spike.

## Remaining gates

The owner-required public login and MFA/passkey/native-dialog compatibility remain untested; a synthetic login cannot establish compatibility with a real provider. The user chose to defer that check. Profile storage is intentionally a bounded tmpfs and disappears at stop: durable login restoration, retention/deletion and a disk quota design remain open. Browser uploads/downloads, complete permissions, crash recovery, model context integration, production viewer streaming and durable task control belong to later phases. Two fixture workers are a measured concurrency sample only; combined code/browser load and representative website limits still require measurements.
