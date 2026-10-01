# Agent Workspaces product and market fit audit

30 September 2026 · Current product baseline: 0.6.2 · Recommendations, not an implementation plan approved for execution

**The strongest opportunity is to make Agent Workspaces deliver useful work repeatedly, with clear evidence and little supervision.** The private browser sessions, private files, recoverable requests and explicit publishing are valuable foundations. The largest current gaps are getting started, handling ordinary customer inputs, reviewing finished work and repeating a successful job.

The proposed positioning to test is: **A workspace where private agents turn your files and connected accounts into reviewable results, while you keep working.** Recurring work is a proposed extension, not a current capability. Local storage does not mean all processing stays on the Mac: authorized task content is sent to the configured cloud model.

This audit covers all six downloaded reference products, the current Agent Workspaces implementation and a smaller sample of adjacent commercial alternatives. It recommends 24 additions or substantial extensions. **Build the first useful experience, then select further features using customer evidence; do not implement the whole list at once.**

## What was examined

The source review followed onboarding, actual agent tools, browser control, file handling, collaboration, workflows, memory, integrations, recovery, costs, result review and distribution. Current official product pages, pricing pages and 17 selected public issue reports added commercial context and examples of friction. This was an extensive examination of representative implementation paths, not an every-line code review or a fresh end-to-end test of six installations.

| Product | Downloaded source revision | Detailed audit |
| --- | --- | --- |
| Browser Use Desktop | `f073b7574f7927185ebbebd87556391d5cb0cfd1` | [Browser products](<market-research/browser-products.md>) |
| Skyvern | `695c05698eba52716521dd2b49800e88f314b660` | [Browser products](<market-research/browser-products.md>) |
| DeerFlow | `f75d89f39dd152873bf2b6486052644a77e830fb` | [Orchestration products](<market-research/orchestration-products.md>) |
| OpenHands and Agent Canvas | `1ec86616bc0511b1e56269fd6ba5872438f4fb7f` | [Orchestration products](<market-research/orchestration-products.md>) |
| Kortix and Suna | `7df56c8b3afafe1ef89e5f06e0fd29af10bca55d` | [Workspace products](<market-research/workspace-products.md>) |
| OpenAgents | `d46d087dca2279eac25414621e6af91bc8b3338b` | [Workspace products](<market-research/workspace-products.md>) |

These reports contain the pinned source links, loading paths, feature availability qualifications, public issue samples and structured evidence inventories. Source files live in `~/Desktop/Agent Workspaces Research 2026-09-30/repos/`. Installed dependencies are not proof that a competitor's backend, credentials, cloud services or optional features work locally.

Evidence is treated as follows: **implemented** means a relevant source path exists and was traced; **documented or marketed** describes a public claim; **historically tested** refers to existing project evidence; **proposed** is our recommendation. No paid model calls, customer interviews, fresh account tests or competitor runtime tests were performed for this audit. Issue reports are examples, not representative demand or defect rates. Recommendations are original product designs; no competitor code, prompts or assets were copied.

## Where our product stands

Confirmed choices remain Mac first, cloud model APIs first, OpenAI initially, isolated containers for code, locally remembered agent logins and persistent data under `~/Library/Application Support/Agent Workspaces`. The earlier choice of all audiences remains in scope. These do not establish a particular pricing model, a cloud hosting plan or equal demand across customer groups.

| Area | Current implementation | Customer consequence |
| --- | --- | --- |
| Control and continuity | Private agent browser profiles and files; durable tasks and requests; pause, stop, exclusive human takeover; bounded model and tool execution | A useful foundation for work that needs occasional help without taking over the personal browser |
| Browser agent | Approved-origin open, observe and navigate; narrowly approved upload on the container route | General click, fill, select, tab management and download are not exposed to the live model. A browser UI is not yet broad web automation |
| Browser evidence | Bounded main-document text, with coverage limits | Website review can inspect observed content. It is not visual, accessibility, performance or complete interaction testing |
| Files and code | Immutable versions, validated imports, pinned inputs, offline Python/Node/shell and retained outputs | Good provenance; PDF/XLSX semantic analysis is not supplied by the standard-library default runtime. Source extensions such as `.py` and `.ts` currently get metadata classification rather than safe text preview |
| Results | Private Markdown/text reports, file export, publication, plain-text or metadata preview | A customer must do extra work to judge and turn the result into a polished deliverable |
| Reuse | Six starter workflows and saved briefs with criteria and policy | They start manual tasks. They are not parameterized execution procedures or schedules |
| Gmail | Exact-account read-only headers/snippets, up to 50 messages per read; bounded browser fallback. API setup currently requires creating and importing a Google Desktop OAuth client | Useful bounded triage; not complete inbox understanding or attachment analysis. No Gmail draft creation or sending; private reply suggestions can only use the observed content |
| Collaboration | Shared board, reference-only messages, dependency waits and consumption of exact published versions | Existing collaboration should be reused. Published files are shared with all agents, so separate client spaces require new access rules |
| Throughput | Two live loops at most, one executing task per agent; one globally active code execution | Two agents cannot necessarily execute code together; visible queueing would be better than an unexpected busy failure |
| Release readiness | Source-based startup; existing regression evidence; Phase 7 release gates remain | Packaging, restore, integrated interruptions and sleep/wake must be demonstrated before broad distribution or unattended promises |

