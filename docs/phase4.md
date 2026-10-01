# Phase 4 — isolated code execution

Implementation record, 11 September 2026. Phase 4 adds real, explicitly started
Python, Node.js and shell execution to the Mac app. Files, browser sessions and
code jobs are real; the task driver remains a labeled local simulation. No model
API is connected by this phase. The planning baseline remains unchanged.

## Owner workflow

Open a task's **Activity** panel and choose **Run code**. Select the runtime,
enter a script, choose a timeout, and select exact file versions already attached
to that task. The dialog shows their container paths and visibility. The script
is saved in execution history; it is not a credentials channel. **Run in
container** creates a disposable execution container. Opening the app, reading
status and opening the dialog do not start a job or download an image.

The working directory is `/workspace`. Private selected inputs are available
under `/workspace/inputs/<versionId>/content<extension>`; selected shared inputs
are available under `/shared/<versionId>/content<extension>` and are read-only to
the payload. Write deliverables under `outputs/` and intermediate progress under
`work/`. A later execution receives the previous committed work/output tree and
its newly selected exact inputs. Source scripts and mutable input copies from
an earlier execution are not silently reused as new inputs.

Activity displays the actual command, runtime image digest, execution status,
duration, exit code, bounded stdout/stderr, exact input bindings, saved outputs
and workspace revision. A successful process exit and a saved workspace are
separate facts. Export or integrity failure preserves the previous revision and
shows that new changes were not committed. Output **Preview** opens the existing
safe text/metadata file dialog. Outputs are private immutable versions with
execution/input provenance; sharing still requires explicit **Publish**.

**Stop execution** fences the run and stops its container. Late launch or export
results cannot commit afterward. Task **Pause** and **Stop** also stop active
code; task Stop leaves the task cancelled. A manually started execution
suppresses the task simulation while it owns the task and leaves the task paused
for owner review when finished. A successful script does not claim that the
simulated task's objective is complete. Starting another manual execution is
explicit, and open blocking requests must be resolved first.

## Components and trust boundaries

| Component | Responsibility |
|---|---|
| Renderer Activity / preload bridge | Owner forms, current status and bounded plain-text logs; typed commands only |
| `packages/code` | Command validation, authenticated run/lease fencing, one global code-job admission, task transitions, dependency requests and authoritative execution records |
| `packages/code-runtime` | Image digest pinning, resource creation journal, checked seed/export transport, timeouts, whole-container stop and owned-resource recovery |
| `workers/code` | Trusted supervisor, unprivileged payload, descendant quiescence and regular-file export |
| `packages/artifacts` | Exact-version permissions, durable workspace lease, checksummed staging, atomic revision/output receipts and queued attachment delivery |
| SQLite schema 4 | Code executions, dependency metadata, workspace revision history, head/lease and pending task file deliveries |

Only the trusted Electron main frame can call the code IPC channel. The renderer
receives no host shell, arbitrary filesystem, Docker socket or container-control
API. Internal agent execution requires an authenticated current claim. It cannot
override the task identity or add a later attachment to the claim's already
pinned inputs. The real model loop that will use this entry point remains
Phase 5.

The container has `network=none`, a read-only root filesystem, bounded tmpfs,
no host bind mounts, no browser profile or model credentials, and Docker's
normal seccomp policy. The trusted PID 1 supervisor runs as UID 0 with only
`CAP_KILL`; the payload runs as UID 10000 with no effective capabilities.
The supervisor kills remaining payload descendants and verifies quiescence
before export. A fixed trusted reader then runs as UID 10000 so ordinary `0600`
files and `0700` directories remain readable without extra capabilities. It
verifies it is the sole process using that identity; no further payload launch is
allowed. The supervisor stays alive while files are verified and committed.

The selected shared subset is copied into root-owned, sealed files and
directories. This is read-only to the payload through ownership and permissions,
not a kernel `ro` mount. This implementation avoids granting `CAP_SYS_ADMIN` or
mounting host/shared-library storage. A compromised trusted worker, Docker daemon
or hostile Mac process is outside this boundary. The runtime and artifact
reports describe the remaining host path-race limitations.

