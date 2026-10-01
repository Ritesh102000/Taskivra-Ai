# Coordination service

`Coordinator.collaboration` is the trusted Phase 6 coordination service. It shares the coordinator's SQLite connection and existing immutable artifact store. Migration 7 reuses `agent_messages`, `task_dependencies`, and `event_cursors`; it adds owner policies, publication/consumption receipts, inbox attribution/acknowledgements, and dependency status records.

## Owner surface

`await collaboration.handle(command)` accepts the strict `CollaborationCommand` union and returns `CollaborationState`. The renderer cannot provide a principal, sender identity, run, generation, host path, or executable body.

- `collaboration.policy` uses optimistic `revision` and an owner-written summary of at most 240 UTF-8 bytes. New tasks start private. A shared summary is visible only to the assigned agent and the listed peers. An empty peer list shares with no other agent. Task objectives, instructions, private conversations, browser pages, and traces never supply the summary.
- `collaboration.send` sends an explicitly owner-authored message, visibly attributed `origin: owner`. It still requires the task's recipient allowlist. Owner text is at most 1,000 bytes; it is peer data, not a capability grant.
- Dependency add/remove requires the consumer to be idle or paused. An optional required version must be shared and produced by that exact upstream task. The existing recursive SQLite trigger rejects cycles.
- `collaboration.consume` verifies a specific shared version and updates future task inputs. Replacing an artifact version used by an active run requires pausing first. Existing run bindings are never changed.
- `collaboration.ack` records read timestamps idempotently for messages and/or publication notices. The owner selects the recipient inbox explicitly.

## Agent surface

All agent methods accept a trusted `RunClaim`; the broker derives it from the current run. `context`, `discover`, `send`, `ack`, `consume`, and `waitFor` independently validate ownership, current generation, state, and lease. Models never receive the owner state/snapshot.

`send(claim, {recipientAgentId, kind, taskIds, versionIds, idempotencyKey})` accepts references only. `kind` selects one fixed backend sentence. There is no model-supplied free-text field. Task references must be visible to both agents; file references must be ready shared versions. The sender comes from the claim. Retrying one logical key returns the same message; reusing it with other references is rejected.

`consume(claim, {versionId})` checksums the immutable bytes asynchronously, then repeats authorization inside the transaction that inserts task/run bindings and the unique consumption receipt. It rejects a cancelled/expired run, an active code workspace lease, and input totals over 512 MiB/4,096 files. An active run cannot replace its pinned version with a newer version of the same artifact. A subsequent file read verifies bytes again. Code materializes its selected exact pins through the existing artifact service; consumption does not create an unnecessary full workspace copy.

`waitFor(claim, {dependsOnTaskId, requiredVersionId?}, onCommit?)` adds the edge and calculates `{waiting, dependency}`. The synchronous callback receives that exact result inside the transaction, before a waiting run is finished and fenced. The model loop uses it to save the tool receipt and checkpoint atomically. Already-satisfied dependencies return `waiting: false` and keep the run active.

## Delivery and lifecycle

`reconcile()` reads at most 500 durable events per call. Only ready shared imports/publications become notices. Cursor movement and recipient receipts commit together; unique `(recipient, event)` and `(recipient, version)` constraints prevent duplicate delivery even after event/cursor replay. Shared-library versions are explicitly available to all agents, so publication notices use that scope; task summaries/messages use the narrower per-task peer policy.

Dependency failure, cancellation, or unavailable required output stays an explicit blocker. Reconciliation can move an eligible waiting task to queued exactly once. It never unpauses or revives a cancelled task, and unresolved input requests still block scheduling. `claimNext` rechecks required version metadata and supports excluding agents that still own background cleanup or replan work. Content integrity is checked during artifact startup reconciliation and again on consumption/read; dependency readiness alone is not a content read.

Peer views are rebuilt from selected public fields, never copied from raw event payloads or `ArtifactVersion` provenance. Revoking summary visibility removes the task and its past handoff messages from future peer context; it cannot retract information already delivered to a model. Published file versions remain shared. Agent context is bounded to 100 board entries, 50 inbox messages, 50 notices, and 100 shared versions. Exact references received earlier remain usable even when outside this recent listing. Owner lists allow up to the existing 2,000 artifact versions and 2,000 saved messages. Inbox bodies and references have a combined 4 MiB cap; dependency edges have a 1,000-entry cap. History retention/compaction remains Phase 7 work.

## Checks

The 17 collaboration tests (14 service tests and 3 mocked model-loop tests) use temporary application roots only. They cover version-locked A→B handoff and derived publication, restart, recipient receipts, replay, owner policy, private metadata exclusion, peer prompt injection, revoked policy in saved model history, cycles/failure, paused/cancelled preservation, checksum failure, input budget limits, strict arguments, stale leases, and cancellation during verification. The live-loop adapter is deterministic; no provider, Gmail, browser, or container is contacted.

Run `npx tsx --test tests/phase6/collaboration*.test.ts` or `node scripts/test-electron.mjs phase6`. The latter also runs the independent scheduler/native-browser tests.
