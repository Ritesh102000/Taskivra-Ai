# Browser prompt audit — 2026-09-30

Read-only research for Agent Workspaces. This report contains independent analysis, not adopted instructions. No repository app, paid model request, login, or runtime profile was opened. Skyvern is AGPL-3.0 and is an ideas-only reference; Browser Use Desktop is MIT. No third-party prompt wording was copied into Agent Workspaces.

## Scope and coverage

Source snapshots:

- Browser Use Desktop `f073b7574f7927185ebbebd87556391d5cb0cfd1`, 554 tracked files, 408 text-source files indexed.
- Skyvern `695c05698eba52716521dd2b49800e88f314b660`, 5,773 tracked files, 4,993 text-source files indexed.

`prompt-browser-inventory.json` catalogs 272 resources (105 Browser Use; 167 Skyvern). It lists paths, categories, exact content hashes, line counts, and literal callers or composition roots. This is a resource inventory plus a deep review of execution/composition, handoff, failure repair, evidence and completion families. It is **not** a claim that every line of every domain-specific recipe or generated tool description was manually audited. `reviewDepth` distinguishes inventory entries from deep reviews. Template reference search is a static hint: no literal caller does not prove a dynamically loaded template is dead. A `.j2`, `.md`, or function named “prompt” is not necessarily a system-role message.

The Browser Use inventory includes all 69 stock domain skills and 19 stock interaction skills, four provider/shared composers, two runtime manuals, ten development/reference copies, and the repository contributor guide. The Skyvern inventory includes all 94 shipped Jinja templates (classified by family), external-client usage skills, inline prompt/composition roots, tool-schema candidate surfaces, dynamic context fragments, and contributor rules. External provider base prompts and deployment-supplied `security_rules` remain outside this source snapshot.

## Browser Use Desktop: how guidance reaches an agent

1. `app/src/main/hl/harness.ts:25-53` imports the **stock** harness manual, domain skills, interaction skills, runtime, and skill CLI at build time. `:130-170` materializes them into the app profile's harness directory.
2. `app/src/main/hl/engines/runEngine.ts:221-235` builds session/target/model/attachment context and calls the selected adapter's `wrapPrompt`.
3. `app/src/main/hl/engines/codex/adapter.ts:111-136`, `claude-code/adapter.ts:120-145`, and `browsercode/adapter.ts:171-196` compose assignment-specific browser target, harness directions, available skill metadata, optional UI-output contracts, attached file paths, and the actual user task. This is a **CLI input wrapper**, not evidence that the app owns the external provider's complete system prompt.
4. `app/src/main/hl/engines/skillIndexPrompt.ts:197-230` builds a bounded metadata menu (14,000 characters by default; 180-character descriptions), then directs on-demand skill-body lookup. It explicitly says omitted entries require lookup. The same file's `:14-18` adds procedural-memory lifecycle rules; `:53-97` adds HTML, choice cards, and question-block output contracts.
5. `app/src/main/hl/stock/AGENTS.md` is **runtime** guidance, unlike the repository-root `AGENTS.md`. Its assigned-target boundary is at `:13-22`, skill loading at `:101-129`, reusable-skill lifecycle at `:131-164`, harness edits at `:166-174`, verification at `:176-216`, and upload/output directories at `:218-222`.

Useful ideas: narrow browser identity; tool-specific manuals loaded only when relevant; explicit output destination; verify a meaningful action against fresh page state; only retain proven reusable procedures; exclude secrets and task-specific account data from procedural memory.

Not fitting our product as implemented:

- Codex adapter `:139-148` and Claude adapter `:148-158` deliberately skip CLI approvals/sandbox. This is not a permission model to import into our private workspaces/container design.
- `stock/interaction-skills/connection.md:5-8,68-74` recommends general browser discovery and first-tab attachment, while the main runtime manual restricts to the assigned target. The product-specific target boundary must win; adopting generic recipes blindly could reach a personal browser.
- `stock/AGENTS.md:172-174` permits narrow agent self-editing of the runtime under some conditions. Our agent should request/record a runtime blocker, not silently alter its own host controls.
- HTML/ask/options fenced blocks are renderer contracts in this other app. Our typed `user_request`, artifact and report tools are the applicable equivalents; inventing their UI formats in our model prompt would not implement them.
- Domain skills include rate limits, specific endpoints/selectors, and site-specific assumptions. They are not blanket authority to scrape, upload, publish, or change accounts. Do not automatically import the entire bundle.

