# Phase 2 — managed files and shared storage

Implementation record, 11 September 2026. The owner explicitly requested Phase 2 after Phase 1. The planning documents remain the baseline; this report describes the implemented subset and its evidence.

## Implemented flow

The desktop renderer sends narrow file commands to the Electron main process. Native picker selections and native dropped `File` objects provide local paths; ordinary renderer commands cannot supply arbitrary source or destination paths. The bridge fixes the principal to the app owner, checks the sending window/frame, validates target IDs and scope, and permits one file operation at a time. Native save selection provides an export destination.

The coordinator owns one artifact service and the SQLite connection. A journal records an operation before staging exists. Imports stream into unique staging files, validate type and size, hash the bytes, and publish immutable versions to generated paths. Metadata, exact task bindings, workspace heads, and events commit together. Failed or interrupted work does not acquire a ready version row. Startup reconciles its journal and verifies committed bytes.

Same-name imports create distinct logical artifacts. Adding a version preserves the logical artifact and increments its version number. The source file is never moved or modified. Private versions stay scoped to their agent; an owner can inspect them, but handing one to another agent requires explicit publication. Publishing copies a specific immutable version into the shared library and retains its source version and producer. Repeating the same publication returns the existing shared version. Later publications and version additions leave old task pins unchanged.

Using a file in a task creates a checksum manifest and immutable materialized input snapshot. Each snapshot retains every pinned input by version ID. Run claims copy the current exact bindings to `run_artifact_bindings`. These are input snapshots: mutable code work, output capture, and execution-time workspace commits belong to Phase 4.

The task Files panel, shared library, preview dialog, publishing confirmation, version selector, task picker, and storage controls use real persisted records. Preview text is rendered as text, never HTML. Export copies verified bytes to a temporary sibling and publishes exclusively to a new filename, preserving existing destinations.

## Formats and defaults

| Item | Current behavior |
|---|---|
| TXT, Markdown, CSV | Valid UTF-8 without binary nulls; plain-text preview capped at 64 KiB. CSV has no semantic table processing yet. |
| JSON | Valid UTF-8 and JSON, at most 1 MiB, depth 64, and 100,000 structural entries. |
| PDF, PNG, JPEG | Signature/extension agreement; metadata only. Full document/image decoding is deferred. |
| XLSX | Required OOXML parts and ZIP structure; up to 2,048 entries, 4 MiB central directory, 256 MiB declared expansion, and 100:1 compression ratio. Split, ZIP64, encrypted, macro/embedded executable, linked, duplicate, and unsafe-path entries are rejected. No extraction or workbook semantics yet. |
| Other regular files | Opaque byte transfer and metadata; no execution or semantic claim. Macro-capable spreadsheet extensions are rejected. |
| Import | 100 MiB/file, 250 MiB/batch, 1–32 files; batch commits atomically. |
| Input snapshot | 512 MiB of materialized file bytes; manifests and retained copies also consume application storage. |
| Application budget | Initial 2 GiB, adjustable from 256 MiB to 20 GiB in Settings; an implementation default, not a newly confirmed owner choice. |

The budget scan includes managed originals, shared copies, staging, snapshots, database/WAL, and desktop cache/log files. Reservations account for new copies, external export staging, and a metadata allowance before admitting an operation. The display is the latest measured usage, not a continuous disk meter. Three exact Chromium `desktop/Singleton*` bookkeeping links are counted by their own metadata size without following their external targets; other managed links fail validation. Owner-exported final files are outside retained application storage. No preview cache is written.

Version and snapshot metadata are capped at 2,000 records each. Storage accounting bounds artifact operations; SQLite and Chromium may perform small background writes between scans. This is not a filesystem quota on every byte written by the Electron process.

## Isolation and recovery boundaries

Agent-scoped lookup checks authorization before returning file metadata or bytes. Generated IDs never become caller-provided filesystem paths. Managed paths reject traversal, symlinks, hard-linked files, and special files. Copies retain file descriptors, compare identity and metadata, hash the source again, and verify staged bytes. Export cannot replace an existing destination.

