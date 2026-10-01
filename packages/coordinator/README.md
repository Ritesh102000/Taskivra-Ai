# Phase 1 coordinator

`new Coordinator({ dataRoot, now?: () => number })` owns domain writes through a
SQLite WAL connection. `handle(command)` validates the same narrow command schema
as Electron IPC, commits the command, and returns a consistent read snapshot.
`tick()` advances the fixed simulation when auto-run is enabled; `close()` fences
and requeues only this coordinator's unfinished runs before closing SQLite.

The simulation driver makes no model calls and launches no browser workers,
container jobs, or supplied callbacks. Phase 2 adds a separate coordinator-owned
`artifacts` service for real file import and publication. The pre-created browser
session rows are explicitly `not_provisioned`. Completion messages explain that
only the simulation completed and no actual deliverable was produced.

## State and transactions

- Claims use `BEGIN IMMEDIATE`, a 15-second lease and monotonically increasing
  task generation. Partial unique indexes enforce one active run per task and
  agent. The persisted scheduler cap permits one or two active agents across
  independent coordinator connections.
- A fixed driver progresses through observe, optional clarification, summarize,
  and complete. The failure scenario intentionally terminates after observe.
  Each synthetic tool has a canonical task/tool idempotency key. Its receipt,
  message/request, checkpoint, run change and events commit together. A rollback
  leaves none of those effects visible.
- Clarification fulfillment, the owner message, revision change, resume receipt,
  events and eligible requeue share one transaction. A duplicate original reply
  is idempotent; a changed/stale reply is rejected. A fulfilled request cannot
  bypass pause, and a cancelled task cannot resume after a late reply.
- Pause fences tools immediately. The next owning tick settles `pausing` to a
  durable checkpoint. Pausing an already waiting task preserves its blocker;
  resume returns it to waiting until that blocker is fulfilled.
- Startup and ticks recover only expired leases. Another live coordinator is
  not interrupted. Graceful close recovers only this instance's runs. Expired
  claims cannot renew or issue a tool. Recovery retains the last committed
  checkpoint and rejects any old generation. Future ambiguous tool records are
  marked `outcome_unknown`; the broker refuses replay without reconciliation.

The snapshot includes all saved agents, tasks, messages and clarification
requests, with no omitted active tasks. It includes the **latest 500 events** in
ascending ID order; full events remain in SQLite. Phase 1 caps are 100 saved
agents, 250 tasks, 2,000 owner messages globally, 100 owner messages per task, and
4 MiB of owner message text. Objective and clarification messages count too.
Generated messages occur at finite driver steps, never on timer/recovery loops.
Phase 2 also supplies artifact, task-input and snapshot metadata plus cached
storage usage. Current task input versions are pinned separately when a run is
claimed. Capacity errors leave existing pause/cancel controls usable. Large-history UI
pagination and full storage-budget management belong to later phases.

## Explicit internal test seams

These APIs are trusted coordinator APIs and are **not exposed over Electron IPC**:

- `claimNext(workerId = instanceId): RunClaim | null` atomically claims one task.
- `authorizeTool(claim, tool?)` checks task/agent/run/worker identity, current
  generation, running state and the unexpired database lease; it has no effects.
- `renewLease(claim)` repeats that check inside a transaction before extending.
- `executeSyntheticTool(claim, tool, idempotencyKey?)` permits only the five fixed
  `simulation.*` tool names and repeats authorization inside its effect
  transaction. It accepts no supplied code or callback. Replaying a committed
  canonical receipt under a valid claim returns the previous result without
  another message or checkpoint change.
- `recoverExpiredRuns()` reconciles only expired runs; the injected `now` makes
  expiry and restart tests deterministic without waiting 15 seconds.
- `snapshot()` reads all its tables within one SQLite read transaction.

`CoordinatorError.code` distinguishes `not_found`, `invalid_state`,
`stale_revision`, `stale_generation`, `lease_expired`, `capacity_limit`,
`permission_denied`, `outcome_unknown`, `invalid_worker`, and `closed`.

## Validation

```sh
npx tsx --test tests/phase1/coordinator.test.ts
```

The 15 tests cover two child processes racing for one claim, independent
connections and ownership, schema/private directories, stale/expired fencing,
wait/restart/resume and reply deduplication, paused blockers, cancellation,
checkpoint recovery, transaction rollback injection, settings and manual stepping,
independent agent progress, conversation limits, database constraints, and symlink
rejection. The root test suite separately exercises a real SIGKILL/reopen cycle.

This is a local single-owner coordinator. Cross-agent messaging, artifact/file
authorization, browser task switching, external tool outcome reconciliation and
real model completion gates require their later-phase services.
