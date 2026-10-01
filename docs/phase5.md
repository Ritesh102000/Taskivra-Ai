# Phase 5 — cloud agent loop and input requests

Implementation record: 11 September 2026. The Phase 5 core is implemented and verified with a real OpenAI → file request → restart → isolated Python → verified output workflow. Real Gmail Desktop OAuth also passed: the intended account was verified, the task resumed automatically, and a bounded unread listing produced a private report. That report required a correction during Codex review described below. Phase 6 multi-agent coordination and Phase 7 packaging/recovery work remain future phases.

The original [architecture](../architecture.md), [interface design](../design.md), and [implementation plan](../implementation-plan.md) remain the planning baseline. `design-preview.html` remains an interactive mockup. Earlier implementation reports describe their historical phase scope; their statements that the model loop was future work are superseded by this record.

## Decisions and implemented defaults

The owner confirmed Mac first, cloud APIs first, isolated container execution, OpenAI as the initial provider, the Application Support data root, and remembering browser logins locally. The owner authorized live tests with a supplied OpenAI key; it is saved in macOS Keychain. After Google rejected isolated-browser sign-in, the owner chose the supported read-only Gmail OAuth alternative for now.

The pinned model **`gpt-4.1-mini-2025-04-14`** and the following task limits are implementation defaults, not additional explicit owner choices:

| Limit | Default |
| --- | --- |
| Task model spend | $1 |
| Model generation attempts | 40 |
| Tool steps | 80 |
| Active time, excluding waiting | 900 seconds |
| Input plus output tokens | 200,000 |
| Maximum output per model turn | 2,048 tokens |

Tasks expose their limits and usage. Reservations survive pause, resume and restart; creating a continuation does not reset the task budget. The successful integration test used its own smaller $0.10 cap. Model pricing, supported schema limits, and official sources are recorded in the [adapter guide](../packages/model-adapters/README.md).

## Connected implementation

The renderer sends narrow, validated commands through the desktop main process. The trusted coordinator owns SQLite transactions, leases and generation fencing. Its [live loop](../packages/agent-loop/index.ts) claims one task, prepares a bounded model context, reserves usage, dispatches one validated tool, saves its receipt and observation, and repeats. Simulation remains available and visibly separate. Phase 5 runs one sequential live loop at a time; multi-agent orchestration is not implied by the existing agent list or two-browser capacity.

The provider-neutral adapter uses the OpenAI Responses API through native `fetch`. The official input-token endpoint quotes the exact prepared request before an atomic token and money reservation. Generation is single-use, has no automatic retry, and uses `store:false`, strict function schemas, `parallel_tool_calls:false`, and no provider-built-in tools. Returned arguments are independently validated. Known provider usage settles the reservation; an interrupted request with unknown usage retains its full reservation and pauses for review. No raw reasoning is requested or persisted. `store:false` is not a zero-retention claim.

Credentials stay in the native coordinator and nonsynchronizing Keychain items. Neither model keys nor Gmail tokens enter renderer state, model context, workspace files, browser containers or code containers. Model errors use reviewed messages rather than raw provider bodies. Request, response, tool-argument and history sizes are bounded. Each live step or replan reserves 256 KiB of application storage before starting, so a full storage budget stops work before a model quote or generation.

The broker connects to the existing artifact, browser and code services. Files are accessed through exact authorized version IDs. Code executes offline in the Phase 4 container boundary and commits only independently verified exports. Agent browsing uses bounded observations and owner-approved origins. Upload and publication require exact owner-approved capabilities; a publication rechecks the live claim inside its final metadata transaction after staging. Page content, mail, files and logs cannot grant access to another agent's private files or authorize an unrelated destination.

## Requests, continuation and completion

A `user_request` stores the checkpoint and blocker with the task transition. File requests have independent named slots, immutable candidate versions, constraints and revision-checked validation. Supplying one correct file and one wrong file keeps the request open. Replacing only the wrong candidate preserves the accepted slot. Acceptance, fulfillment, a deduplicated continuation receipt and requeue commit together; replayed events cannot schedule a second continuation.

