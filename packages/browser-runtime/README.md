# Browser runtime (Phase 3)

`DockerBrowserRuntimeFactory` implements the interface in `types.ts`. Construct it with the coordinator data root, a 32-byte installation profile key, the bundled absolute seccomp path, and the application storage reservation callback. Electron wraps the installation key with `safeStorage`; the runtime never writes that key. `status()` and `reconcile()` create no containers. Only the owner's Open browser action should call `launch()`.

Explicit setup from the repository root:

```sh
node packages/browser-runtime/setup.mjs --check
node packages/browser-runtime/setup.mjs --build
```

The build verifies exact pre-existing Phase 0 image IDs before and after use, builds a small tar context, uses `--pull=false --network=none`, and contains COPY instructions only. It does not install dependencies. Missing pinned base images stop setup. The image tags are `agent-workspaces-browser:3` and `agent-workspaces-egress:3`; each launch verifies the protocol/policy labels and pins the inspected immutable image IDs. The app never runs setup automatically.

Each agent has its own internal bridge with `gateway_mode_ipv4=isolated`, one egress proxy bound only to that bridge, and a separate outbound bridge. Browser workers have no bind mounts, Docker socket, published ports, other-agent network, host IPC/PID namespace, or default outbound route. Workers use UID/GID1000, Chromium's sandbox plus reviewed seccomp, dropped capabilities, no-new-privileges, 2 GiB RAM/no extra swap, 256 PIDs, private 512 MiB shared memory, 256 MiB profile tmpfs, 256 MiB transfer tmpfs and 128 MiB `/tmp`. Docker DNS forwarding is disabled in the browser by an unreachable loopback upstream; IPv6 and non-proxied WebRTC UDP are disabled. The external proxy validates every newly resolved address and connects using that checked numeric address. HTTPS is CONNECT with destination checks, without TLS interception.

Resource creation intent is fsynced in `control/browser-runtime` before Docker creation. Cleanup inspects ownership labels derived from the canonical data root and a unique run nonce, resolves an interrupted creation intent if necessary, then removes immutable IDs. A mismatched label or cleanup failure preserves the journal and reports failure. Reconciliation preserves another live process's resources. No global Docker pruning occurs.

Remember logins stores only encrypted bundles at `control/browser-profiles/<agent-id>.enc`, outside model-visible workspaces and artifacts. Chromium closes first; then the worker supplies a regular-file manifest and bounded chunks. The host independently enforces 4096 files, 512-character relative paths, 256 MiB total profile bytes, SHA-256, and a 90-second transfer deadline. AES-256-GCM encrypts both filenames and content, binding the bundle to its agent and data root. A failed checkpoint keeps the previous bundle. Restore authenticates the complete retained file descriptor before releasing any plaintext to the worker, then verifies file hashes and unchanged file identity. No plaintext profile staging file is written on the host. A crash can leave ciphertext staging; startup removes only generated staging files whose recorded process is no longer alive.

Limits: login persistence does not guarantee server sessions, tabs, JavaScript state, passkeys, or all real-provider login flows. A worker crash discards changes since the last successful checkpoint. While the app is unlocked, its trusted main process holds the decrypted installation key. Node filesystem checks do not provide kernel-atomic `openat` protection against a hostile process racing coordinator-owned host directories. Containers do not prove protection against every kernel/browser exploit. TLS destination control cannot authorize external artifact uploads; that is the separate browser-service permission boundary.

Test-only fixture mode is constructor configuration, never renderer input. It creates a shared synthetic site backend and allows only `fixture.agent-workspaces.test` at one exact fixture-container address, ports8080/8443. Production has no private-address allowance. Fixture TLS materials and login fields are synthetic.

Focused verification:

```sh
node_modules/.bin/tsx --test tests/phase3/runtime-profiles.test.ts tests/phase3/runtime-recovery.test.ts tests/phase3/runtime-transport.test.ts
AW_DOCKER_TESTS=1 AW_RUNTIME_EVIDENCE=1 node_modules/.bin/tsx --test tests/phase3/runtime-egress.test.ts
AW_DOCKER_TESTS=1 AW_RUNTIME_EVIDENCE=1 node_modules/.bin/tsx --test tests/phase3/runtime-crash.test.ts
AW_BROWSER_DOCKER_TEST=1 node_modules/.bin/tsx --test tests/phase3/worker-docker.test.ts
```

`evidence/egress.json` records the 44 live external-network checks and successful cleanup. The test reuses the Phase 0 harness without modifying it, against the Phase 3 egress image; production proxy source remains byte-identical. `evidence/process-crash.json` records a true coordinator SIGKILL after browser readiness: two durable journals survived, then startup removed all three owned containers and three networks. The browser worker integration test records sandbox/session/transfer/profile results separately. Fourteen profile, transport and ownership tests pass on host Node and Electron's bundled Node. Pure runtime recovery tests exercise forged journals and foreign labels using an isolated CLI fixture; they do not delete real unrelated Docker resources.
