# Phase 3 — isolated agent browsers

Implementation record, 11 September 2026. The owner authorized Phase 3 and
confirmed **remember logins locally**. The planning baseline remains unchanged.
The browser service is implemented and its isolated worker/runtime tests pass.
Native desktop login, takeover/return, a new tab, exact file transfers and login
persistence across full app quit/relaunch have also passed on the synthetic
fixture. Real website login, MFA and passkeys remain untested.

## Implemented product flow

An owner opens a browser for a selected agent and task. This explicit action
starts that agent's isolated Chromium worker and proxy; opening the desktop app,
checking runtime status or reconciling saved state does not start containers.
There are at most two active browser sessions and six tabs per session. Pages,
popups and cookies belong to their creating agent. The desktop displays bounded
JPEG frames and tab metadata; remote pages never load as privileged Electron
content.

Take control fences the agent's queued commands immediately and waits for the
current bounded action. The owner can navigate, click, type, paste plain text,
scroll and select an authorized file through the viewer. Owner-entered values
and frames remain in memory and are absent from action/event persistence.
Password input requires the human controller. Returning control invalidates old
references and obtains a fresh agent observation before further agent actions.
Browser generations start from persisted coordinator state, so a restarted
container cannot accept commands from an earlier worker.

A browser-login request creates a durable task blocker and releases/fences its
old run. Returning browser control fulfills the request once, preserving an
owner-paused task and any remaining blockers. A page-reported unsupported
capability can create a bounded clarification request for an alternative;
replying does not grant camera, microphone, location or other permissions.
This is the browser handoff subset of requests. Full file slots, semantic file
acceptance and a real model's request/resume loop remain Phase 5.

## Components and boundaries

`packages/browser` is the coordinator-owned service. It validates agent/task,
session, generation, controller, tab and observation revision before dispatch.
SQLite schema 3 stores session state, sanitized tab metadata, download receipts
and browser tool-call status. Owner actions do not store their text payloads or
frames. Agent tab persistence strips URL query strings and fragments. A lost
action outcome is recorded as uncertain and is never automatically submitted
again.

`packages/browser-runtime` provisions the Docker topology, owns the transport,
and persists encrypted profiles. Each browser has a private isolated internal
bridge, an egress proxy and a separate outbound bridge. The browser has no bind
mount, Docker socket, published control port, other-agent network or host
namespace. Resource creation intent is fsynced before Docker creation; cleanup
requires the data-root ownership label, run nonce and matching immutable IDs.
Startup preserves another live coordinator's resources and removes only its own
dead owner's journaled resources. It never runs global Docker cleanup.
If Docker is unavailable or browser-resource reconciliation fails, files and
tasks remain usable. Browser opening stays blocked until cleanup succeeds.

`workers/browser` exposes framed, schema-limited commands. It provides no eval,
CDP, shell, arbitrary selector, cookie-export or profile API to models or renderer
IPC. Opaque element references preserve node identity and expire on observation,
navigation; stale or removed element handles fail rather than targeting a replacement node. The live Chromium renderer must prove
nested user/PID namespaces, an additional seccomp filter, zero effective
capabilities and no sandbox-disabling flags before launch succeeds.

The external proxy checks destinations and every newly resolved address, then
connects to the checked numeric address. Direct routing and browser DNS
forwarding are blocked. HTTP(S) is supported; exact `about:blank` is allowed only
when creating a blank tab. Chromium permission prompts, service workers, QUIC,
non-proxied WebRTC UDP and browser IPv6 are disabled. HTTPS uses destination
filtering without TLS interception. The tested private fixture allowance is
trusted test configuration and is unavailable through renderer commands.

## File transfer and local login persistence

Upload requires a specific immutable version already pinned to the browser's
task, a current file-input reference and an explicitly confirmed destination
origin. The artifact service stages only that agent's permitted bytes. The
broker transfers ordered chunks; the worker checks size/hash and repeats
generation, reference, revision and origin checks before selecting the file.
Cross-origin form actions and submit-button action overrides are rejected.
Selection makes the bytes available to that page; it does not prove successful
website submission. Page JavaScript can forward selected bytes, so origin checks
are not application-level data-loss prevention.

Downloads retain their creating tab and origin. Only completed downloads are
read through opaque IDs. The host independently hashes their bounded chunks,
imports them as private artifacts with provenance, then acknowledges removal.
Receipts prevent duplicate artifacts if acknowledgement fails after the import
commits. Normal close saves completed downloads first; pending ones are cancelled
and acknowledged before profile checkpointing. Forced termination can lose
uncommitted downloads and reports that limitation.

