# Phase 1 — desktop shell and durable state

**Status: Phase 1 implemented and verified on the Mac, 11 September 2026.** The owner requested Phase 1 after reviewing Phase 0. This phase uses a deterministic simulated driver so the desktop and persistence contracts can be verified while the live-model, required-login, profile-retention, and representative-load checks remain open. It does not mark those Phase 0 gates complete.

## Scope

The Electron app creates agents and tasks, stores conversations, displays requests and task states, and provides pause, resume, stop, appearance settings, and simulation controls. Each agent receives a generated private workspace identity and its own managed directory. The Requests inbox and task conversation use the same persisted request.

Only the coordinator writes application state. SQLite uses WAL, foreign keys, transactional migrations, atomic queue claims, per-agent active-run constraints, expiring leases, fencing generations, checkpoints, transactional domain events, and unique resume receipts. Schema for the later artifact, browser, execution, and collaboration services is present; those services are not connected to the shell yet.

The simulated driver advances through recorded local steps. Its clarification scenario asks for a text answer, releases the execution slot, and resumes from saved progress after a valid response. Completion means the simulation finished; no real-world task outcome, imported file, or cloud response is implied.

An active run has a 15-second lease. Graceful exit fences and requeues this coordinator's active work; an abrupt exit is recovered once the old lease expires. Paused tasks stay paused, waiting tasks retain their requests, and cancelled tasks cannot be reactivated by a late reply. A duplicate reply for the same request revision and answer reuses its fulfillment receipt.

Phase 1 keeps at most 100 agents and 250 tasks, with at most 2,000 owner messages, 100 per task, and 4 MiB of owner-message text. The interface receives the latest 500 events; SQLite retains the durable history. These are implementation defaults for the local simulation, not measured container-concurrency guarantees or production retention policy.

## Run locally

```sh
npm ci
npm start
```

`npm start` builds the bundled renderer and main process, then opens the native window. The first Electron invocation downloads the pinned Apple Silicon binary if it is not already cached. The app stores state under the owner-selected `~/Library/Application Support/Agent Workspaces`, with the database in `control/agent-workspaces.sqlite`. Closing the last window quits the app; local simulation does not keep running after exit.

For an isolated developer session:

```sh
AW_DATA_ROOT="$PWD/.test-data/manual" npm start
```

The environment override is a host-side development option. The renderer cannot choose arbitrary paths.

## Dependencies and application boundary

Pinned npm releases: Electron 44.3.0, React/React DOM 19.3.0, TypeScript 7.0.2, Vite 8.3.0, esbuild 0.28.2, and tsx 4.23.13. `package-lock.json` pins the dependency tree. The installed Electron runtime reports Node 24.20.0, Chromium 152.0.7977.78, and SQLite 3.53.4; its built-in `node:sqlite` was verified directly. No separate native SQLite addon is required.

The sandboxed renderer has Node integration disabled and context isolation enabled. Its preload exposes only the typed app command API and a change notification. Commands reject unknown fields, invalid IDs, oversized input, and unsupported operations. IPC verifies both the exact trusted window and its top-level bundled URL. Browser navigation, popup creation, permissions, downloads, and remote shell traffic are denied. Installed renderer assets are served from an explicit in-memory map, without converting request paths into arbitrary filesystem reads.

These controls follow the [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security), [IPC guidance](https://www.electronjs.org/docs/latest/tutorial/ipc), and [custom protocol API](https://www.electronjs.org/docs/latest/api/protocol). Database calls use the [built-in Node SQLite API](https://nodejs.org/api/sqlite.html).

## Verification

```sh
npm run typecheck
npm run build
npm test
npm run test:phase1:electron
```

The additional Electron command runs the same Phase 1 tests under the actual bundled Node/SQLite runtime, including a child process killed with SIGKILL before recovery. Unit and integration suites use temporary data roots and make no model requests or container calls.

Automated verification on 11 September 2026 passed **70 local tests**: 41 existing Phase 0 tests and 29 Phase 1 tests. All 29 Phase 1 tests also passed under Electron 44.3.0's bundled runtime. Coverage includes a real two-process SQLite claim race, SIGKILL/reopen recovery, stale/expired/forged run rejection, waiting across restart, deduplicated continuation, paused blockers, permanent cancellation, transaction rollback injection, independent agent progress, and strict IPC validation. Production npm dependency audit reported no known advisories at that check; this is separate from the runtime boundary evidence.

The actual native window was also exercised with synthetic data in `.test-data/phase1-ui`:

- Created Research and Writer, each with a distinct private workspace using mode `0700`.
- Research waited for clarification while Writer completed independently.
- Quit and reopened the application; the outstanding request and both tasks survived.
- Paused Research, answered its request, verified it stayed paused, then resumed it to completion.
- Stopped a queued third task and verified another manual simulation step could not reactivate it.
- Checked the synchronized Requests inbox, dark appearance, and keyboard work-panel resizing.

The saved test database contains two succeeded tasks, one cancelled task, one fulfilled request, exactly one resume receipt, and zero active runs. SQLite integrity check returned `ok`. Local structured evidence is in `phase1/evidence/native-desktop.json`. These native checks exercised the sandboxed renderer, preload IPC, and coordinator together. Type checking and the bundled application build passed. Test records remain isolated from the owner's main workspace.

## Remaining phases

File import and immutable artifact storage begin in Phase 2. Browser session provisioning and the owner viewer integrate in Phase 3; container execution integrates in Phase 4. Live model tools and full file-slot fulfillment arrive in Phase 5, followed by cross-agent collaboration and release recovery/packaging. Shared-library, browser, and file placeholders are labeled accordingly.
