# Fleets — 0.9.0

Fleets is a separate navigation item implementing one objective → team planning → claims → concurrent work → findings → plan revision → combined result. The fixed three-role Security Review creation screen has been removed. Existing review tasks, reports, provenance and historical service records remain readable; the desktop rejects creation through the retired review command.

## Use the feature

1. Publish the code, configuration or saved lab evidence to the project's shared library.
2. Open **Fleets**, enter the outcome, select exact file versions, and choose the lead and worker models.
3. Set the fleet budget and optional per-task limits, then choose **Start fleet** once. **Save draft** prepares the lead and files without making a model request.
4. Watch Team, Shared work board, Plan revisions and Findings and messages. Open any underlying task to answer clarification or inspect progress. Use **Pause fleet**, **Resume fleet** or **Stop fleet** for the whole team.
5. Open the combined result when complete. It uses the existing evidence, acceptance and export interface.

Model connections are configured in Settings. Hosted providers receive the selected evidence; a local connection keeps inference at its configured local server. No model is installed automatically. Readiness means credentials/configuration exist, not that the provider has passed a live tool-calling check. Historical model revisions stay pinned during resume and new internal handoffs.

## Coordination behavior

The lead chooses specialist roles, work descriptions and dependencies through a versioned plan. There is no fixed reviewer roster. Workers claim ready work for their role atomically; a dependency must have a completed exact report before dependent work is claimable. Two model requests can execute concurrently, subject to the workspace-wide limit and one running task per agent.

Completed worker reports are published inside the project and staged as exact input versions for subsequent workers and the lead. The initial Start authorizes these internal handoffs; the owner need not click each one. Scoped messages carry file/work references and are treated as evidence rather than new permissions. The lead can add follow-up work and specialist roles, or cancel pending unclaimed items. Claimed and completed work retains its identity. A final report requires completed work and no unresolved active items.

Claims, task progress, plan revisions, messages, artifact versions and combined model usage are durable. Restart, sleep and backup pause active fleets; resuming scheduling alone does not restart model work. Stop is final for that fleet. An interrupted call retains its uncertain reservation. Required tasks that have failed or been cancelled need a new fleet; they are not silently replaced by unlimited retries.

## Current bounds

| Control | Default | Maximum |
| --- | ---: | ---: |
| Agents including lead | 4 | 6 |
| Concurrent tasks | 2 | 2 |
| Total work items, including cancelled work | 8 | 12 |
| Plan revisions | 3 | 4 |
| Fleet model spend | $5 | $50 |
| Fleet model calls | 100 | 300 |
| Fleet tokens | 500,000 | 2,000,000 |
| Combined active seconds across agents | 1,800 | 7,200 |

Each task also defaults to $2, 30 model calls, 50 tool steps, 150,000 tokens and 600 active seconds. The fleet allowance covers planning, all worker sessions and synthesis. Provider costs use saved rates; local model cost may be zero. Reservations and uncertain calls count toward the allowance. Active time is charged across workers and checked while model requests are pending, at the runtime timer's granularity.

Evidence is limited to 8 selected files, 64 KiB each, 256 KiB combined; supported inputs are text, Markdown, JSON and CSV. Reports are bounded to 64 KiB. Context includes up to 20 selected/report versions and the latest 12 relevant messages, with an explicit omitted count. A fleet stores at most 80 messages. The current installation supports 20 saved fleets and the existing overall agent capacity.

This first Fleet version reviews imported evidence. Its runtime does not expose browser, target network, code execution, account access, arbitrary cross-fleet collaboration, file requests or permission expansion. It can request clarification. The lead and workers have separate model selections; specialist-by-specialist model overrides and mixed execution capabilities are not implemented. Reports describe potential findings and missing evidence, not verified live vulnerabilities. The mechanism does not reproduce the Hugging Face incident.

## Implementation and verification

`packages/fleet` owns plans, claims, scheduling, report staging and total usage checks. `packages/agent-loop` supplies role-specific tools/prompts, bounded context, evidence receipts, model cancellation and budget reservations. The existing coordinator continues to own task leases, generation fencing and two-worker concurrency. Schema 17 adds Fleet tables without rewriting historical review tables.

Tests exercise a complete one-start workflow with two overlapping scripted model requests, three claimed work items, three messages, a second plan revision, exact report handoffs and final synthesis. They also cover stop/start races, aggregate limits, uncertain reservations, scope checks, recovery and migration. A saved synthetic desktop fixture is under `.test-data/fleet-ui-final-20260930`; its proof file explicitly records zero real model requests. Desktop checks open the board and combined report and save/stop a draft with zero model calls.

Encrypted container-browser profiles now unlock only on an actual container-browser launch. Opening Fleets, checking runtime status and cleaning up stale runtime resources do not unlock an unused browser key. Encryption/authentication and exact restoration tests remain in place.

Final verification passed typecheck, build, 639 Electron tests (18 optional checks skipped), all 27 Fleet tests on the host runtime, and the earlier 32 affected host checks. Phase 0 also passed 34 Python and 7 JavaScript checks. The 0.9.0 Apple Silicon package passed signature validation and all 30 packaged file hashes match the build.

The packaged app was opened in the existing workspace. Schema 16 upgraded to 17 with database integrity and foreign keys checked. Its one saved task, seven historical model calls and four artifact versions remained unchanged; every artifact hash matched the pre-upgrade backup. No Fleet test data entered the production workspace and no new model request started. The verified private backup is `~/Desktop/Agent Workspaces Backups/before-0.9.0-20260930-185444`.

Release checks and the production upgrade evidence are recorded separately in [fleet-release-evidence.json](fleet-release-evidence.json). Synthetic checks prove coordination and persistence behavior, not model intelligence or provider compatibility. No live provider test, live target test or paid model request is part of this release verification.