The confirmed profile policy is to remember logins locally. While active, each
profile exists only in that worker's 256 MiB tmpfs. On normal close Chromium
flushes and exits before the worker constructs a stable regular-file manifest.
The host checks paths, types, counts, sizes and hashes, then atomically replaces
an AES-256-GCM encrypted bundle under `control/browser-profiles`. Both names and
contents are encrypted, with authentication bound to the agent and data root.
There is no plaintext profile staging file on the Mac. A random installation key
is wrapped using Electron `safeStorage` backed by macOS credentials; it is not a
model API key and is not exposed to the renderer.

Restore authenticates the complete encrypted bundle before delivering any
plaintext through broker-only chunks, then verifies file hashes and unchanged
file identity before Chromium starts. A failed checkpoint preserves the previous
bundle. A worker crash loses changes since its last successful checkpoint; saved
cookies do not guarantee that the website still accepts its session. Open pages,
JavaScript state, passkeys, profile export/deletion UX and backup/retention policy
are not established by remembering logins.

## Current implementation limits

These values are implementation defaults, not new owner-confirmed performance
requirements or measured guarantees for arbitrary websites.

| Boundary | Limit |
|---|---|
| Active sessions / tabs | Two browser sessions; six tabs each, including popups |
| Browser container | Non-root, read-only root, dropped capabilities, no-new-privileges; 2 GiB RAM/no additional swap, two CPUs, 256 PIDs, private 512 MiB shared memory |
| Writable temporary storage | Profile 256 MiB; transfers 256 MiB; `/tmp` 128 MiB, separate bounded tmpfs mounts |
| Viewer / observations | 1120×760 viewport; JPEG at most 2 MiB; 16,000 text characters; 150 semantic targets; 160-character labels; agent observations contain no frame |
| Transport / input | 256 KiB requests, 3 MiB responses, 32 pending calls, 8 MiB output queue; 128 KiB transfer chunks; 8,192-character text input |
| Transfers | 100 MiB/file, 32 held transfers, 128 MiB aggregate held-transfer allowance; the tmpfs is the hard partial-download storage bound |
| Retained profile | 256 MiB total, 4,096 regular files, 512-character relative paths; host transfer deadline 90 seconds |
| Host storage | Existing application budget includes retained profiles and reserves checkpoint/upload/download staging before admission |

Containers and the Chromium sandbox do not promise protection against every
kernel or browser exploit. Node's host path checks do not provide kernel-atomic
`openat` traversal against a hostile Mac process changing coordinator-owned
directories. Real websites and combined browser/code concurrency still require
representative load measurement.

## Setup and verification commands

Docker Desktop must already be installed and running. The explicit setup command
requires the exact locally verified Phase 0 browser/code base images. It checks
their immutable identities before and after a small COPY-only build with
`--pull=false --network=none`. Missing bases stop setup; neither setup nor the app
automatically downloads or installs dependencies.

```sh
npm run browser:check
npm run browser:setup
npm start
```

Local tests use temporary data. Container integration is explicit:

```sh
npm run typecheck
npm run build
npm run test:phase3
npm run test:phase3:electron
AW_BROWSER_DOCKER_TEST=1 npx tsx --test tests/phase3/worker-docker.test.ts
AW_BROWSER_DOCKER_TEST=1 npx tsx --test tests/phase3/worker-delay.test.ts
AW_DOCKER_TESTS=1 npx tsx --test tests/phase3/service-docker-input.test.ts
AW_DOCKER_TESTS=1 AW_RUNTIME_EVIDENCE=1 npx tsx --test tests/phase3/runtime-egress.test.ts
AW_DOCKER_TESTS=1 npx tsx --test tests/phase3/runtime-crash.test.ts
```

## Recorded evidence

The final default runs recorded **173 local passes** and **132 Electron passes**,
with zero failures. These overlap: Electron repeats the desktop suites under its
bundled Node and SQLite. Five opt-in Docker gates were skipped in both default
runs and all five passed separately; skipped gates are not counted as passes.

| Suite | Local passes | Electron passes |
|---|---:|---:|
| Phase 0 | 41 | — |
| Phase 1 | 29 | 29 |
| Phase 2 | 61 | 61 |
| Phase 3 | 42 | 42 |
| Total | 173 | 132 |

Phase 3's 42 default tests comprise 20 service tests, eight worker tests and
14 runtime tests: five profile/container-argument tests, five recovery tests and
four transport tests. Its five additional Docker gates are listed below. The
verification logs on this Mac are
[/tmp/aw-all-tests-verified.log](/tmp/aw-all-tests-verified.log) and
[/tmp/aw-electron-tests-verified.log](/tmp/aw-electron-tests-verified.log).