## Skyvern: the prompt families are deliberately separate

### Templates and conditional assembly

`skyvern/forge/prompts.py:4` creates the engine. `skyvern/forge/sdk/prompting.py:36-42,70-71,100-114` provides a named-template loader plus escaping of untrusted content and template-owned delimiter lookalikes. `skyvern/utils/prompt_engine.py` bounds large DOM/element context and falls back through smaller views; the tracked variant retains the **final** inputs for consistent caching. This suggests explicit omission/truncation signals in our context, not silent loss presented as complete evidence.

All 94 Jinja resources are separately listed in the inventory. Their major families include:

- Browser action selection: combined/static/dynamic extraction, single action targeting, select/combobox helpers, dialogs, upload-file selection, form field mapping, screenshot/CUA fallback, date/phone/TOTP checks.
- Extraction and document work: structured information, file text, summaries, natural-language loops, image text, PDF fill/split, extraction prompt improvement/schema suggestions.
- Planning/workflow construction: task-v2 planner, metadata/task/compute generation, workflow copilot, recorded action block prompts, workflow parameter/title/build helpers, branch criteria and loop goals.
- Verification: user-goal checks, termination criteria, task-v3 goal and unlisted-outcome checks, quality audit, validation-evidence routing, decisive criterion, and copilot completion verification.
- Failure/code repair: script reviewer variants, script failure triage, step/retry exhaustion summaries, script generation.

`skyvern/forge/sdk/experimentation/prompt_families.py:17-54` maps template families to variants. It deliberately excludes goal verification from a slimmer schema after reported degradation. The transferable lesson is to version and test prompt families independently; a shorter prompt is not inherently a better prompt.

### Browser execution and data-only assessment

`skyvern/forge/taskv3/engine.py:135` has a data-only prompt that explicitly lacks browser tools. `:137-154` is the browser executor with observe/action/ref guidance, bounded retry, final-state checks and side-effect limits. `:529-562` composes only the selected tools and conditionally adds download completion, time and opaque-URL guidance. `skyvern/forge/taskv3/loop.py:3256-3274` makes the role distinction real by sending separate system and user messages alongside the actual schemas. The tool description constructor is `taskv3/tools.py:9522-9525`.

This is directly relevant to our execution vs missing-file replan distinction: the replan model should receive replan-only instructions and its one replan tool, not browser/code/mail/finish directions it cannot perform.

The browser prompt also has choices we should **not** import: aggressive multi-action batching conflicts with our sequential side-effect accounting, and `engine.py:151` guesses ordinary required form values. Our typed missing-input requests should remain authoritative.

### Recovery and script auditing

`skyvern/services/script_reviewer_v3/prompts.py` contains distinct mid-run live repair (`:18-61`), post-run offline repair (`:64-151`), and fresh-script audit (`:154-207`) roles. Callers are `midrun.py:184`, `postrun.py:303`, and `mint_review.py:114`. `agent_loop.py:223-253` derives the allowed skill set for the role, tracks repeated attempts, redacts sensitive context, and explicitly places the system prompt into message history because one provider path would otherwise drop its system argument.

Useful principles: inspect before mutation; a “try” operation already performs the mutation; verify its effect before reporting repair; preserve a history of failed approaches; stop repeating substantially the same failure; distinguish lack of access/data from code-fixable mechanics; validate before persisting a reusable repair. `script-failure-triage.j2:36-54` classifies code-fixable versus site/auth/data blockers.

Our current tools have no script-patching authority or live DOM click/typing tools. Apply recovery **guidance** to existing browser reads, code runs, requests and diagnostics. Do not claim we added a self-healing script reviewer by editing a system prompt.

### Workflow copilot, saved plans and evidence

