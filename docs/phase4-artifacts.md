# Phase 4 artifact and workspace boundary

The code service uses a separate task workspace history. Phase 2 `workspace_snapshots` remain immutable input snapshots; they are not the mutable code working tree.

## Trusted APIs

`ArtifactService.beginCodeWorkspace({taskId, agentId, executionId, versionIds, assertCurrent})` returns:

- `files`: verified host-only seed descriptors `{area, path, sourcePath, bytes, sha256}`. `sourcePath` never crosses renderer IPC or reaches the payload.
- `inputs`: the exact selected artifact metadata and container paths.
- `baseRevision` and `baseRevisionNumber`: the current committed code revision ID and sequence, or `null` and `0` for the first job.
- `commit(exportedFiles, {assertCurrent, onCommit})`: verifies and commits the complete exported regular-file tree, returning `{revisionId, revision, outputVersionIds}`.
- `release()`: releases only this service/execution's workspace lease and retries queued task attachment delivery. It does not commit a revision or resume a task.

The coordinator supplies synchronous `assertCurrent` callbacks. They run inside the short SQLite lease-acquisition and commit transactions, in addition to the artifact service's own execution ownership, lifecycle, lease owner, and expected-head checks. `onCommit(receipt)` runs in the same metadata transaction and must not start a nested transaction or perform asynchronous work. The code service records its authoritative workspace commit receipt there.

`codeInputManifest(taskId)` lists permitted attached inputs up to the global artifact cap. An explicit `versionIds` selection is limited to 128 unique versions. `latestCodeRevision(taskId)` returns the numeric committed head. `pendingCodeInputs(taskId)` lists saved versions waiting for attachment delivery.

`reserveExternal('code-execution', bytes)` provides an exclusive, crash-journaled staging directory. The code service reserves source/log and export capacity before writing. The workspace commit independently reserves the additional immutable workspace copy and output artifact copies. Existing committed revisions, SQLite/WAL files, exports, and pending operations count toward the application budget.

## Workspace semantics

Private selected inputs are seeded at `/workspace/inputs/<versionId>/content<extension>`. Shared selected inputs are seeded at `/shared/<versionId>/content<extension>` and the runtime makes this selected subset read-only. No live shared library directory is mounted.

Each new execution receives the prior revision's `work/` and `outputs/` files plus its exact selected inputs. Prior mutable `inputs/` copies are replaced by selected immutable versions. Coordinator source files named `work/.aw-execution-*` are not carried into the next job.

The exported manifest replaces the regular-file tree: file changes and deletions are preserved; empty directories are not persisted. Allowed roots are `inputs/`, `work/`, and `outputs/`. Limits are 4,096 files, 100 MiB per file, and 512 MiB total. The aggregate seed, including the selected shared subset, is also limited to 512 MiB. Traversal, links, special files, conflicting paths, content hash changes, excessive sizes, and supported-format masquerades reject the complete commit.

Only `outputs/` files create artifact versions. They are private to the producing agent, have task binding role `output`, and carry `{executionId, inputVersionIds}` provenance. Explicit publication creates a shared copy and retains that provenance. Work files remain private revision contents. A failed or interrupted execution preserves the previous committed head.

## Atomic commit and recovery

Schema migration 4 adds `code_workspace_revisions`, `code_workspace_heads`, `code_workspace_leases`, and `task_artifact_deliveries`, as well as code execution and dependency metadata. Each code revision has a unique execution receipt and a parent revision. Each task has at most one durable workspace lease.

The artifact journal is written before filesystem finalization. Staged files are copied with no-follow regular-file checks, verified against expected bytes and hashes, fsynced, and finalized into generated private locations. Filesystem work occurs outside SQLite transactions. Finalized bytes are reverified before one transaction records private output artifacts, output bindings, the code revision/head, the code service receipt callback, journal completion, lease removal, and `workspace.code_committed` event.

If the process dies before that transaction, startup removes the uncommitted finalized files and preserves the prior head. If it dies after the transaction, startup preserves the committed bytes and removes only leftover staging. A still-live owner is not cleaned up merely because time elapsed; run generation and lease checks remain the coordinator's authority for accepting effects. Reconciliation also detects changed/missing committed workspace files and refuses to seed a corrupt head.

Owner imports during a code job commit their private artifact bytes immediately and queue task attachment delivery. The running execution's selected inputs remain unchanged. Delivery runs after a successful commit or lease release, and retries on startup or before a later workspace acquisition. It never resumes paused or cancelled tasks. The native file bridge reports that the file is saved and task delivery is deferred. If delivery cannot pass storage or integrity checks, the pending record remains retryable.

This boundary uses Node's path checks, no-follow file descriptors, identity/stat comparisons, and repeated hashing. It does not claim an `openat`-style kernel capability boundary against a hostile host process concurrently renaming managed ancestors. Managed host storage must remain coordinator-owned and must never be mounted writable into payload containers.

## Verification

`tests/phase4/artifacts-workspace.test.ts` covers revision replacement, exact private/shared input scope, deferred delivery, competing lease owners, task fencing after finalization, transaction rollback, malicious export manifests, storage admission, and corruption detection. `tests/phase4/artifacts-crash-recovery.test.ts` uses actual child-process `SIGKILL` before and after the metadata commit and verifies previous output preservation, authoritative receipts, orphan cleanup, and exactly-once queued delivery.

The 10 tests passed under host Node and Electron's bundled Node. These tests verify the artifact boundary; they do not substitute for the separate Docker runtime and native desktop acceptance gates.