The dedicated validation queue can work while the task waits. Bounded CSV, JSON and text checks enforce supported deterministic constraints. Unsupported semantic checks remain blocked rather than being declared satisfied. Late validation cannot overwrite a newer candidate. Cancelling a task prevents later fulfillment from reviving it; fulfillment while paused preserves the pause. Process-kill tests cover interruption before and after the validation commit.

An unavailable-file reply creates a saved, revision-checked replan. The loop can keep the blockers or propose reduced scope. Required slots are waived only after explicit owner acceptance of the current proposal. Clarification text cannot substitute for a capability grant or a verified Gmail connection.

For browser login, a handoff transfers control to the owner and waits. Agent actions require a current generation and fresh observation after control returns. Pause, cancellation, active-time expiry and lease loss fence further actions and stop the affected workers. Restart preserves checkpoints, accepted inputs and receipts; an uncertain dispatched action is not automatically replayed.

Completion requires an existing, readable output produced by that task with no unresolved required inputs. A code output can be the final deliverable directly. A written report must reference successful evidence receipts and is saved privately with provenance before completion. This verifies the deliverable and its evidence references; it does not independently prove every natural-language interpretation is correct.

## Automatic diagnosis and Gmail boundary

Known transient browser read failures receive at most one fresh-read retry with a bounded diagnostic record. Navigation, clicks, uploads and other actions with uncertain outcomes are never retried automatically. Model requests also have no automatic retries.

Google's known rejected-login URL creates one durable Gmail connection request instead of repeatedly attempting the blocked login. Page text cannot impersonate that diagnosis. Once the service verifies the exact requested account, the request records one continuation. A wrong account cannot release it, a paused task stays paused, and a cancelled task stays cancelled. These behaviors are covered across service replacement and restart.

The supported alternative uses Google Desktop OAuth in the system browser with PKCE, state validation and an ephemeral loopback callback. It requests only `gmail.readonly`. It reads at most 50 unread message identities with sender, subject, date and snippets, reports pagination, and bounds the result to 22 KiB with explicit truncation metadata. It does not fetch bodies or attachments, change unread state, send, archive or delete messages. Credentials use a separate Gmail Keychain service.

**Real Gmail OAuth/read acceptance passed.** The Desktop client JSON was imported through the native picker, the owner completed consent in Safari, and the service verified the exact requested account. The task automatically resumed and succeeded. One actual API listing returned 50 entries with `hasMore:true` and truncated snippets; `resultSizeEstimate:201` was approximate, not an exact unread total. Message bodies and attachments were not accessed, and unread state was preserved. The earlier blocked stage used two model calls and $0.000968; the cumulative task total, including those calls, is seven calls, 44,211 input tokens, 2,547 output tokens and **$0.021763**, with no outstanding reservation. [Native evidence](phase5/evidence/gmail-native.json), [connection guide](phase5/gmail-setup.md).

The agent-produced report version 1 had imprecise coverage wording and an unsupported, model-generated checksum footer. It was corrected privately through native **Add version** as version 2, preserving the original completion artifact. Both versions' application-computed hashes were independently verified. The correction makes partial coverage, snippet truncation and the approximate estimate explicit and removes the invented checksum. This proves connection, controlled read, continuation and artifact/version behavior; it does not establish fully reliable autonomous reporting or independent semantic accuracy. Repository evidence contains no raw mail, account identifier or OAuth secrets. Google's isolated-browser login remains rejected; the verified alternative is Desktop OAuth, not a browser-login fix.

After a full native app restart, the saved connection displayed Connected, the task remained completed with the same seven calls and cost, and corrected v2 reopened in the preview. Reporting instructions now explicitly require API coverage/truncation facts, approximate estimates and trusted artifact hashes. Host and Electron Phase 5 suites, typecheck and build passed after that change; no additional paid run tested the revised reporting instructions.

## Recorded evidence

