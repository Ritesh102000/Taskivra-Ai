# Workflows, overview and reliable direction — 30 September 2026

Version 0.6.1 builds on Phase 6. The owner requested local installation and code research of six comparable projects, followed by relevant product improvements. The owner selected **all** audiences: business/agencies, developers and personal productivity. This update keeps Mac first, cloud model APIs first, isolated code execution, private agent browsers and explicit file publishing.

## What changed

### Guided and reusable workflows

**New task → Workflows** offers six original starters:

| Audience | Starters | Verified setup behavior |
| --- | --- | --- |
| Business | Compare competitors; Analyze a spreadsheet | Collect a question and approved sources or expected files; produce a task with a concrete output criterion |
| Development | Review code files; Review a website | Request supported source files or explicitly permitted pages; distinguish observed defects from unexecuted tests |
| Everyday work | Review unread Gmail; Research a decision | Scope the exact Gmail account or chosen websites; preserve read-only behavior and source coverage limits |

The form collects specific inputs, allows selecting or creating an agent, and shows the exact generated task and access before saving. Model and maximum spend remain visible; detailed call/step/time/token limits are expandable. A workflow saves a **paused** task with zero model calls. Only the existing **Run agent** action starts paid work. The server validates inputs, HTTPS sources, model, limits and policy again. URL paths remain in the brief; permitted origins are deduplicated. There is no automatic repository access, container package download, mailbox write or publication permission.

**Save workflow** turns a live task's original brief, completion criteria and base tool policy into a reusable owner-only template. Each use reviews editable inputs and chooses an agent with fresh limits. It does not copy task files, later conversation/steering, browser sessions, credentials, usage, outputs, grants or collaboration policy. New tasks have private defaults. Saved workflows survive restart; removing a template does not remove tasks created from it. Limits: fifty saved workflows and one thousand creation/save receipts.

Creation is idempotent for an unchanged form submission. Task, live configuration and creation receipt/provenance commit in one database transaction. A failed receipt cannot leave a runnable half-configured task.

### A home view organized around action and results

**Overview** is the default view. It groups actual input requests and task problems under **Needs you**, shows saved/running work and surfaces completed results. Actions open the relevant task or browser view. Counts come from saved state; no fabricated progress percentages. A saved draft artifact from an incomplete task is not presented as a completed result. Simulations remain labeled. Result preview still checks the artifact through the existing broker.

Task headings are shorter, the complete brief stays in the conversation, and first-run tasks say **Run agent** instead of implying prior execution. The workflows and overview use the existing light/dark palette and responsive layout. A custom-task path remains available.

### Corrections the agent cannot silently miss

Owner task messages now persist a delivery state: **Queued for next step** or **Included in next decision**. Incorporated means the instruction was included in an accepted model decision, not that its requested outcome has been achieved. Pending instructions on stopped tasks remain visibly unread before stopping.

All accepted steering updates remain in subsequent model context, including more than four messages and messages with identical timestamps. A separate cumulative 24 KiB serialized update budget rejects excess input before persistence rather than silently dropping older instructions. Existing overall conversation bounds also remain.

If a correction arrives during a model request, the returned decision is discarded before dispatch and a new turn reads the correction. Discarded calls still count toward cost and task limits. Final output verification, missing-file replans and the asynchronous preparation of browser/code/upload/publication steps are also fenced against a newer correction. Pause, cancellation and restart retain the queue without automatically starting work. Already dispatched external actions cannot be retroactively undone; uncertain actions are not blindly retried.

### Browser health that explains the next step

Native browser setup distinguishes connected, profile closed, extension missing, extension disconnected, registration damage and unavailable runtime. A closed installed profile offers **Reconnect Chrome**, and an installed disconnected extension offers a check/reload path. Status polling only inspects the dedicated profile's bounded extension/process evidence; it never opens a window or reads page content/cookies. Existing owner-control and running-task guards remain.

This is diagnosis and safe reconnection, not a promise to solve MFA or make Google accept an unsupported embedded browser. Dedicated Chrome sign-in and the separate read-only Gmail OAuth option remain the supported paths. Managed native-browser uploads/downloads remain unavailable.

## Research installation and source coverage

All six source trees and isolated development dependencies are under:

`~/Desktop/Agent Workspaces Research 2026-09-30`

The source backup taken before app changes is `project-source-before.zip`. Exact commits, dates and tracked-file counts are in `reports/source-manifest.json`. The review mapped all six architectures and followed relevant browser, runtime, persistence, collaboration, workflow and interface paths in depth. It was **not an exhaustive every-line audit** of the 25,895 tracked files, generated clients and assets.

