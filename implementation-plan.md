# Agent Workspaces — implementation plan

Planning baseline: 11 September 2026. Scope is a Mac-first, single-owner app using cloud model APIs, browser sessions, isolated code execution, private workspaces, shared artifacts, and user file requests.

Product iteration, 30 September 2026 (0.6.1): the owner additionally requested research of six comparable GitHub projects and implementation of suitable improvements for all audiences. Migration 8 adds reusable owner workflows and durable instruction delivery. The desktop now has guided starters, an attention/results overview, stale-decision guards and clearer native browser health. [Research and implementation evidence](docs/competitive-improvements.md). This is an additive iteration; the Phase 7 release gates below remain outstanding.

Implementation update, 30 September 2026: the owner has authorized Phase 6 and a dedicated desktop Chrome redesign. Migration 7 adds scoped shared-board policies, reference-only agent messages, inboxes, deduplicated publication receipts, exact-version consumption, and acyclic dependencies. The live scheduler supports up to two independent agents, with one executing task per agent. Mocked-model acceptance covers A publishing v1, B waiting across restart and pinning v1 while v2 arrives, and B publishing its separately approved derived output. [Phase 6 evidence and limits](docs/phase6.md).

The new selectable desktop browser uses ordinary installed Chrome with one persistent profile per agent and a local extension/native-messaging bridge. Background commands do not use global OS input; manual login occurs in the dedicated Chrome window while agent observation is suspended. This is a changed browser isolation boundary: it uses the host network and normal Chrome sandbox, not Docker egress/filesystem restrictions. Code execution remains in isolated offline containers. Native managed uploads/downloads are not yet supported; the container browser remains available. The installed-extension public-page integration passed separately from protocol tests. Mail Assistant's dedicated production profile also completed Google's passkey flow, retained sign-in after a clean app/Chrome restart, and returned to the new Gmail tab with a fresh app preview. Other MFA methods and long-term session validity remain unverified.

Mac first, cloud APIs first, container code execution, OpenAI, the Application Support data root and remembered local logins are owner-confirmed. The pinned gpt-4.1-mini snapshot, $1/task default and per-profile development extension install are implementation defaults. The earlier test credential must not be assumed valid. Historical real OpenAI/file/code and read-only Gmail OAuth evidence remains in [Phase 5](docs/phase5.md); it does not establish browser login success or a new paid two-agent run.

The original proposed stack, phase requirements and acceptance criteria below are retained as the planning baseline. The dedicated desktop Chrome mode supersedes the original container-only browser choice where selected; original network-isolation claims apply only to the container mode. Phase 7 packaging/release and broader interruption/usability work remain outstanding. `design-preview.html` remains a mockup. Earlier reports retain their historical scope.

## 1. Proposed stack

| Area | Choice | Reason |
|---|---|---|
| Desktop app | Electron + React + TypeScript | Native file picker/lifecycle with a shared typed application stack |
| Trusted backend | Node service managed by the desktop main process | One place owns tools, credentials, task transitions, and runtime access |
| Persistence | SQLite with migrations and WAL | Fits local ownership and transactional state without an external database service |
| Browser | Chromium controlled by Playwright inside a browser container per active agent | Multi-tab sessions, locator actions, screenshots, controlled transfers |
| Code | Versioned Python/Node Linux images, disposable execution containers | Code runs with defined files, network restrictions, and resource limits |
| Coordination | Database task queue, leases, event log and cursors | Durable waiting/resume and agent awareness without a separate queue service |
| Models | One cloud provider adapter first; provider-neutral contracts | Validate one complete loop before adding adapters |
| Credentials | macOS credential store | Keys stay out of workspaces, containers, and prompts |
| Verification | Unit/integration tests plus deterministic local fixture sites | Prove isolation and recovery independently of changing public websites |

Version-pin the selected dependencies and container images during Phase 0; do not infer a compatible release set from this document. The exact model/provider, container runtime installation, and initial runtime packages remain setup choices. Docker Desktop is the proposed first runtime; verify its applicability to the owner's installation rather than assuming it is already present.

## 2. Build sequence