`Coordinator.snapshot()` is an owner inspection projection containing all agents' metadata. A future model adapter must build its context through agent-scoped artifact methods and exact run bindings; it must not send the owner projection to an agent. Raw local paths, the database, and the internal owner principal are never agent tool arguments.

Node does not expose `openat` for directory-relative atomic operations. This implementation uses `O_NOFOLLOW`, retained leaf descriptors, and ancestor identity checks. It detects ordinary replacement and tested adversarial mutations, but is not a kernel-enforced guarantee against a hostile process on the Mac swapping an ancestor during a path-based operation. Managed parents must remain coordinator-owned; containers must never receive host-write mounts. A stronger host-process threat model needs a reviewed native directory-relative I/O helper.

Application quit fences pending commits and drains owned temporary-file cleanup. A hard crash during owner export can leave an identifiable `.agent-workspaces-export-*.tmp` sibling in the chosen destination directory; it does not expose a partial final file. Export temporary files outside the application root are not deleted on later startup without a renewed directory grant. Committed originals and version metadata remain authoritative.

## Verification

The native desktop workflow used only synthetic fixtures under `.test-data/phase2-ui` and `.test-data/phase2-inputs`. Native picker import, safe preview, explicit publication, exact-version task use, shared version addition, native export, invalid JSON rejection, storage display, and restart persistence were exercised through the actual app.

The review task retained shared version `a88cafd9-4407-4ccf-82d5-1bb6db17b055` after version 2 was added. Exported version 2 matched its source checksum exactly: `a72a2827de825fa41567266d5faf9c3527ae9f137a3648ae30c308c085e07784`. Invalid JSON left all three previously committed versions and the existing task pins unchanged. Local evidence: [native workflow](phase2/evidence/native-workflow.json).

Finder-to-Electron drag and drop is implemented but was not completed as a native interaction during this run. Automated tests cover the dropped-file identity resolver, payload validation, scope routing, and import service; those checks are not a claim that the physical drag gesture was observed.

Final verification passed:

- `npm run typecheck` and `npm run build`.
- `npm test`: 131 tests (41 Phase 0, 29 Phase 1, 61 Phase 2).
- `npm run test:electron`: all 90 Phase 1/2 tests using Electron's bundled Node and SQLite.
- Actual child-process SIGKILL after file finalization: uncommitted file/snapshot bytes and journal reservations existed before recovery; reopening removed the interrupted operation and preserved the earlier committed file's hash, inode, permissions, and preview.
- Migration regression preserves Phase 1 agents, tasks, messages, and a waiting checkpoint. The owner data root also upgraded from schema 1 to 2 and opened successfully, with its pre-existing zero-agent/zero-task state unchanged; integrity and foreign-key checks passed.

The 61 Phase 2 tests cover 26 artifact service cases, 22 safe-I/O cases, 12 command/bridge cases, and the real process-kill recovery case. They exercise duplicate names, scope denial, exact version/run pins, staged batch failure, source mutation, quotas, malformed formats, symlinks/hardlinks/special files, bounded manifest verification, exclusive export, and shutdown/restart. [Validation record](phase2/evidence/validation.json), [local test output](phase2/evidence/local-tests.log), and [Electron test output](phase2/evidence/electron-tests.log) are local generated evidence, ignored by Git.

## Still deferred

The task driver remains simulated. No paid model request, real website login, browser container, or code container is introduced by Phase 2. File request slots, semantic acceptance/replacement, automatic resume after file delivery, agent messaging, and dependency scheduling are later phases. Importing a file does not silently fulfill a simulated clarification request.

Phase 0's exact model, test-spend cap, representative login/MFA, profile policy, and measured representative concurrency gates remain open. Complex parsing belongs in the isolated execution service. Retention/deletion and recovery/packaging UX still need later-phase work.

Implementation references: Electron's [webUtils](https://www.electronjs.org/docs/latest/api/web-utils) and [native dialogs](https://www.electronjs.org/docs/latest/api/dialog), and Node's [filesystem API](https://nodejs.org/api/fs.html).