| Project | Commit prefix | Installation and bounded proof | Selected upstream tests |
| --- | --- | --- | --- |
| [Browser Use Desktop](https://github.com/browser-use/desktop) | `f073b7574f79` | Dependencies/native modules installed; actual Electron onboarding launched with a fresh session DB | 58 passed |
| [DeerFlow](https://github.com/bytedance/deer-flow) | `f75d89f39dd1` | Frontend/backend environments; static frontend and credentialless Gateway readiness returned HTTP 200 | 42 passed |
| [Kortix/Suna](https://github.com/kortix-ai/suna) | `7df56c8b3afa` | Selected web/API workspaces installed; research path bug fixed and docs/assets HTTP 200; sign-in still HTTP 500 and external services required | 23 passed |
| [OpenAgents](https://github.com/openagents-org/openagents) | `d46d087dca22` | Python/workspace frontend environments; UI HTTP 200 and backend fixture checks | 105 passed |
| [OpenHands/Agent Canvas](https://github.com/OpenHands/OpenHands) | `1ec86616bc05` | Frontend installed; built-in mock API preview HTTP 200; actual agent runtime is a separate SDK | 41 passed |
| [Skyvern](https://github.com/Skyvern-AI/skyvern) | `695c05698eba` | Python server/frontend installed; production frontend build and local API/UI HTTP 200 | 163 passed |

These are source/development installations with component proofs, **not six fully connected production systems**. No paid model tasks or personal Gmail/browser accounts were connected to them. Selected tests total 432; this is not a claim that their complete test suites pass. Research servers are stopped after checks.

Detailed reports record install commands, failures, source paths read, licenses, service boundaries and adopt/defer decisions:

- `reports/browser-research.md` — Browser Use and Skyvern.
- `reports/orchestration-research.md` — DeerFlow and OpenHands.
- `reports/product-research.md` — Kortix and OpenAgents.

The major sources of ideas were Browser Use's operator status surfaces, DeerFlow/Canvas starters and durable state, Kortix's prompt delivery states, OpenAgents's task-routed inbox and Skyvern's bounded recovery/failure presentation. All application improvements were written independently. No competitor code was vendored or copied. Root licenses reviewed: MIT (Browser Use, DeerFlow, OpenHands), Apache 2.0 (OpenAgents), Elastic License 2.0 (Kortix) and AGPL 3.0 (Skyvern). Mixed package metadata was not treated as overriding the root license.

Research installation caveats: Browser Use's upstream startup auto-detected local CLI/profile names and initialized logging/telemetry before its session-data override; the report records this. Kortix has source startup helpers that mishandled spaces in filesystem paths; research-only fixes and the resulting bounded UI checks are recorded separately. No such third-party runtime is embedded into Agent Workspaces.

## Verification and data preservation

The new schema is version 8. Its additive migration stores steering receipts and saved workflows. Version 7 and the original version 1 migration path are tested. A SQLite backup using the database backup API was made before opening production data with the new build; the backup passed `quick_check`. The pre-update production check found one succeeded task and zero enabled live tasks. QA uses `.test-data/improvements-desktop-review` and synthetic briefs.

Desktop checks exercised the actual Electron app: empty overview, six-starter gallery across three categories, inline first-agent creation, website-origin review, paused task creation, queued owner update, saving/reusing a workflow, independent second task, accurate first-run labels, browser setup status and light/dark appearance. Restart preserved two paused QA tasks, one saved workflow and one pending correction; model calls and enabled tasks stayed zero. No paid model request was made during this upgrade. Current provider credentials, Gmail validity and real end-to-end output quality of each starter have not been revalidated by these checks.

Final test and migration evidence is recorded in the research reports and the completion note below. Standard commands include the improvements suite:

```sh
npm run typecheck
npm run build
npm test
npm run test:electron
```

### Completion evidence

- Final host run: **424 passing checks** — 390 Node and 34 Python; 17 opt-in JavaScript checks skipped, zero failures.
- Final Electron run: **383 passing checks**, 17 opt-in checks skipped, zero failures.
- New improvements suite: **36 passed** on both Node and Electron — 18 steering/preflight, 7 workflow/persistence, 5 native-browser health and 6 overview/presentation cases.
- TypeScript check and production build passed after the final source changes. Full logs: `reports/final-host-tests.log` and `reports/final-electron-tests.log` in the research folder. Existing live-model/container checks remain explicit opt-ins; no new paid model or Gmail read was made.
- Production migration completed to schema 8 with `PRAGMA quick_check = ok`. Comparing all existing columns against the verified backup found agents, tasks, task messages, artifact/version records, task-file bindings, live configuration and model-call history unchanged. The original task remains succeeded, with zero enabled live tasks. Sanitized proof: `reports/production-migration-proof.json`.
- Production backup: `~/Library/Application Support/Agent Workspaces/control/backups/before-workflow-upgrade-20260930-121647.sqlite` (0600). This database backup accompanies the untouched existing artifact store; it is not a completed portable restore/export feature.
- The normal desktop app was reopened and verified with the preserved Mail Assistant result. It is left on **Workflows**. The QA app and research servers were stopped. Around 24 GiB of disk space remained after the development installs; dependency download caches also consume space.

## Market-fit hypothesis and remaining scope

The shared hypothesis is that users want a reliable path from a recognizable job to an inspectable result, with a small number of decisions along the way. Separate starter categories make that path usable across audiences. Competitor features and passing tests do not prove market fit.

Validate with real users by observing time to first useful deliverable, where setup/input requests block completion, whether corrections are understood, and whether saved workflows are used again. Prefer direct observation before adding analytics; no new telemetry was introduced in this app. Development users should test source-review usefulness, business users should test data/comparison outputs, and personal users should test decision/mail briefs with explicit account consent.

Deferred: background scheduling and external triggers, a full workflow graph editor, multiuser/cloud administration, automatic long-term memory, personal cookie import, broader credentials/OTP automation and wholesale adoption of external runtimes. Phase 7's packaging, restore drill and integrated interruption release gate remain separate outstanding work. This update preserves the current isolation and publication boundaries rather than replacing the architecture.
