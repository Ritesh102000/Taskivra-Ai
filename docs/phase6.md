# Phase 6 — coordination and dedicated Chrome

Implementation record: 30 September 2026. The owner authorized Phase 6 and a browser design that allows personal Mac use while agents work independently. This report supersedes earlier statements that only one live loop exists. The original architecture/design/implementation-plan sections remain the planning baseline.

## Implemented behavior

- Two independent live loops, bounded by Settings and one executing task per agent. Each loop has its own cancellation signal, budget and saved progress. Waiting releases execution capacity. Stopping one task does not cancel another agent.
- A shared task board containing only owner-written summaries and explicit peer permissions. New tasks remain private. Objectives, private conversations, model instructions, browser observations and private file provenance are excluded from peer context.
- Per-agent inboxes, visibly attributed owner messages, and agent messages containing only approved task references and published version references. Agent messages have fixed backend-written descriptions; arbitrary private free text is not accepted. Stable logical message keys deduplicate retries.
- Shared file discovery and exact-version consumption. Bytes are verified before task/run pins commit, and claim/generation/lease authorization is repeated after the asynchronous read. An active run cannot silently move from v1 to v2. An owner replaces a used artifact version only after pausing. Derived publications create distinct immutable files.
- Acyclic task dependencies. Upstream failure/cancellation and unavailable required versions remain explicit blockers. Successful dependencies release eligible waiting work once, while pause, cancellation and unresolved user-input requests remain effective.
- Durable publication/inbox acknowledgements and event cursors. Replaying a publication produces one notice per recipient/version. Shared library publication is global to agents; task summaries and message references retain the narrower peer scope.
- Per-agent browser selection between dedicated desktop Chrome and the existing container browser. Backend changes require a closed session and idle/paused agent.

Migration 7 stores policies, receipts and dependency statuses in the existing SQLite database. The coordinator owns those transactions; no new server or queue dependency was introduced. [Service API and limits](../packages/collaboration/README.md).

The model tools are `collaboration_context`, `discover_shared`, `consume_shared`, `send_agent_message`, `acknowledge_messages` and `wait_for_task`. Models cannot supply sender identity, principal, raw database queries or host paths. Current views are rebuilt every turn, and old collaboration receipts are excluded from model history so revoked views are not reintroduced. Revocation cannot retract information already received by a model, and published files remain shared. Peer messages, pages and files never grant publication/upload capabilities.

## Browser design and changed isolation boundary

Each agent gets a separate normal Chrome user-data directory. A local extension accepts a fixed command set through an attested native-messaging host and private Unix socket. No remote debugging port or global mouse/keyboard automation is used for agent commands. Background tabs/windows remain inactive/unfocused; only an explicit owner show action focuses Chrome.

Takeover fences admitted/queued commands, clears old DOM references, detaches screenshot debugging and returns no page observation while the human controls Chrome. Login/MFA input occurs directly in that window. Returning control requires a fresh observation. Stop closes the session's registered tabs while retaining Chrome-managed local login data. Exact session/agent identity, generation and document revision guard subsequent actions.

**Desktop Chrome uses the host network and normal Chrome sandbox.** Cookie/profile separation is not Docker network/filesystem isolation. Code execution remains in offline containers. Managed uploads/downloads are not implemented for desktop Chrome; normal manual downloads are not automatically imported as task artifacts. The container backend retains those verified transfer features and its earlier network boundary. Browser cookies are not transferred between modes.

Current developer setup requires installed Google Chrome, `npm run browser:native:setup`, and **Load unpacked** from `extensions/agent-browser` in each dedicated agent profile. The extension is not installed into personal Chrome. This manual distribution choice is provisional; production extension installation/update and packaging belong to Phase 7. [Browser implementation and setup](../packages/native-browser/README.md).

## Acceptance evidence

The coordination acceptance uses real coordinator/SQLite/artifact services and deterministic model adapters: B waits across restart; A produces and publishes a specifically granted v1; B resumes once and pins v1; A's v2 arrives; B still reads v1 and publishes its own specifically granted derived output. Neither A's private history/provenance nor unauthorized publication crosses the broker. This is not a paid multi-agent OpenAI run.

The scheduler tests hold one model request pending while a second agent progresses, cancel one without cancelling the other, enforce same-agent serialization, and hold a third task until capacity opens. Browser tests cover framing, the closed command surface, profile authentication, background API behavior, takeover privacy, stale DOM references, stop cleanup, and real coordinator-to-extension reply compatibility using synthetic Chrome APIs.

Native desktop review used `.test-data/phase6-desktop-review`, a separate paused Browser QA task and no model calls. Chrome's version page confirmed the exact managed `--user-data-dir` and ordinary installed Chrome without automation/debugging flags. The extension was installed through Chrome's native Load unpacked picker. The real integration test passed 1/1: authenticated compiled host connection, public HTTPS navigation, bounded JPEG preview, debugger detachment confirmed by Chrome, redacted human observations, rejection of old generations, fresh observation after return, and session stop. Manual app review also opened the browser, took control, navigated, returned control and displayed a fresh public-page preview. Foreground focus was not instrumented; background behavior is implemented through inactive tabs/unfocused windows and no global OS input. [Sanitized native receipt](../packages/native-browser/evidence/verification.json).

A separate production setup then prepared Mail Assistant's dedicated Chrome profile, installed its extension through the picker, and verified **Extension connected** in the app. During owner control, Google's normal passkey flow successfully opened the intended Gmail inbox. Chrome account synchronization was declined, and browser control returned to Agent Workspaces. A clean app and Chrome restart preserved sign-in: Gmail reopened without another authentication prompt. The real handoff check found and corrected a stale tab selection when login opened a new tab. After explicitly reloading the updated unpacked extension, returning control selected the new Gmail tab and the app displayed its fresh preview. The regression checks both the extension and coordinator path without focusing Chrome.

This proves that account's native browser sign-in and one clean restart on this Mac at the time of review; it is not a new agent-written unread-email report or proof of every MFA method or long-term session validity. No password was copied into task messages or repository evidence. The Chrome profile retains its normal local session state.

Before the production migration, a private SQLite backup was saved under the confirmed data root's `control/backups/` directory. The migrated app retained the existing Mail Assistant and completed task. Historical read-only OAuth evidence is in [Phase 5](phase5.md). The earlier one-day model key is not assumed valid, and no production credential values or mail contents are included here.

## Verification commands

```sh
npm run browser:native:setup
npm run typecheck
npm run build
npm test
npm run test:electron
```

Final results: **388 host passes** (354 Node + 34 Python), **347 Electron passes**, **0 failures**, and successful typecheck/build. Both full JavaScript runs skipped 17 opt-in checks. Phase 6 contributed 72 passes on each runtime plus one default-skipped native integration check; that real native check was separately run against the installed QA extension and passed 1/1 in 2.47 seconds before the final tab-selection correction. The corrected handoff was then verified through the production app, as described above, plus 15 native tests on each runtime and 21 browser service tests. Default tests use temporary data and deterministic adapters. Container integration and paid model workflows remain separate opt-in checks.

## Remaining scope

Alternative login/MFA methods and long-term session validity, a paid two-agent model acceptance run, native managed file transfers, broader site input coverage, extension distribution and packaged release remain separate work. The new Chrome mode does not bypass Google login restrictions or claim that every site accepts agent browsing. Known blocked login still has the existing Gmail read-only OAuth alternative.