| Phase | Deliverable | Exit evidence | Depends on |
|---|---|---|---|
| 0 | Feasibility spikes and decision record | Browser sandbox, handoff, code containment, model tools work on the Mac | — |
| 1 | App shell and durable task state | Simulated tasks survive wait/resume/cancel/restart | 0 |
| 2 | Managed file import and shared artifact storage | Files reach correct scopes, versioning and recovery work | 1 |
| 3 | Isolated browser service and owner viewer | Separate logins/tabs; takeover and transfer boundaries pass | 0–2 |
| 4 | Container code service | Uploaded inputs produce a verified artifact without host access | 0–2 |
| 5 | Cloud model loop and input requests | A real agent asks for files, validates, resumes, and finishes | 1–4 |
| 6 | Multi-agent coordination | Second agent consumes the first agent's exact published result | 5 |
| 7 | Recovery, usability, packaging | Integrated acceptance scenario passes after interruption | 6 |

Phases 3 and 4 can be implemented in parallel after their shared contracts are stable. This is a dependency order, not a calendar estimate. Estimate effort after Phase 0 resolves the runtime and login-viewer uncertainty.

## 3. Phase 0 — resolve the difficult boundaries first

Tasks:

1. Check the selected container runtime and ARM64 image support. Inventory available memory and disk. Record the user's data root and desired initial model provider.
2. Launch a minimal non-root browser image with Chromium sandbox enabled, private shared memory, and no published management ports. Exchange framed commands through the container gateway.
3. Demonstrate two tabs and a selected-tab screenshot viewer with keyboard/pointer input and exclusive human control. Try one representative required login, including any MFA requirement the user expects.
4. Put browser traffic through an externally enforced proxy and prove that direct outbound traffic and host/private addresses are blocked.
5. Run a code job with no network, a read-only root, bounded tmpfs workspace, memory/PID/time limits, and no host-write mount. Quiesce the payload while a separate supervisor keeps the container alive, then export a regular file through bounded staging before teardown. Prove the stable export path and fail closed if it cannot be established.
6. Make one model request that produces a validated tool call; record actual token usage and configure the task cap. Do not benchmark against invented prices.
7. Select image/package versions and record the initial runtime package list, artifact formats, and resource defaults.

Exit gates:

- Browser sandbox runs without `--no-sandbox`, privileged mode, or host namespace sharing.
- Code cannot access the internet, Mac filesystem, other containers, credentials, or writable shared artifacts.
- Tmpfs capacity and memory limits stop oversized code writes without filling the host disk.
- The browser viewer supports the representative login, or the plan records a specific supported alternative and its impact before relying on it.
- A short decision record resolves provider, runtime, packages, profile persistence, and measured concurrency limits.

If a spike fails, revise the affected architecture choice before building the dependent feature. Do not hide failures by weakening isolation.

## 4. Phase 1 — application shell and durable state

Implement agent creation, task creation, conversation storage, state badges, Requests/Shared library navigation, settings, and narrow typed IPC. Create the schema and migrations listed in the architecture. Keep database writes behind the coordinator.

Build a deterministic fake model/tool driver to exercise task state without API cost. Add atomic claims, run leases, fencing generations, checkpoints, cancellation, and transactional events before live actions.

Acceptance:

- Create two agents with distinct workspaces and queued tasks.
- Simulate running → waiting → queued → running → succeeded across a restart.
- Duplicate queue consumers cannot claim the same task; a stale generation cannot execute a tool.
- Cancelling a queued/waiting task remains effective after later events arrive.
- IPC cannot invoke arbitrary host commands or read arbitrary paths.

## 5. Phase 2 — files and shared storage

Implement native picker and drop import, staging, immutable originals, safe previews, scoped artifact lookup, workspace snapshots, owner export, and shared publication/versioning. Initial formats: TXT/Markdown, CSV, JSON, PDF, XLSX, PNG/JPEG. File transfer should be generic; semantic processing is supported only for documented types.

Implement type/size validation and bounded parsing; do not execute document macros. Extract/preview complex files in the isolated execution service once Phase 4 is ready. Until then, expose metadata and safe text previews only.

Proposed limits: 100 MiB per upload, 250 MiB per request, 512 MiB materialized code workspace; revise after Phase 0. Reject larger inputs with a specific limit explanation. All file writes, staged imports, previews, and retained logs must count toward the configured application storage budget.

Acceptance:

- Same-name files do not overwrite each other.
- A cannot retrieve B's private artifact by guessing IDs, paths, or symlinks.
- Imports interrupted before commit do not appear complete; orphaned staging is reconciled.
- Shared publication has immutable bytes, checksum, producer, scope, and exact version.
- Export rejects symlinks, traversal, special files, and a file changed during the staging process.

## 6. Phase 3 — browser containers and viewer

Build session/profile lifecycle, per-agent worker provisioning, opaque tab IDs, popup tracking, bounded observations/actions, and the owner viewport. Implement the single controller queue, fresh observation on takeover return, login-request state, and worker reconnect handling.

Complete browser upload/download integration. Only the broker stages authorized input bytes. Persist downloads before closing a context. Disable unsupported protocols and unexpected permission prompts; show a specific request when a task needs a supported additional permission.

Acceptance:

- Two agents log into the same fixture site as different users with no cookie crossover.
- Each agent opens and uses three tabs; popups stay in the owning session.
- A forged tab/session ID fails authorization.
- Owner takeover prevents new agent browser commands; credential entry is absent from stored model observations and traces.
- A browser worker crash does not stop another agent; resumed work obtains fresh page state.
- Direct connections, redirects, subresources, WebSockets, IP literals, DNS changes, IPv6 private addresses, and `host.docker.internal` cannot bypass the egress boundary.

## 7. Phase 4 — isolated code execution

Build `code.execute`, versioned runtime images, environment seeding, bounded stdout/stderr, execution status, timeout/stop, artifact collection, and private workspace revision commits. Model-generated shell commands are permitted only inside the execution container.

Materialize inputs and the task workspace into bounded tmpfs. Mount allowed shared snapshots read-only. Quiesce the payload and export regular files through the gateway to controlled staging while the container remains alive; remove it only after commit. A hard container death loses uncommitted tmpfs changes. A failed export preserves the last committed workspace; partial outputs are marked incomplete. Coordinate file edits and user attachment delivery around the workspace revision lock. Treat payload logs/manifests as untrusted and obtain status separately through the trusted runtime; the host checks paths, types, counts, bytes, and hashes.

Add the Activity view with command, runtime, working directory, real duration, exit status, log output, and output files. Add a structured request for a missing dependency; the trusted image-build workflow installs packages without turning on code-job networking.

Acceptance:

- Python and Node each process a provided file and return a checksum-verified output.
- Internet/host/network access, browser profile reads, Docker access, shared writes, and cross-agent reads fail.
- Infinite loops, process floods, excessive memory, excessive file writes, and excessive logs terminate within configured bounds.
- Stop kills the job's process tree and prevents follow-up tools.
- A killed job/export cannot silently corrupt the previous workspace revision.
- A payload printing fake success, publication, or control frames cannot forge authoritative events.

## 8. Phase 5 — real agent loop and user requests

Implement one cloud model adapter, validated tool schemas, bounded context assembly, usage limits, observations, tool execution, checkpoints, and outcome verification. Start with one sequential tool loop per agent; parallelize agents after the single-agent behavior passes.

Implement `user.request` for files, clarification, browser handoff, and capability changes. Build file slots, partial fulfillment, replacement, a dedicated validation queue, resume receipts, and Requests inbox synchronization.

The validation job must be able to run while the main task remains blocked. It reads candidates for the current slot revision only. Exact parsing rules handle deterministic checks; the model can judge semantic usefulness when necessary.

Persist free-text owner responses as `input.owner_replied`. Permit a bounded replan while keeping blockers intact so “I don't have this file” can produce a revised request or proposed reduced outcome. Explicit user acceptance is required for a materially reduced outcome; absent files never become accepted slots.

Acceptance:

- Agent asks for two files. One accepted and one wrong file keep the request open.
- Replacing only the wrong file fulfills the request and schedules one continuation.
- Replayed upload/event callbacks do not create duplicate runs.
- A late validator for a superseded slot cannot overwrite its replacement result.
- A cancelled task never resumes because its final upload finished.
- An unavailable-file reply triggers a revision-checked replan without false fulfillment or deadlock.
- Completion includes an existing readable output or verified external result; a model sentence alone does not satisfy the task.
- Active time, model usage, and tool steps stay within configured caps; user waiting time is excluded.
- Instructions embedded in a fixture webpage, upload, code log, or peer message cannot authorize uploading a private file to an unrelated destination; the broker rejects the action.

