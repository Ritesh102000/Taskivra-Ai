# SQLite persistence

`Persistence` opens `<dataRoot>/control/agent-workspaces.sqlite`, enables foreign
keys, WAL, full synchronous commits and a bounded busy wait, then applies the
transactional `user_version` migration. A database newer than this application is
rejected. Data directories use owner-only permissions and owned symlink paths
are rejected. Agents and task directories use generated IDs, not user names.

Schema version 1 includes every table named in the planning architecture. The
Phase 1 coordinator uses task, run, message, clarification, event, receipt and
settings records. Browser profiles, file slots, artifacts, sharing grants,
dependencies, peer messages and code execution tables reserve their later-phase
shape; table existence is not a claim that those services work. Schema version 2
adds immutable artifact version sequencing/provenance, task and run input bindings,
workspace snapshots/heads, operation journals, and storage-budget metadata without
recreating or discarding the Phase 1 tables.

`transaction()` uses `BEGIN IMMEDIATE` for short atomic domain writes.
`readTransaction()` provides consistent multi-table snapshots without taking a
write reservation. Domain services must not hold transactions across models,
containers, network requests, or user interaction.

The database enforces one active run per agent/task through partial unique
indexes, unique tool idempotency keys, unique resume receipts, unique request
continuation keys, foreign keys, basic state/type checks, and dependency cycle
rejection. Only the coordinator writes application state in the product; a
separate SQLite connection is used by tests for concurrency and fault injection.

No credential is stored here. Browser session rows start `not_provisioned` and
have no profile path. Phase 2's coordinator-owned artifact service implements
file-byte commit/reconciliation through the operation journal. Backup/restore,
retention and encrypted data storage remain later work.

New direct callers should use `transactionSync` or `readTransactionSync` to reject statically inferred Promise return values. All transaction entrypoints reject returned thenables before commit and roll back synchronous database changes. This detects a misuse but cannot cancel external work already started inside the callback; do not perform asynchronous or external work in a transaction callback.