Process logs and exported manifests are untrusted. A printed success, publication
or control frame cannot change the authoritative outcome or create a shared
artifact. The runtime supplies status separately; the host independently
validates export framing, regular-file type, paths, counts, byte sizes and
SHA-256. A failed or killed job never commits a partial revision.

## Files and recovery

The code working tree has separate revision history from Phase 2's immutable
input snapshots. The artifact journal records filesystem intent before finalizing
bytes. One SQLite transaction commits the verified revision/head, private output
artifacts, exact output bindings and execution receipt. Death before this
transaction preserves the previous revision; death after it retains the committed
bytes even if staging cleanup is interrupted. A cleanup problem is shown
separately from already saved output.

Owner file imports during an execution save the private artifact immediately and
queue task attachment delivery. The running execution's input bindings remain
unchanged. Commit/release and startup retry delivery; none of those steps resumes
a paused or cancelled task. Missing or corrupt committed workspace files block
subsequent seeding instead of silently replacing saved progress.

Runtime resource intent and ownership labels are durable before Docker creation.
Cleanup uses verified immutable container IDs and matching ownership. It preserves
another live factory's worker and performs no global prune. Graceful shutdown and
synchronous abandonment close admission, fence unfinished execution and leave
manual work paused. On process restart, dead-owner resources are reconciled and
uncertain work is not automatically replayed.

See [the artifact boundary](phase4-artifacts.md) and
[the code runtime implementation](../packages/code-runtime/README.md) for detailed
APIs, staging reservations and runtime guarantees.

## Missing dependencies

The owner can request an exact Python or Node registry package from Activity.
A failed command's bounded missing-import text may suggest a request with no
version; it cannot install a package, choose a version, enable networking or
fulfill a request. The same durable request appears in Activity, the task
conversation and Requests inbox. Plain text replies cannot fulfill it.

The owner reviews the package/version and uses the separate trusted image-build
workflow. Python builds require exact versions and wheel hashes; Node builds
require exact versions and matching registry lockfile integrity. Package
installation runs only in an explicitly network-enabled Docker build. Payload
jobs keep network disabled. See the runtime README for the reviewed recipe
schema and CommonJS/ESM module-resolution limitation.

**Check installed dependency** refreshes the local image and verifies the package
name and requested version before creating one fulfillment receipt. Python names
use Python's separator normalization; Node registry names remain distinct.
An explicit owner request can pin or replace the version on an existing open
request; this increments its revision so an older check cannot fulfill it.
Repeated versions and checks do not create duplicate requests or receipts, and
paused tasks stay paused.
A rebuilt image is available to the next job without restarting the app; an
existing job retains its original image digest.

## Current implementation defaults

These are implementation limits, not new owner-confirmed requirements or
performance guarantees for arbitrary workloads.

| Boundary | Default |
|---|---|
| Simultaneous code executions | One globally |
| Runtime choices | Python, Node.js, shell; standard-library base image |
| Payload memory / memory+swap | 1 GiB / 1 GiB |
| CPU / process count | One CPU / 256 PIDs |
| Workspace / temporary tmpfs | 512 MiB / 128 MiB |
| Aggregate seed / selected shared subset | 512 MiB aggregate; shared tmpfs sized to selected bytes |
| Script / selected input versions | 64 KiB UTF-8 / 128 exact versions |
| Timeout | Owner chooses 1–120 seconds; form starts at 30 seconds |
| Combined retained stdout/stderr | 1 MiB |
| Complete export | 512 MiB, 4,096 regular files, 100 MiB per file |
| Stored execution records | 250 globally; Activity exposes the latest 25 per task |
| Dependency requests | Eight saved requests per task |
| Application storage | Existing adjustable 2 GiB initial budget, including staging reservations |

Tmpfs and payload memory share the same memory budget; the listed maxima need
not fit simultaneously. Timeout, log, memory, byte, inode and PID exhaustion are
bounded runtime outcomes. Some kernel/resource failures surface as a nonzero
exit instead of a precisely classified resource error. The UI reports the
trusted outcome it receives.

## Setup and verification

Start Docker Desktop, then explicitly prepare the retained Phase 0 base image:

```sh
npm run code:check
npm run code:setup
npm start
```