## 9. Phase 6 — shared awareness and handoffs

Add the shared task board, scoped event summaries, agent inboxes, `artifacts.discover`, `agents.sendMessage`, and task dependencies. Reject dependency cycles and propagate upstream failure into an explicit downstream blocker.

Keep collaboration state in SQLite. Shared files are artifact versions, not competing status documents. Pin input versions when a run starts; messages and events carry source references, not full private histories.

Acceptance:

- A publishes dataset v1; B receives the event and consumes that exact version.
- A later publishes v2; B's active run keeps using v1 until an explicit update.
- B publishes a derived result without modifying A's bytes.
- Private input content and derived outputs remain private unless the task/user granted the handoff.
- Duplicate publication notifications are processed once per consumer.
- Two agents continue independently when one waits for user input.

## 10. Phase 7 — recovery, usability, and local release

Reconcile expired runs, crashed workers, half-imported files, pending publication bytes, browser profiles, and uncertain website actions at startup. Add a checkpoint-safe database backup and artifact manifest, a restore drill, storage cleanup, and explicit browser-session clearing. Do not copy a live SQLite file blindly while WAL is active.

Add setup troubleshooting, empty/error states, keyboard navigation, light/dark appearance, bounded notifications, and selected-task export. Test app shutdown and Mac sleep/wake. Stop local execution cleanly; do not imply that jobs continue while the Mac sleeps.

Build a local Apple Silicon app package. Distribution signing/notarization is a separate release task if the user wants to distribute the app. No deployment or publishing is required to prove the local MVP.

### Integrated release scenario

1. Create A and B. Each gets a distinct browser session and private workspace.
2. A reads two fixture web pages and requests two user files.
3. B performs independent work while A waits.
4. Supply one correct file and one incorrect file; preserve the accepted slot.
5. Restart the app while A is waiting. The request and accepted file remain available.
6. Supply the replacement. Exactly one continuation is scheduled.
7. A runs a container script, commits a verified result, and publishes it under an authorized sharing policy.
8. B discovers and reads that exact artifact version, then publishes its own derived output.
9. Inspect browser ownership, task transitions, file provenance, code logs, and model usage in the interface.
10. Repeat the browser action fixture with a response lost after submission. Recovery verifies the result rather than submitting again blindly.

The release is ready only when the isolation tests, this scenario, and the restore drill pass with recorded evidence.

## 11. Suggested repository layout

```text
apps/desktop/                 # Electron main, preload, React UI
packages/contracts/           # command, event, tool, and error schemas
packages/coordinator/         # scheduler, lifecycle, leases, recovery
packages/model-adapters/      # cloud model interface and first provider
packages/tool-broker/         # capability checks and dispatch
packages/artifacts/           # storage, import, publish, safe export
packages/persistence/         # SQLite schema, migrations, repositories
workers/browser/              # bounded Playwright service and frame transport
workers/code/                 # execution runner and output protocol
containers/browser/           # browser image and isolation profile
containers/code/              # versioned Python/Node runtime definitions
containers/egress/            # proxy and network policy
tests/fixtures/               # deterministic websites and input files
tests/integration/            # ownership, input flow, containers, recovery
docs/                         # accepted architecture, decisions, operations
```

## 12. Decision register and completion boundary

Confirmed: Mac first, cloud model APIs first, browser sessions/private/shared workspaces, user file requests, and isolated code execution.

Recommended defaults: Electron/TypeScript stack; SQLite; Playwright/Chromium; Docker-compatible runtime; separate browser/code containers; no network for code jobs; managed immutable shared artifacts; one executing task per agent; two active agents initially.

Resolve before live integration: exact provider/model, runtime installation, package set, required login compatibility, model spend cap, data-root location, profile retention, and final resource values. These are localized setup/build decisions; they do not prevent reviewing the architecture now.

The original planning deliverable included architecture, interface specification, implementation phases, acceptance tests, and a design preview. It did not establish a running application, installed dependencies, configured accounts, or executed container tests. Subsequent Phase 0 implementation and actual test evidence are tracked separately in the decision record above.