Sources: [live tools](<../packages/agent-loop/tools.ts#L6>), [browser observations](<../packages/agent-loop/index.ts#L191>), [file classification](<../packages/artifacts/safe-io.ts#L293>), [runtime dependencies](<../packages/code-runtime/README.md#L34>), [artifact previews](<../packages/artifacts/index.ts#L343>), [saved workflows](<../packages/workflows/index.ts#L99>), [shared access](<../packages/artifacts/index.ts#L110>), [code capacity](<../packages/code/index.ts#L171>), [Phase 7](<../implementation-plan.md#L167>).

### Material gaps that can mislead customers

1. **Artifact verification is not factual verification.** A valid, readable file and its evidence receipt do not prove every conclusion or completion criterion. Show “file checked,” “calculation checked,” “needs review” and “accepted by you” separately. The current completion guard and prompts are useful, but live semantic quality has not been established by this audit.
2. **Client organization needs actual isolation.** A client folder cannot change global publication access. Project rules must cover discovery, file reading, messages, browser/account binding, exports and task context. Existing private agent workspaces remain valuable, but are a different boundary.
3. **Knowledge attachments need tools that can read them.** Browser-only tasks exclude local file reading and shared-file consumption; Gmail tasks expose an even narrower branch. Add independent read permissions for selected inputs instead of granting broad workspace capabilities just to read a brief. [Tool filtering](<../packages/agent-loop/tools.ts#L31>).
4. **Effective output limits are smaller than advertised tool limits.** The adapter permits 16 KiB of tool arguments, while tools describe up to 48 KiB reports and 64 KiB code. The normal output allowance is 2,048 tokens per turn. Align these contracts and provide bounded multi-step artifact creation before promising long reports. [Adapter](<../packages/model-adapters/openai.ts#L7>), [default output allowance](<../packages/model-adapters/pricing.ts#L11>).
5. **Long work needs evidence retrieval.** The main task-context JSON is capped at 58,000 bytes; separate owner updates are preserved, while only a recent observation window is supplied. Instructions and tools also contribute to the complete request, which has a 128 KiB limit. Repeatedly sending context consumes the run's cumulative token budget. Add scoped retrieval of prior evidence and test cost on real jobs before expanding autonomy. [Context](<../packages/agent-loop/context.ts#L4>), [adapter limits](<../packages/model-adapters/openai.ts#L7>), [live limits](<../packages/contracts/live.ts#L18>).
6. **Privacy and availability need plain explanations.** Private profiles separate accounts; native Chrome is not a container boundary. Model requests leave the Mac, and local execution does not continue during sleep. The adapter uses `store: false`, which alone is not a blanket provider-retention guarantee. [Request construction](<../packages/model-adapters/openai.ts#L93>).

## What each reference product teaches us

| Product | Strongest relevant pattern | Proposed use in our product | Important qualification |
| --- | --- | --- | --- |
| Browser Use Desktop | Guided setup, practical browser interaction, reusable skills, outputs beside the conversation | Outcome-based onboarding, honest connection states, reviewed playbooks and useful browser tools | Cookie import is not our default; some provider adapters use a broader approval and host-execution model |
| Skyvern | Typed workflow inputs/outputs, extraction, human checkpoints, retries and scheduled runs | Parameterized jobs, precise review steps, managed downloads and understandable retry history | Local scheduling is implemented and enabled by default in the pinned code; Cloud uses a different backend. Cloud entitlements are distinct from source availability |
| DeerFlow | Project document shelves, report previews, durable scheduled work and scoped subagents | Explicit knowledge packs, better results and bounded repeated work | Scheduler and durable batches have configuration gates. Its project memory has a global-memory caveat; project grouping alone is not isolation |
| OpenHands and Agent Canvas | Developer workflow context, readable differences, automation setup and run health | Result comparison, recovery history and a developer review pack | Execution and automations depend on separate services. Critic is optional/experimental and is not proof that a result is correct |
| Kortix and Suna | Business starters, connector policy, reviewed changes, triggers and cost views | Connectors for real jobs, draft-and-review actions, versioned project knowledge and outcome economics | Infrastructure and provider setup are prerequisites. Do not adopt its documented legacy allow-all connector default |
| OpenAgents | Shared work UI, human workflow stages, knowledge, routines and priority inbox | Simple stage assignment, actionable requests and quiet completion notifications | Its default sharing model differs from ours. Its missing-judge workflow fallback is unsuitable for our evidence-based completion contract |

Source-by-source support and limitations are in the three detailed reports linked above. These patterns identify design options; they do not establish which customers will pay for our implementation.

## Commercial alternatives and expectations

The adjacent sample reinforces the value of connections, routines, usable outputs and human review. [n8n](https://n8n.io/ai-agents/) markets agent steps combined with deterministic workflow logic, reviews and evaluation. [Zapier Agents](https://zapier.com/apps/agents/integrations) exposes app-event and schedule triggers. [Lindy](https://www.lindy.ai/pricing) markets recurring work, connected context, drafts and approvals. [Relevance AI](https://relevanceai.com/pricing) emphasizes enterprise integrations, evaluations and governance. These are public offers, not audited deployments.

| Public offer checked on 30 September 2026 | Published entry point | Interpretation for our product |
| --- | --- | --- |
| [Skyvern Cloud](https://www.skyvern.com/pricing) | Free; Hobby $29/month; Pro $149/month; enterprise custom | Browser-operation plans bundle different allowances and entitlements |
| [Kortix](https://kortix.com/pricing) | Free tier; Team $40/seat/month; enterprise | Business workspaces face both free and paid alternatives |
| [OpenHands](https://www.openhands.dev/pricing) | Free local OSS and individual SaaS; provider usage/BYOK; enterprise custom | Generic access to an agent is a weak paid differentiator |
| [OpenAgents](https://openagents.org/faq) | Free/open source; underlying model/provider costs | Multiple agents and shared UI alone are insufficient paid positioning |
| [Zapier Agents](https://zapier.com/pricing) | 400 free activities/month; Pro $400/year, displayed as $33.33/month, 1,500 activities | An activity is not one finished job; do not compare it directly with our model calls |
| [Lindy](https://www.lindy.ai/pricing) | Plus $29.99/user/month; Pro $99.99; Max $199.99 | Credit allowances differ; these are category anchors, not evidence of our price |

A separate Desktop tariff was not established for Browser Use; its Cloud pricing must not be presented as the Desktop price. A paid end-user tier was not established for DeerFlow in this review. The retrieved Relevance AI page showed a custom enterprise offer, not a public numeric entry price.

**Inference:** customers are more likely to value a dependable completed job than our number of agents. A plausible advantage is combining private account contexts, explicit sharing and recoverable human help with polished recurring deliverables. Ease of setup and reliability must make that advantage visible. We have no conversion, retention or payment data that proves it yet.

## Three customer journeys to validate

Supporting all audiences is compatible with testing them separately. Preserve one engine and three clear entry points; direct later investment toward observed repeat use and support cost.

| Audience | First bounded job | Experience to aim for | Current limit to disclose |
| --- | --- | --- | --- |
| Business and agencies | Compare two sales CSVs or approved competitor pages and prepare a weekly client brief | Choose client → select files/sources → review calculations and sources → export → repeat with new inputs | Client scope, branded exports and scheduling are proposed. Start with supported inputs and Markdown/table results |
| Developers | Review supplied source text or page content and return evidence-linked findings | Select files → state question → inspect reproducible findings → request revision → export review | Native source-file text support needs improvement; no automatic Git checkout, full IDE workflow or visual QA promise |
| Personal use | Prioritize a bounded unread-mail listing or compare supplied options | Choose account/question → see exact coverage → inspect useful items → open originals → keep a reusable job | Gmail currently uses headers/snippets and a bounded listing; full-thread and attachment analysis requires new work |

For agencies, client separation and repeatable reporting are a promising payment hypothesis. Developers already have many capable tools, so target a specific review or evidence workflow instead of a complete coding-agent replacement. Personal tasks can be frequent but should be tested for setup tolerance, trust and willingness to pay. These are hypotheses, not segment rankings established by research.

## Prioritized feature backlog

**P0** completes the first usable experience. **P1** candidates follow demonstrated repeat use and should be selected, not all started together. **P2** requires a specific customer pull. Effort is relative: **S** is a bounded addition, **M** spans services/UI, **L** introduces a substantial lifecycle, data boundary or integration. It is not a delivery estimate. Impact and priority are product judgments; customer demand remains unmeasured.

### First useful experience

| ID | Priority and size | Feature and first slice | Why it matters | Dependencies and acceptance |
| --- | --- | --- | --- | --- |
| F01 | P0 · L | **Installable Mac release and recovery.** Local package, checkpoint-safe backup/restore, clean stop and sleep/wake handling | Makes the product usable beyond a developer machine | Complete Phase 7 integrated scenario and restore drill on a clean data root. External distribution adds signing/notarization and an update plan |
| F02 | P0 · M | **Guided setup and task doctor.** Check only the selected job's model, account, browser, runtime and input requirements | Reduces abandoned setup and repeated troubleshooting across all audiences | Reuse existing health checks. Show configured, tested, expired and not tested distinctly. Preserve task drafts; native Chrome reading needs no code container, while the container-browser route requires Docker |
| F03 | P0 · M | **Result review desk.** Render Markdown and tables, show sources/coverage, compare versions, Accept or Request changes, exact export | Turns output files into something a person can use and trust | Reuse immutable artifacts. Separate integrity, criterion checks and owner acceptance. Untrusted result content must not run scripts in the app |
| F04 | P0 · M | **Task acceptance and quality evaluation.** Simple success checklist and representative task fixtures | Detects plausible-looking but incomplete work | Include planted omissions, wrong calculations and partial source coverage. Align output-size limits; no unsupported “checked” status. Evaluate live model quality separately with an explicitly chosen budget |
| F05 | P0 · L | **Ordinary file support and polished exports.** Start with safe source-text formats, CSV tables/charts and a reviewed report export; then PDF/XLSX parsing and DOCX | Opens real business and developer work without manual conversion | Reviewed pinned runtime dependencies, extraction coverage and bounds. Preserve spreadsheet values/types; never run macros. Test import → calculation → preview → export on the same exact versions |

### Repeatable work and wider useful capabilities

| ID | Priority and size | Feature and first slice | Why it matters | Dependencies and acceptance |
| --- | --- | --- | --- | --- |
| F06 | P1 · M | **Parameterized jobs.** Named file/input slots, output schema, sample input/output and versioned procedure | Repeating a job becomes filling a form rather than rewriting prompts | F03–F04. Reject missing/wrong inputs before paid work; three new input sets produce the promised schema; do not clone credentials or grants |
| F07 | P1 · L | **Client/project spaces and reviewed knowledge.** Selected briefs, rules, sources and reusable jobs | Reuses context without mixing customers | New project access rules and independent read-input capabilities. Three conflicting client fixtures must not cross retrieval, sharing, messages or account boundaries |
| F08 | P1 · M | **Source discovery and research receipts.** Approved web search, selected-source fetching, citations and coverage | Research can discover evidence rather than require every URL from the user | Search-provider setup, costs and destination policy. Respect access restrictions; record retrieved dates, distinguish conflicting sources and preserve source receipts |
| F09 | P1 · L | **Selected Drive and Sheets connection.** Import chosen files/ranges as versioned inputs | Removes repetitive exports for business reports | OAuth/account lifecycle, scopes, pagination, revocation and data snapshots. A stale/wrong account cannot silently supply inputs; no writes in this slice |
| F10 | P1 · M–L | **Gmail review beyond snippets.** Paginated search, explicit full-thread access and selected safe attachments | Makes mail prioritization and follow-up analysis more useful | Decompose current Gmail tool restrictions; clear account and coverage, attachment validation and new consent as needed. Keep current read-only behavior unless a separate action is approved |
| F11 | P1 · L | **Local recurring jobs.** Repeat a previously accepted job daily/weekly with next run, timezone and history | Creates ongoing usefulness | F01, F04, F06 and stable required sources. Durable occurrence identity, non-overlap, caps, expiry, missed-run policy and pause-all; restart/sleep cannot produce duplicate dispatch |
| F12 | P1 · M | **Change summaries and actionable notifications.** What changed since the accepted result; alert only when useful | Reduces monitoring and notification fatigue | F03 plus durable events; F11 for recurrence. Detect new information separately from wording changes; deep-link to the exact result/request; quiet hours and stale-action checks |
| F13 | P1 · L | **Useful browser actions.** Fresh-target click/fill/select, task tabs and managed downloads; form staging only where the site supports it | Enables portal work and meaningful interactive checks | Policy/broker changes and native/container capability matrix. Typing can autosave: approvals bind account, target, operation, payload and revision. Reconcile uncertain outcomes through authoritative state or idempotency; if unverifiable, stop for review without automatic replay |
| F14 | P1 · M | **Recovery view and resource queue.** Last successful step, cause, safe repair, waiting resource and retry history | Makes troubleshooting understandable without babysitting | Existing checkpoints, receipts and code-capacity limits. Queue two code jobs predictably; expired login, runtime loss, canceled work and unknown outcomes have distinct recovery paths |
| F15 | P1 · M | **Outcome and cost history.** Accepted, revised and abandoned results; intervention time; estimated spend per accepted result | Helps users decide which jobs are worth keeping | F03 acceptance state, workflow linkage and local metrics. Include failed attempts and distinguish provider estimates from invoices or self-reported time saved |
| F23 | P1 · M | **Context and model budgets suited to the job.** Scoped evidence retrieval, bounded artifact writing and evaluated model choices | Prevents long jobs from losing evidence or repeatedly paying to read it | F04 evaluations; retain owner caps and initial OpenAI support. Model change never changes permissions; measure quality/cost before introducing other providers |

### Add when recurring customer work justifies them

| ID | Priority and size | Feature and first slice | Why it matters | Dependencies and acceptance |
| --- | --- | --- | --- | --- |
| F16 | P2 · M–L | **Read-only GitHub context.** Selected repository/commit/diff import with provenance | Reduces developer copy/paste and stale source review | F05 and a scoped connector. Pin commit and file limits; never imply a full repository was read from a partial diff |
| F17 | P2 · M | **Calendar briefing.** Selected calendar events plus approved context | Makes personal and business daily briefs more actionable | Read-only connector and optional F11. Exact calendar/account/timezone; no meeting edits in the first slice |
| F18 | P2 · L | **Draft and approve external actions.** One requested email, ticket or CRM update type | Closes the gap between a recommendation and useful execution | Stable read connector and explicit operation grants. Show account, recipient/object and exact before/after; revised drafts invalidate approval; reconcile uncertain sends |
| F19 | P2 · M | **Visible two-agent workflows.** Researcher → reviewer, with owner-visible assignments and shared budget | Makes existing collaboration understandable | F04/F06 and exact published handoffs. Compare against a single agent; keep only if quality or elapsed time improves enough to justify cost |
| F20 | P2 · M | **Tested playbooks.** Reviewed procedure, permitted tools, known inputs and held-out examples | Improves specialist repeatability | F04/F06 and versioning. Promote changes only after tests; retrieved instructions cannot self-install tools or expand authority |
| F21 | P2 · M | **Portable workflow and task packs.** Export selected definitions, evidence and results; import as disabled drafts | Supports reuse, handover and support | F01/F06, manifests and compatibility checks. Exclude tokens/cookies/private history by default; rebind accounts and grants after import |
| F22 | P2 · S–M | **Quick capture.** Send a selected URL/file or explicitly pasted text into a task draft | Reduces friction while the user continues other work | Local shortcut/share entry point with preview. No background clipboard monitoring; capture creates a draft rather than silently starting paid work |
| F24 | P2 · L | **Visual website QA.** Screenshots, interactive steps and reproducible evidence | Broadens agency/developer audits beyond page copy | F13 plus evaluated image-capable model flow and fixture sites. Separate visual checks from actual accessibility/performance tests; all findings need observable evidence |

These are extensions to existing infrastructure, not 24 missing systems to build from scratch. For example, requests, publication, file versions, costs, workflow starters and bounded recovery already exist.

## Five feature designs worth making concrete first

### Guided setup for a chosen result

Start with “What should be ready when this finishes?” Show three outcome lanes and a sample finished result. After selection, show only necessary prerequisites and input requirements. A CSV analysis needs a prepared code runtime; native Chrome page reading needs no code container, while the container-browser route still requires Docker. An account card shows which identity is connected and when usable access was last checked. A probe that spends money is labeled with its scope and cost bound.

The current Gmail API setup asks the user to enable the API, create a Desktop OAuth client and import its JSON. That is a material barrier for a nontechnical pilot. Evaluate an application-managed connection flow and its provider prerequisites before promising simple consumer onboarding; a reconnect button alone does not remove this work. [Current Gmail setup UI](<../apps/desktop/renderer/Gmail.tsx#L51>).

Repair suggestions can reconnect an account, reopen the agent session, validate files or start an installed runtime through controlled paths. They cannot evade a site's login restrictions, sign in as a different account, install arbitrary packages or repeatedly submit an uncertain action. The task draft survives every setup detour.

### Results that a person can inspect and revise

The finished view should lead with the deliverable. Below it, show what was checked, missing coverage, sources, input versions and cost. A criterion can be “checked by calculation,” “supported by observed source,” “needs your review” or “not met.” A human Accept action is a separate event, tied to a version.

“Request changes” creates a bounded continuation that retains prior evidence and the owner's correction. Side-by-side versions show whether the requested change was made. Export uses the reviewed exact version. External delivery is a separate explicit action. Start with safe Markdown/table previews; add PDF/images and branded exports through the reviewed file pipeline.

### Reusable jobs with clear inputs

A saved job should explain its purpose, required files/accounts, allowed sources, expected output and acceptance checks. The first editor can be a short ordered list: gather → calculate or research → compose → review. Use deterministic code for calculation and validation; reserve the model for interpretation and writing.

Every run pins a definition version and records its inputs. Editing a template affects future runs only. Example inputs and an example output make the workflow understandable before credentials are connected. Start with a weekly CSV comparison; postpone a general graph editor.

### Project knowledge that respects client boundaries

A project includes approved reference versions, account bindings and workflow definitions. The owner can see why a task received each item. New memory is proposed as a reviewable change with a source and date. Expired guidance is visible; replacing it creates a new version.

This requires access enforcement, not just navigation. A project-specific publication must not become globally readable. Read-only browser and Gmail jobs need narrowly scoped access to the selected knowledge. Do not solve this by enabling broad tools or silently collecting all conversations into memory.

### Repeated work that remains under control

Enable a routine after a successful reviewed run. Its confirmation states the timezone, source accounts, pinned procedure, maximum run/monthly spend, review behavior and what happens while the Mac is unavailable. Start with read-only jobs and skip/coalesce missed occurrences rather than a catch-up burst.

On an expired account or missing input, create one actionable request and preserve progress. No-change runs can remain quiet. The history records skipped, delayed, blocked, failed and accepted results separately. Always-on cloud execution is a separate future decision; a local schedule cannot make a sleeping Mac execute work.

## Better design across the product

The existing Overview, Needs you, Workflows and file views are a useful base. Improve their hierarchy instead of adding many competing dashboards.

| Moment | Proposed change | What the user should understand |
| --- | --- | --- |
| Home | Lead with needs-you items, active work and usable results; show agents as workers attached to outcomes | What needs me now and what has finished |
| New work | Guided outcome, required inputs, example output and capability limits | What I will receive and what I must provide |
| Running | Current stage, last completed step, expected next intervention, cost and meaningful wait reason | Whether it is working, waiting or unable to continue |
| Browser takeover | Visible account/profile, current controller, pending action and clear return control | I can help this agent without using my personal session |
| Result | Preview, criterion evidence, coverage, version comparison and revision action | Whether I can use it and what remains uncertain |
| Connections | Account, exact readable resources, permitted actions, last test and reconnect | What the agent can access and why |
| Reuse | Procedure version, last accepted result, input differences and run history | Whether this is dependable enough to repeat |

Keyboard navigation, preserved drafts, readable errors and clear stop/wait states belong in the release work. Never substitute a percentage for unknown progress or call an attached credential a verified connection. Basic local notifications can help before scheduling exists; remote review requires additional identity and authorization design.

## Sequence by demonstrated outcomes

| Gate | Work | Evidence needed before expanding |
| --- | --- | --- |
| A — usable local release | F01/F02; honest capability labels; fix the output-contract mismatch | Clean-machine setup, integrated interruption scenario, restore proof, correct readiness states and no hidden paid probes |
| B — useful outputs | Small F03/F04/F05 slice, three bounded outcome packs | People inspect and accept real outputs; calculations/coverage correct; supported input/output formats explicit |
| C — repeat the same job | F06 plus the one connection or knowledge improvement most requested by pilots | Users voluntarily run it with new inputs; lower preparation/correction effort and affordable total cost |
| D — reduce supervision | F11/F12/F14 and only the necessary browser/connector expansion | Restart/sleep/cap/revocation tests plus repeated real jobs without duplicate effects or noisy alerts |
| E — close the action loop | Selected F18/F19/F20 or other P2 demand | A specific repeated job justifies it; reviewed external effects and incremental value are demonstrated |

**The first concrete implementation step should be an outcome-aware readiness screen on top of the existing checks, delivered with the Phase 7 local release gate.** Use the supplied-CSV report as its first complete path: choose the job, supply two valid files, check the runtime/model, produce a short evidenced result and review/export it. Test browser and Gmail setup as separate paths; do not make them prerequisites for the CSV job.

## How to test market fit

The following are proposed experiments, not work conducted or performance already achieved.

1. **Discover actual repeat work.** Interview 15 people, five in each audience group. Ask them to show the last time they performed the job, their actual inputs/output, current tools, frequency, sensitive boundaries and correction time. A feature request without a recent job is weak evidence.
2. **Observe activation.** Recruit 12 Mac pilot users, four per group. Record attempts that fail or are abandoned. Proposed gate: at least 9 reach a correctly scoped first result without developer intervention. Track both total time and active setup time; do not hide account-consent delays. A sample demo is not a real-task completion.
3. **Measure usefulness.** Use 20 representative outputs, including partial sources, difficult files and planted errors. Require zero unsupported “checked” labels. Record whether the user can use the result, source verification time and editing minutes. A successful fixture is not a live task success rate.
4. **Measure voluntary return.** Follow the 12 users for four weeks. A proposed continuation gate is at least 6 completing and accepting the same job with new inputs in week two, and at least 4 doing so in week four. Examine each audience separately; these small counts are decision aids, not statistically established PMF.
5. **Test payment after value.** Offer a clearly scoped paid pilot only after repeated accepted results. Record actual commitments, objections and support cost. Test a local BYOK license against an optional managed-service concept; do not build billing/hosted execution or invent a price from competitor tiers first.

Primary measure: **accepted useful results per active user per week**. Supporting measures: first-result completion, setup abandonment, repeated workflow use, manual intervention minutes, corrections, false completion, missed/duplicate occurrences and total estimated cost per accepted result including failed attempts. Claimed time saved must be based on an observed baseline or labeled as user-reported. Keep research records and optional telemetry consented and avoid collecting private content merely to count outcomes.

Use small, job-specific demos for distribution: a real weekly client report, a reproducible developer review and a clearly bounded mail brief. Compare referral and repeat-use signals across those packs before widening promotion. Sales conversations, pilots and publication are future actions, not authorized outreach performed by this audit.

## What to postpone

Postpone unlimited agent spawning, a giant workflow canvas, an unrestricted connector/skill marketplace, autonomous self-modifying memory, a mobile/cloud rewrite, enterprise administration and additional model providers until an observed job justifies them. Voice and avatars do not address the demonstrated setup, input or result gaps.

Do not adopt cookie harvesting, shared personal browser access, host-shell execution, model-only permission decisions, silent mailbox writes or global client memory as shortcuts. Preserve the confirmed private-workspace and container requirements. License and deployment obligations differ across references, so any future reuse of source requires a specific review rather than assuming every repository is interchangeable.

The near-term decision is to prove three small useful experiences on the existing engine, then invest in the repeatable job that customers keep using. Breadth can remain in the product vision while implementation follows evidence.

## Audit files and verification boundary

The three detailed product reports and their JSON companions live under [market-research](<market-research>). The consolidated backlog and source-baseline hashes are in [market-fit-backlog.json](<market-research/market-fit-backlog.json>).

This audit added research documents only. Existing application behavior, accounts and saved work were not changed. Historical tests are described in [prompt verification](<prompt-research/verification.json>); they were not rerun for this document-only audit and do not establish live semantic quality, clean-machine release readiness or market fit.