The standard setup is a COPY-only build using the exact local verified base,
`--pull=false --network=none`, and an 8 GiB free-disk admission check. It does not
silently download a missing base or install extra packages. Dependency builds
are separate explicit owner actions documented in the runtime README.

```sh
npm run typecheck
npm run build
npm run test:phase4
npm run test:phase4:electron
AW_CODE_DOCKER_TEST=1 npx tsx --test --test-concurrency=1 tests/phase4/runtime-docker.test.ts tests/phase4/runtime-recovery.test.ts tests/phase4/runtime-boundaries.test.ts tests/phase4/runtime-permissions.test.ts tests/phase4/service-docker.test.ts
```

Default tests use isolated temporary data and skip opt-in container/dependency
build gates. The explicit dependency-build gate requires build networking and is
run separately as documented in the runtime README.

## Recorded evidence

**Completed:** typecheck and production build; **227 host tests** across Phases
0–4; **186 Electron tests** across Phases 1–4; **7 explicit live Docker/service
tests** and **1 separate dependency-build test**. The default suites skip 13
opt-in integration tests (five browser tests and eight code/build tests). Phase 4
contributes **54 local tests** plus the eight separately exercised container/build
gates. See the [consolidated verification record](phase4/evidence/verification.json).
Native acceptance used real containers with synthetic inputs and an isolated app
data root; no model requests or user files were involved.

| Evidence | Recorded scope |
|---|---|
| [Real runtime](../packages/code-runtime/evidence/verification.json) | Python/Node exact output hashes; payload identity/capabilities; network and filesystem containment; shared-write denial; quiesced descendants; malicious export rejection; timeout/log/memory/file/inode/PID bounds; Stop; fake control logs; exact cleanup |
| [Actual process crash](../packages/code-runtime/evidence/process-crash.json) | Coordinator SIGKILL left the supervisor alive; startup removed the exact owned container |
| [Real service](phase4/evidence/service-docker.json) | Provided-file Python/Node processing, read-only shared input, private output hashes, work restored into revision 2, timeout preserving that revision and explicit Stop preventing follow-up simulation tools |
| Service tests | Real coordinator/SQLite/artifact bytes with controlled runtime: ownership, exact pins, log authority, failure preservation, stop/shutdown races, dependency verification and restart |
| Artifact tests | Filesystem and metadata transaction faults, malicious manifests, exact attachment delivery, lease exclusion and actual child-process SIGKILL before/after commit |
| [Native desktop](phase4/evidence/native-acceptance.json) | Python CSV sum 10 with private preview/provenance; live logs and Stop; full quit/relaunch; Node restored work and verified preserved output, producing 15 in revision 2; dependency request and missing-package error in task, Activity and inbox |
| [Stream boundaries](../packages/code-runtime/evidence/stream-boundaries.json) | 72 MiB verified export; cancellation during export returned no manifest; cancellation during launch removed the owned resource |
| [Dependency build](../packages/code-runtime/evidence/dependencies.json) | Hashed Python `six` 1.17.0 and locked Node `is-number` 7.0.0 imported offline; bad hash rejected; previous/default image retained |

The final recorded runtime/service image is
`sha256:8732abc1579e14403d764735670577887db6e6545eaf741654e361870650a685`.
Native workflow and dependency-build receipts retain their earlier tested image
identities. The final runtime/service gates additionally verified the subsequent
private-permission export and uncertain-create recovery fixes.
Evidence files record the image/source identities actually checked. Future builds
may yield a different image ID; each execution pins the local immutable image it
uses. Resource-exhaustion fixtures use smaller bounds for a finite test, not a
representative throughput benchmark.

## Remaining scope

Phase 4 provides explicit owner execution and a trusted agent-facing service. It
does not connect OpenAI to an autonomous tool loop. The exact cloud model, paid
request/spend policy, full file-slot validation/resume flow and automatic outcome
verification remain Phase 5. Cross-agent task/message collaboration remains
Phase 6.

Complex files still have structural validation and safe text/metadata previews;
the existence of a code runtime does not automatically add PDF/XLSX/image parsing
or rich viewers. An owner can explicitly supply processing code and a reviewed
runtime recipe. Real website/MFA/passkey compatibility, representative combined
browser/code load measurement, artifact/history retention controls and packaged
Mac distribution remain outstanding.
