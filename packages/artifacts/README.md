# Phase 2 managed artifacts

The coordinator owns `ArtifactService` and its SQLite connection. Await
`coordinator.artifacts.ready` before accepting file interactions. This phase
imports real files and publishes real immutable versions while the task driver
remains a simulation. It does not connect models or containers.

## Trusted API

Every file method takes an explicit principal. The native owner bridge supplies
`{ kind: 'owner' }`; renderer commands cannot supply or change that principal.
An internal broker can use `{ kind: 'agent', agentId }` for scoped reads and task
materialization. Agent identity must exist, and private files never cross agents
by guessing a version ID. Native source paths and export destinations are accepted
only through owner-authorized import/export methods, not model tools.

- `importFiles({ principal, target, paths, artifactId? })` returns `{versionIds}`.
  A batch imports atomically. Repeated names create distinct logical artifacts.
  One selected file plus `artifactId` appends a new immutable version; the
  artifact's owner, producer and display name remain stable. The actual selected
  filename is also retained as version provenance.
- `publish({ principal, versionId })` is owner-only. Private publication creates
  a shared copy with a source-version reference. Later private versions publish
  into the same shared logical artifact. Repeating a publication is idempotent.
  Source private bytes and older shared versions remain unchanged.
- `useInTask({ principal, taskId, versionId })` checks the destination agent's
  scope even for the owner. A private file belonging to another agent must first
  be explicitly published. The exact version is bound as an input; a newer
  publication does not replace it.
- `createSnapshot({ principal, taskId })` creates an immutable, checked
  materialization of the task's pinned artifact inputs. These Phase 2 snapshots
  do not capture arbitrary `work/` or `outputs/` code modifications; that belongs
  to the Phase 4 code service. Starting a run separately pins current task inputs
  into `run_artifact_bindings`, so later attachments cannot change that run.
- `preview({ principal, versionId })` verifies managed bytes before returning
  at most 64 KiB of plain text for text, Markdown, CSV or JSON. Other formats show
  metadata only. No HTML, Markdown, scripts, images or document macros execute.
- `exportFile({ principal, versionId, destination })` is owner-only. It verifies
  the source and a sibling temporary copy before exclusively finalizing the
  chosen filename. Existing destinations are preserved; choose an unused name.
- `updateBudget(bytes)`, `reconcile()`, `close()` and `drain()` are trusted
  lifecycle methods. Shutdown calls `close()` to prevent metadata commits, then
  awaits `drain()` for bounded active operations and their owned cleanup.

`all()`, `bindings()`, `snapshots()` and `storage()` expose bounded owner-facing
snapshot metadata. They do not grant a model arbitrary filesystem access.

## File and storage boundaries

- 100 MiB per file, 250 MiB per batch, 32 files per batch, and 512 MiB per
  materialized task snapshot. There are at most 2,000 versions and 2,000 saved
  snapshots in this phase. An empty text file is valid.
- The default application storage budget is 2 GiB. Before allocating staging,
  the service counts regular bytes throughout the data root, including immutable
  artifacts, private snapshots, existing staging, SQLite/WAL and desktop data.
  It reserves new file/snapshot bytes plus conservative metadata headroom. Source
  copies are capped at their captured preflight size and must match it, so a file
  growing between inspection and copying cannot exceed the reservation.
  External export temporary copies also reserve capacity until completion;
  completed owner exports are outside retained application storage. Export
  journals contain no external destination paths or external cleanup rights.
- Settings and IPC accept a 256 MiB–20 GiB budget. The trusted service's wider
  64 MiB–64 GiB range supports isolated tests; it is not exposed by the UI.
  Cached UI usage is refreshed during
  setup and file operations; it is not a filesystem quota or continuous disk
  monitor. Pending operations reserve capacity across coordinator connections.
- Local content detection and bounded structure checks cover TXT/Markdown, CSV,
  JSON, PDF, XLSX, PNG and JPEG. JSON parsing is capped at 1 MiB, nesting depth
  64 and 100,000 structure entries. XLSX validation caps archives at 2,048 entries,
  a 4 MiB directory, 256 MiB expanded data and a 100:1 compression ratio. Spreadsheet
  container checks reject malformed, encrypted and macro-bearing archives,
  but full document semantics and rich previews await isolated execution.
  Unknown binary transfers are supported with metadata-only previews.
- Safe I/O rejects links, special files, traversal, identity changes, oversized
  files and hash mismatches. It opens with no-follow/exclusive flags and compares
  source and ancestor identities around operations. **Node on macOS has no
  `openat` API**: ancestor checks detect replacement but cannot promise atomic
  dirfd traversal against a hostile host process. Managed ancestors therefore
  remain coordinator-owned and are never writable by payload code.

Desktop Chromium's three exact `desktop/Singleton*` bookkeeping symlinks are
counted by their own link length without following them. All other managed
symlinks fail storage validation. Detected corrupt artifacts remain visible as
corrupt metadata; new writes cannot bypass an unsafe storage tree by increasing
the budget. A failed scan retains the last measured usage and emits an event.

## Crash consistency

An operation journal is committed before creating staging. Completed files are
hashed and exclusively finalized; a snapshot directory and its manifest are
finalized together. File data and containing managed directories are fsynced
before the final metadata transaction. That transaction registers versions,
task bindings, the snapshot/head, and events, then marks the operation committed.
It holds no transaction while awaiting file I/O.

Startup removes known abandoned staging and final directories, leaves committed
bytes intact, and detects missing/changed version bytes and snapshot manifests.
SQLite's saved manifest is authoritative: startup verifies the exact serialized
filesystem manifest hash with no-follow bounded I/O, then verifies each input.
It does not parse an untrusted or linked filesystem manifest.
There is no atomic filesystem/SQLite transaction: the journal explicitly covers
both crash points. A fault before metadata commit never creates a ready version
or changes the prior workspace head. A crash after commit preserves the complete
version even if the caller never received the result.

Operations in the same process share a per-data-root asynchronous lock. Recovery
does not remove an in-progress operation owned by a live PID merely because its
lease aged; graceful close marks it abandoned, or process death makes it eligible
for cleanup. Final metadata commit also checks operation identity and state.
The Electron single-instance lock prevents competing application writers.

Owner exports use a temporary sibling in the chosen external directory. A hard
process kill during export can leave that hidden UUID-named temporary file for
owner cleanup; it cannot expose a partial completed destination or overwrite an
existing file. Managed import and snapshot staging are journal-reconciled.

## Evidence

```sh
npx tsx --test tests/phase2/artifacts.test.ts
```

The service tests cover distinct duplicate names; private scope enforcement;
publication/version provenance; active-run input pinning; shared version updates;
bounded previews; whole-batch rejection; injected faults before and after metadata
commit; normal restart cleanup; missing/corrupt/symlinked managed data; file/batch
limits; storage accounting including external export reservations; exclusive
owner exports; linked/oversized snapshot manifests; migration from schema 1;
source growth after preflight; prior snapshot preservation; shutdown fencing;
and live-owner reconciliation. The separate safe-I/O suite tests byte/path/type
boundaries, including mutation during copy and export.
