# 0.8.0 — models, reliable results and scoped security review

Historical release record. In 0.9.0, [Fleets](fleet-implementation-status.md) replaces the fixed review creation screen with dynamic planning and automatic handoffs; previous tasks and results are preserved.

The planning documents remain the baseline. This release adds the bounded features below; it does not implement autonomous intrusion, live vulnerability scanning, unrestricted delegation or universal model compatibility.

## Delivered behavior

- **Security Review:** an owner prepares three distinct reviewers in one project: code/configuration review, independent evidence review, and synthesis. Each role has its own chosen model, saved task, private output and limits. The team ceiling is the sum of those three fixed allocations. Only selected immutable source files and explicitly approved report handoffs are available. Starting each role and publishing each completed report remain owner actions. Pause, stop, clarification and restart checkpoints use the existing task controls. An interrupted input handoff can be retried without duplicating publication, tasks or model calls.
- **Enforced review scope:** the model and dispatch paths allow only reading selected evidence, retrieving its saved receipts, asking clarification, saving a report and finishing. Browser, code, credentials, wider file access, dynamic agents and generic task/routine cloning are unavailable for review tasks. Three-stage model-fixture tests complete through the real task loop and exact handoff service. These are static potential findings, not demonstrated live-system vulnerabilities.
- **Model connections:** OpenAI Responses, Anthropic Messages, Ollama chat and OpenAI-compatible chat protocols; connection presets include OpenRouter, Together, Groq, LM Studio and LiteLLM. Owners specify exact model IDs, endpoint, declared pricing and limits. Existing tasks pin immutable revisions; editing a connection does not reroute them. Exact historical keys can be repaired separately. Native Keychain holds keys; localhost connections can omit a key. A configured connection is explicitly not a tested model.
- **Result checks and exports:** completion rejects empty, malformed or structurally incomplete results when the exact output contract can be checked. Partial inspection reports a coverage warning. Receipt membership is verified, not factual correctness. Results export text/Markdown as PDF or DOCX and CSV as XLSX, preserving exact source identity and treating spreadsheet formulas as literal text. Native save dialogs refuse overwriting existing files.
- **Recovery and alerts:** transient browser observations get at most two retries per incident and four per task. Pause cancels backoff; credentials, paid model requests, navigation and uncertain writes are not replayed. The Recovery view exposes the durable history. Routines compare saved outputs with an earlier accepted result, retain comparisons and suppress duplicate alerts. Imported sources are not automatically refreshed and alert delivery is in-app.
- **Backup:** verified nonsecret model configuration and all saved review records are included. Restore preserves model revisions but leaves execution and routines disabled; it does not copy Keychain credentials. The local pre-upgrade filesystem copy is separate from the portable backup format.

## How to use Security Review

1. Publish the source files within their project, then open **Security review**.
2. Choose those exact versions, describe the review scope, and select or create three reviewers. Choose each model connection and budget.
3. Select **Prepare review**, then **Run reviewer** for the first role.
4. Read its result and select **Publish report & prepare next reviewer**. Start that reviewer explicitly. Repeat for synthesis, then review/export the final report.

Evidence is limited to eight original files, 64 KiB per file and 256 KiB total. Supported source extensions are treated as text; Markdown, JSON and CSV are also accepted. Normal text-preview limits still apply and reports must disclose unread content. Choose only systems you own or are authorized to assess. Hosted models receive the selected evidence; local processing requires an owner-configured local model.

## Verification and limits

The complete JavaScript regression suite passes 612 tests with 18 opt-in skips under Electron. The prior complete Node run passed; the added interrupted-handoff regression and affected completion tests also pass in Node. The additional seven Phase 0 JavaScript checks and 34 Python checks pass. The 62 Phase 8 checks cover all four provider protocols, actual loopback HTTP, immutable connections, backup configuration, recovery, alerts, quality, exports and three-stage scoped review. No live LLM or paid provider request was used. Typecheck and build pass; the renderer has a nonfatal bundle-size warning.

Actual PDF generation and independent DOCX/XLSX parsing and LibreOffice rendering passed. A deliberately hostile PDF HTML fixture made zero loopback network requests and ran no JavaScript. Physical proof is retained in `.test-data/phase8-export-proof/`. It is synthetic test data.

Desktop fixture checks verified team preparation without starting a model, model-connection choices, concise task titles, scoped result controls and a complete PDF export through the native save dialog. The existing workspace migrated from schema 13 to 16; its agent, task, seven model-call records, project, and all four saved artifact versions remained unchanged and their stored file hashes were verified. No synthetic review was inserted into the owner workspace. See [release evidence](phase8-release-evidence.json) for exact checks and package identity. Packaging is local Apple Silicon with an ad-hoc signature, not public signing/notarization or a clean-Mac installation test. No model binaries or downloaded framework dependencies were installed. Compatibility still requires a text model supporting this application's bounded single JSON tool-call protocol; proprietary built-in tools and reasoning-state replay are unsupported. Spending uses declared prices and local reservations, not a hard provider-invoice guarantee. Automated checks do not establish market fit, semantic correctness or full security coverage.

## Source references

The implementation keeps the existing application architecture and uses selected coordination ideas: fixed role/task ownership, durable handoffs/checkpoints, explicit evidence contracts and bounded termination. Source references are the downloaded Microsoft Agent Framework, AutoGen, LangGraph and CrewAI inventories in the Desktop coordination-reference folder, together with the earlier DeerFlow report-contract review. They were selectively inspected, not exhaustively audited or installed. No offensive framework or incident exploit chain was copied.

Feature details: [providers](phase8-providers.md), [security review](phase8-security-review.md), [quality/exports](phase8-quality-exports.md), [recovery/alerts](phase8-recovery-alerts.md). The earlier [work-in-progress checkpoint](phase8-work-in-progress.md) is retained as historical evidence and is superseded by this release record.