| Check | Result and evidence |
| --- | --- |
| Full default host suite | 315 passes: 281 Node and 34 Python; 16 opt-in skips. No paid calls in the default suite. |
| Electron suite | 274 passes using Electron's bundled Node/SQLite. |
| Latest focused Phase 5 suites | 87 passes and 3 opt-in skips on both host Node and Electron after the report-guidance update, including the stale-consent regression. Typecheck and desktop build passed. No new paid compliance run. |
| Latest browser worker integration | One real Docker gate passed in 8.35 seconds. [Image IDs, source hashes and boundary checks](../tests/phase3/evidence/worker-docker.json). |
| Live adapter probe | One count request and one generation; 71 input and 16 output tokens, $0.000054. One strict tool call validated. [Evidence](../packages/model-adapters/evidence/live-probe.json). |
| Live two-file workflow | Wrong file kept the task blocked; restart preserved the accepted slot; replacement produced exactly one fulfillment receipt and one continuation. One real Python container produced checksum-verified `sum.json`, 13 bytes, with sum **20**. Three model calls, 7,647 input and 544 output tokens, **$0.00393**, no remaining reservation. [Test](../tests/phase5/live-workflow.test.ts), [successful evidence](../packages/model-adapters/evidence/live-workflow.json). |
| Native Gmail workflow | Native client import and Safari consent verified the requested account and automatically resumed the task. One actual API listing returned 50 entries with more available and truncated snippets. Task succeeded; its cumulative seven model calls cost **$0.021763**. Private report v2 corrects v1's coverage and invented checksum footer while preserving v1. Full restart preserved connection, completion, usage and the corrected preview. [Privacy-safe evidence](phase5/evidence/gmail-native.json). |

The first live workflow attempt failed: repeated code/report work did not satisfy completion, and the task paused. Its last captured cost was $0.015868, but final usage was not captured before temporary-data cleanup. That number is **not** a final cost or a combined total. The [separate failure record](../packages/model-adapters/evidence/live-workflow-initial-failure.json) retains the limitation. Explicit output/evidence IDs and clearer completion instructions were then added before the successful second attempt. Each attempt had a $0.10 cap; the successful-run cost above describes only that run.

Focused regressions cover [loop authorization and budgets](../tests/phase5/loop.test.ts), [publication after staging](../tests/phase5/publication.test.ts), [partial inputs and scope changes](../tests/phase5/requests.test.ts), [SIGKILL validation recovery](../tests/phase5/request-recovery.test.ts), [active-time and storage limits](../tests/phase5/time-budget.test.ts), and [diagnosis, exact-account resume and uncertain actions](../tests/phase5/recovery.test.ts). Gmail tests cover mocked consent, refresh, wrong accounts, cancellation, limits and native credential isolation. Earlier real browser/code evidence remains in [Phase 3](phase3.md) and [Phase 4](phase4.md).

## Commands and remaining scope

```sh
npm run model:setup
npm run gmail:setup
npm run typecheck
npm run build
npm test
npm run test:electron
npm run test:phase5
```

The setup commands compile local credential helpers; they do not install credentials or make paid calls. Docker and prepared browser/code images remain explicit prerequisites for relevant live tools; see the [browser runtime](../packages/browser-runtime/README.md) and [code runtime](../packages/code-runtime/README.md) guides.

The following test is an explicit paid opt-in using synthetic files, the configured Keychain credential and Docker. Its task cap is $0.10; default tests do not enable it:

```sh
AW_PHASE5_LIVE_WORKFLOW=1 AW_MODEL_EVIDENCE=1 npx tsx --test tests/phase5/live-workflow.test.ts
```

Remaining work includes broader real-site login/MFA/passkey compatibility, richer document semantics, and general task/report-quality evaluation. This Gmail read covered one bounded page, not the entire unread mailbox; long-term real token refresh/reconnection remains a separate operational check. Phase 6 shared-board coordination, peer messaging/dependencies and the second-agent consumption scenario are not implemented. Phase 7 packaging, backup/restore and full release acceptance remain outstanding. Existing manual publication and exact-version sharing are earlier-phase primitives, not evidence that multi-agent collaboration is complete.
