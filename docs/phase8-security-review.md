# Security Review teams

This feature prepares a finite, owner-created team to review imported code, configuration and local training-lab evidence. It performs static, defensive analysis of chosen files. It has no target browser, network requests, command execution, exploit execution, credential access or dynamic agent creation.

## Owner flow

1. Import and deliberately publish the selected evidence inside its project. Supported inputs are UTF-8 text, Markdown, JSON and CSV; code can be imported as text. Select up to eight exact versions, no more than 64 KiB per file and 256 KiB total. The chosen agents and files must be in the same project.
2. Choose three distinct agents, one model connection and normal task limits for each role: code/configuration review, independent evidence review, and report synthesis. The summed per-role limits give the fixed team ceiling; models cannot create extra roles or increase limits.
3. Creating a team saves three paused tasks. The first role becomes ready after verified input staging. Starting a task remains an explicit owner action and uses its selected model and budget.
4. After a role completes, review its exact final output. Approve publishing that version for the next role and choose **Prepare next review**. The next reviewer receives the same immutable originals and the approved preceding report. The final synthesis receives both preceding reports. Preparation never starts a paid run automatically.
5. Pause, resume, stop, clarification requests and checkpoints use the existing task controls. A failed preparation preserves the fixed scope and can be retried; cancelled tasks are not revived. Changing source scope requires a new review.

Handoff publication makes the exact report available under the existing project-sharing rules. It does not accept the result as correct. Findings, Evidence, Impact, Remediation and Coverage sections are required by each task’s completion criteria. Reports must identify potential findings and uncertainty, with no claim that a vulnerability was demonstrated against a live system.

## Runtime boundary

The task-specific tool allowlist contains `read_file`, `evidence_list`, `evidence_read`, clarification-only `user_request`, `save_report` and `finish`. `assertToolAllowed` rejects browser/network/code/credential/collaboration tools and rejects requests for new files, login or capability grants. An extra file manually attached to the task is not automatically inside the review’s saved input scope. The model may read its own private generated output for checking, as well as the selected inputs.

The coordinator and agent loop must consult this boundary for both tool advertisement and dispatch, filter model context to the selected sources, and block generic result revisions or scheduling that would create an unscoped extra task. Handoff/readiness checks must also run on direct task start and claim paths. These integration requirements are separate from prompt guidance; file text and owner messages cannot grant a new tool or source permission.

Imported evidence can still contain inaccurate statements, embedded instructions or partial data. It is evidence, not authority. Ordinary preview bounds still apply; reports must disclose truncation and unreviewed content. Text review is not a complete code scanner, malware scanner or verification of runtime behavior.

## Integration

- Migration: `SECURITY_REVIEW_MIGRATION`, `packages/security-review/migration.ts`.
- Service constructor: `{persistence, artifacts, createTask, validateModel, now?}`.
- Owner commands: `securityReview.state`, `securityReview.create`, `securityReview.prepareNext`, `securityReview.retryPreparation`.
- Runtime methods: `isReviewTask`, `allowedToolNames`, `allowedInputVersionIds`, `assertToolAllowed`, `blockingReason`, `context`.
- Lifecycle: `suspend`, `resume`, `drain` fence and wait for asynchronous input preparation.
- State exposes exact source versions, role/task membership, handoff receipts, per-role limits and model selections, summed cost ceiling and actual/reserved spend.

## Focused evidence

`tests/phase8/security-review.test.ts` passed eight tests covering finite paused tasks and idempotency, private/cross-project/oversized-source rejection, comprehensive tool exclusions and exact source scope, explicit publication handoffs without auto-start, and cancellation/restart preservation. Two integration cases exercise the real coordinator and task loop with synthetic model responses: attempted model and owner browser/code calls are blocked, unselected private inputs are excluded from model context, and all three roles produce structurally checked reports through two explicit handoffs with no extra tasks or browser/code launches. Generic workflow reuse, routine creation and result revision cannot broaden a Security Review role. A regression covers an interrupted member-ready/handoff-preparing commit: retry restores the same exact publication and inputs, keeps the next role paused, and creates no extra tasks or model calls. The final member/handoff readiness records now commit together.

These fixtures use temporary local data and synthetic model responses, never a hosted or local LLM. They do not execute imported code or contact a target. Packaged application and UI verification are recorded in [the release evidence](phase8-release-evidence.json). Local ad-hoc rebuilds may prompt again for macOS Keychain access to saved browser logins; that OS dialog requires owner input.