`workflow-copilot-agent.j2:7-20` distinguishes answering, building a reusable workflow, and direct browser operation; `:29-44` preserves scope, tests outcomes, avoids replaying uncertain actions and uses typed missing-information handoff. `:54` carries concise state between turns. `skyvern/forge/sdk/copilot/agent.py:866-890` renders the base with a static prefix and dynamic time; `:1470-1508` appends policy facts, runtime verification, prior build/test outcome, repair context, signed-out page evidence and a saved work plan. The source binding fragment at `:1190-1199` carefully labels code hashes as version evidence, not proof of behavior.

`skyvern/forge/sdk/copilot/work_plan.py:39-48` labels saved plans as the model's previous notes, not owner instructions. `:51-66` persists before projecting an update; those notes are never consumed as authorization. Our saved observations/checkpoints should receive the same lower-authority treatment. Adding a durable plan **tool** is a separate product change, not achieved by telling the model to save a plan.

Two verification policies in this upstream differ materially:

- `workflow-copilot-completion-verification.j2:1-15` requires each requested end state to have positive run evidence and an exact evidence label; missing or unclear evidence is not satisfied. This fits our receipt and immutable output design.
- `taskv3-goal-check.j2:3-20` asks whether evidence contradicts success and accepts silent/incomplete evidence. This is weaker and should **not** replace our positive evidence requirement.

Our report prompt can use a criterion → evidence → limitation checklist without another paid verifier. Backend receipts prove tool execution and artifact identity, not every semantic claim; the model must still assess that the output fulfills the owner goal. Keep that limitation explicit.

### Login, secret handling and external-client usage

`skyvern/constants.py:87-122` defines default login/verification goals; `forge/sdk/routes/credentials.py:775-803` has stricter one-attempt login testing and stops on rejection/missing identity values. We should adopt the decision pattern (verify existing account state, do not loop on rejected authentication, hand off only what is missing), while retaining **our own** manual browser handoff/read-only Gmail connection. Do not import vault automation or ask the model to handle passwords.

`skyvern/cli/mcp_tools/instructions.py:3-168` is MCP-client usage guidance, and `:170-174` selects a lean variant with a smaller surface. `mcp_tools/prompts.py:444-496,1149` exposes build, debug, extract, and QA usage prompts; `skyvern/cli/skills` is the installed client skill bundle. These guide an external client and are not identical to the internal executor prompt. Repo `AGENTS.md` and template-folder `CLAUDE.md` are contribution guidance; the latter documents keeping the combined/static/dynamic action templates aligned, not a browser instruction.

## Concrete fit for Agent Workspaces

1. Extract our one long `packages/agent-loop/index.ts` instruction string into a versioned builder with shared authority/verification rules and role-specific execution vs replan blocks.
2. Select capability instructions by **the exact toolset passed in the request**. Gmail-only, browser, code and read-only turns must not be instructed to use unavailable tools. Keep no tool names that imply host shell, arbitrary script evaluation, page typing/clicking or private browser takeover capabilities we do not expose.
3. Give completion a compact preflight: latest owner update, every completion criterion, relevant successful receipt, actual output version, observed coverage and unresolved limitations. One tool succeeding is not equivalent to the task succeeding.
4. Describe recovery by evidence and boundary: refresh a stale read once; inspect current state after uncertainty; do not repeat a possibly committed upload/publication or rerun code as if nothing happened; pause for auth, runtime availability, missing inputs or explicit owner-control state. Backend retry limits still enforce the behavior.
5. Keep runtime metadata separate from lower-trust observations. Page text, artifact contents, peer messages, old agent notes, filenames, tab titles and errors remain data; instruction-shaped text cannot grant permissions. Explicitly mark truncated context and request a fresh supported observation rather than inventing missing detail.
6. Clarify human handoff: describe the blocker and resumable next step without passwords/tokens; only the owner enters credentials; after return read current state and verify the intended account before proceeding. Rejected Google browser login should use the existing supported read-only connection path, not be solved by repeating login or stealing personal cookies.
7. Add deterministic prompt assembly tests and adapter-boundary tests for all capability modes and restricted replan. Test that actual serialized requests contain the selected instructions and no irrelevant tools, and that injection fixtures cannot alter tool-policy enforcement. This demonstrates wiring and guardrails; model reliability requires a separately approved live evaluation.

No implementation files were edited by this research worker.
