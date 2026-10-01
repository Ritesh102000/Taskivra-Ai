# Prompt and agent guidance upgrade — 0.6.2

The owner requested a deeper audit of the six downloaded products' system prompts, agent rules and tool usage, followed by suitable changes to Agent Workspaces. This update changes the actual model-request path and runtime recovery controls. It does not add an autonomous agent framework by copying another product's prompt.

## What was inspected

Three detailed reports and machine-readable inventories are preserved with this project:

| Sources | Audit | Inventory |
| --- | --- | --- |
| Browser Use Desktop, Skyvern | [Browser audit](prompt-research/prompt-browser-audit.md) | [Resource inventory](prompt-research/prompt-browser-inventory.json) |
| DeerFlow, OpenHands / Agent Canvas, its pinned runtime SDK | [Orchestration audit](prompt-research/prompt-orchestration-audit.md) | [Candidate inventory](prompt-research/prompt-orchestration-inventory.json) |
| Kortix / Suna, OpenAgents | [Product audit](prompt-research/prompt-product-audit.md) | [Candidate inventory](prompt-research/prompt-product-inventory.json) |

The review traced actual composition and delivery: primary agent prompts, restricted planners, subagent roles, tool descriptions, browser/login guidance, code/recovery rules, summaries/memory, workflow judges, task/persona templates, optional skills and contributor instructions. The reports contain pinned commits, exact paths and line references. OpenHands' runtime prompts live in a separate SDK; a sparse source-only checkout matching Canvas's configured v1.49.6 was added for that trace.

Inventory counts are deliberately **not** presented as counts of active system prompts. Some entries are optional templates, prompt consumers, tests, examples or developer guidance. Key composition roots and relevant families were read deeply; enumerating a skill catalog does not mean every recipe was manually audited. External provider base prompts, deployment-specific overlays, private custom agents and remote MCP descriptions remain outside these source snapshots.

## Implemented changes

| Change | Previous behavior | Current behavior and source of the idea |
| --- | --- | --- |
| Separate roles | One dense execution prompt was also sent to a model whose only tool was `replan_result`. | A versioned builder produces execution or restricted missing-file replanning instructions. Replanning preserves blockers or proposes owner-reviewed scope; no execution/completion guidance leaks into that mode. DeerFlow, OpenHands and Skyvern use real role-specific compositions. |
| Capability-specific guidance | The general prompt mentioned code, file consumption and browser operations regardless of the selected task tools. | Browser, files, offline code, Gmail, shared-input and transfer sections are selected from the exact request toolset. The same selector controls backend dispatch. Kortix, OpenAgents and DeerFlow compose instructions from actual capabilities. |
| Clear authority and continuity | Owner preferences, corrections, clarification responses and saved observations had weakly explained precedence; older history could hide required context. | Application policy stays above owner configuration, while owner directions are compared by submission order. Source files, peer messages, logs and old agent observations remain untrusted evidence. Optional context is trimmed with explicit omission counts, never by replacing the whole task with an excerpt. Oversized required context stops before model generation. |
| Accurate environment | The agent had input IDs and display names but no trusted container paths. Browser wording implied every private browser was container-isolated. | Workspace inputs include their exact private/shared `containerPath`; code instructions explain offline execution, working/output directories, commit status and meaningful output checks. Browser guidance names the assigned private session, exclusive owner control and native Chrome's managed-transfer limitation. |
| Evidence-based completion | A short general instruction required an output but gave little guidance for checking all requested results. | The model is instructed to compare every criterion and owner correction to actual evidence and the final output, distinguish facts/inferences/unknowns, and state coverage. A readable file or successful receipt alone is not proof of semantic correctness. Inspired by DeerFlow reports and the stricter OpenHands/Skyvern verification paths. Backend output/blocker checks remain mandatory. |
| Recovery and repeated failures | Certain invalid/denied tool calls could be repeated until the overall task budget ran out. | Guidance distinguishes code-fixable errors from missing files, auth, permission and runtime blockers; uncertain writes must not be replayed. Three consecutive identical recoverable failed actions pause the task. The comparison survives restarts, uses canonical argument hashes, and never logs raw failed arguments. Total task budgets still apply. |
| Honest browser/mail coverage | Browser text could be clipped without a visible coverage qualifier. | Browser results explicitly describe bounded main-document coverage and unknown/proven clipping. Redirect/login content remains redacted. Gmail guidance preserves returned-count, 50-message limit, `hasMore`, `summariesTruncated`, estimate-versus-total and no-body/no-attachment boundaries. Current UTC time is supplied for time-sensitive interpretation. |
| Inspectable prompt identity | A call recorded the model/request hash without identifying the instruction family. | Model-start events also record prompt version, role, selected sections and the exact instruction hash, without copying private input into the event. Maintainer rules and prompt/context regression tests are included. |

Implementation: [prompt builder](../packages/agent-loop/prompts.ts), [context preservation](../packages/agent-loop/context.ts), [tool contracts](../packages/agent-loop/tools.ts), [runtime loop](../packages/agent-loop/index.ts), [failure identity](../packages/agent-loop/failure-policy.ts), [maintainer guide](../packages/agent-loop/README.md).

The code-managed prompt structure, separate context and representative fixtures also follow [official OpenAI prompt engineering guidance](https://developers.openai.com/api/docs/guides/prompt-engineering). The existing pinned model and its budgets were retained; no model migration or price update was performed.

## Deliberately rejected or deferred

- Browser discovery that might attach to a personal tab, cookie import, broad host-shell permissions and shared-agent filesystem assumptions.
- “Read-only” behavior enforced only by a prompt, automatic package installation, runtime control-prompt self-editing and credential-bearing instructions.
- Completion judges that advance when the judge errors or evidence is inconclusive; quiet or missing evidence is not success.
- Guessing required input fields, automatic message acknowledgment loops, or asking for confirmation on every routine choice.
- Hidden paid reviewers, autonomous subagent spawning, global memory, skill installation, scheduling and general browser clicking. These require real product capabilities, accounting and validation; mentioning them in a prompt would not implement them.

All adopted wording and application code were written independently. No competitor prompt text or implementation was transplanted. The root licenses and any mixed-package caveats are recorded in the audits; Kortix and Skyvern were ideas-only references.

## Verification boundary

Deterministic tests exercise the real coordinator, request/replan flow, request preparation, context bounds, exact file paths, repeated failures, restart behavior and owner corrections. Existing permission/injection tests remain part of regression coverage. These tests use fixtures, not a paid model, personal mailbox or live browser/container.

Final validation: **453 host checks passed** (419 JavaScript + 34 Python), **412 Electron checks passed**, zero failures. Both JavaScript runs skipped 17 opt-in live checks. All **29 new prompt/context/loop/coverage/chronology checks** passed on both runtimes. Typecheck and build passed. The updated production app reopened idle, with task/file/message/model-history counts and usage unchanged; SQLite integrity was `ok`. Schema remains unchanged. A private source backup and local database backup were saved before this upgrade.

The [verification manifest](prompt-research/verification.json) records counts and source hashes. Full logs are in the temporary research folder under `reports/prompt-final-host-tests.log` and `reports/prompt-final-electron-tests.log`. Early fixture assertion failures were corrected and the same scenarios passed on rerun; the final full runs passed unchanged.

No paid model request, new mailbox read or live browser/container workflow was run for this upgrade. Passing these tests establishes request wiring and enforced controls; it does **not** establish an improved live model task-success rate, universal website compatibility, or completion of Phase 7 packaging/restore gates.