| Check | Verified scope |
|---|---|
| Service unit tests | 20/20: ownership/capacity, task and generation fences, handoff/reply deduplication, paused-task preservation, input/frame exclusion, uncertain outcomes, scoped transfer integrity and shutdown/startup races |
| Worker unit tests | 8/8: bounded framing/method surface, generation/controller fencing, fresh observations, profile paths/hashes, checked transfers, blank-tab restrictions and download cancellation |
| Runtime profile tests | 5/5: ciphertext-only checkpoint/restore, wrong key/agent/tampering rejection before plaintext delivery, failed-checkpoint preservation, manifest bounds and container arguments |
| Runtime recovery tests | 5/5: journaled creation intent, immutable-ID cleanup, foreign/forged ownership refusal, preservation of live owners and cleanup of dead-owner generated staging |
| Runtime transport tests | 4/4: fragmented responses and monotonic generation tracking, oversized-frame quarantine, handshake/replay rejection and suppression of arbitrary worker error text |
| Actual browser workers | Two synthetic identities on one fixture backend; three tabs per agent, popup ownership, renderer sandbox evidence, JPEG bounds, stale/foreign-ID denial, takeover and fresh-agent observation, exact upload/download hashes, encrypted login restart, and peer continuity after killing one worker |
| Delayed owner input | A pointer action after a 250 ms pause on an editable page uses the current frame revision; screenshot capture avoids changing caret styles, and real DOM changes still invalidate old references |
| Actual service owner input | The real browser service accepts owner pointer input followed by queued keyboard input and completes the synthetic login |
| Actual egress | 44/44 external-network regression checks covering HTTP(S), WS/WSS, redirects, subresources, public HTTPS and direct/private/host/DNS bypass attempts; cleanup passed |
| Actual coordinator SIGKILL | Three journaled containers and three networks remained after process death; new-process startup removed all six by matching ownership/IDs |
| Native desktop controls and files | Owner login, takeover/return, a new tab, exact 30-byte file upload, 24-byte download imported into private files and displayed origin provenance passed |
| Native desktop quit/relaunch | Full app quit/relaunch passed. The reopened browser started with a blank tab; navigating to fixture `/account` displayed the same synthetic account without entering credentials again. Login cookies persisted; tabs were intentionally not restored |
| Native Pause | Pause changed the task to Paused, saved the profile, and returned the viewer to its closed state; persisted lifecycle was idle with no controller. No Phase 3 runtime containers or networks remained |
| Native input persistence | Scanned all 54 managed test files after closure: zero plaintext matches for either synthetic input canary; the retained encrypted profile had mode 0600 |

Evidence files: [worker integration](../tests/phase3/evidence/worker-docker.json),
[egress](../packages/browser-runtime/evidence/egress.json), and
[real process crash](../packages/browser-runtime/evidence/process-crash.json),
with the final runtime/image record in
[runtime verification](../packages/browser-runtime/evidence/verification.json)
and native observations in
[native acceptance](phase3/evidence/native-acceptance.json).
The reports omit screenshots, profile bytes and credential input. The worker
suite used synthetic credentials only. The egress suite reuses the established
Phase 0 harness against the Phase 3 image; production proxy source is unchanged.
IPv6 destination classification is checked locally and browser IPv6 is disabled;
this is not a live IPv6-routing compatibility claim.

At the passing worker run, the browser image was
`sha256:b7ca9a018041a5baa7977dd687218aa29053f6b9fa4127f9e59ef8228b8480f0`
and egress was
`sha256:9b3ad76881cfa35e579e63cd071f738a060cafccce7b643d6119be73552e33a4`.
Subsequent reproducible builds can create new image metadata identities; runtime
launches always inspect and pin the local immutable image they actually use.

Service regressions additionally cover task association/capacity, stale-run and
human fences, durable handoff/reply deduplication, paused-task preservation,
input/frame persistence exclusion, uncertain outcomes, exact task-pin upload
authorization, duplicate download acknowledgement and shutdown/startup races.
The native restart result is a separately observed desktop workflow, not inferred
from automated tests. It establishes synthetic-fixture login persistence only;
real websites, MFA and passkeys still require their own compatibility checks.

## Subsequent phases and open gates

The deterministic task driver is still labeled **Simulation**. It does not use a
model to browse or execute code. Phase 3 supplies the real browser service and
trusted agent-facing contracts; it does not turn simulated tasks into live agents.
The isolated code service, execution/output collection and complex file parsing
are Phase 4. The cloud model loop, complete user file-request flow and validated
automatic continuation are Phase 5; multi-agent task collaboration is Phase 6.

The owner-selected provider remains OpenAI, but no exact model or paid model
request has been chosen/executed for this implementation. Model spending limits,
provider-retention preferences, a named required real website/MFA flow and
representative combined-load measurements remain open. Local login persistence
is now a confirmed and implemented choice; it no longer belongs on the list of
unresolved binary profile-policy choices. Deletion/backup controls and packaged
distribution still require later work.
