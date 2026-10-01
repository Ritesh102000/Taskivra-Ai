# Configurable model providers — implementation and verification

This is a general-purpose model connection layer. It does not add offensive tools, change task permissions, allow network access in code containers, download models, or run any paid request. The provider layer is integrated into desktop IPC, per-task model selection, task dispatch and Settings. Release-wide desktop/package validation is recorded separately; provider configuration does not claim that an external model or account has been tested.

## Implemented source

- `packages/model-adapters/configured.ts`: adapters for OpenAI Responses, Anthropic Messages, native Ollama chat, and OpenAI-compatible Chat Completions.
- `packages/model-adapters/registry.ts`: private JSON registry with immutable model, endpoint, pricing and limit revisions. Existing tasks resolve their original selection IDs. Archiving removes a connection from new-task choices while preserving prior revisions.
- `packages/contracts/model-providers.ts` and `apps/desktop/main/provider-controller.ts`: owner connection commands with validation and an active-work mutation gate.
- `apps/desktop/renderer/ProviderSettings.tsx`: connection form, revision display, editing, archival, previous revision visibility and exact-revision key repair/removal. Presets cover OpenAI, Claude, Ollama, OpenRouter, Together, Groq, LM Studio and LiteLLM; model IDs and gateway prices remain owner supplied.
- Native Keychain helper source and wrapper accept a separate hashed account for each endpoint revision. The existing OpenAI owner item remains compatible. No key is stored in profile JSON, task records or event data.

Keychain presence checks use a two-second metadata cache with in-flight deduplication, invalidated on key mutations. Key material is never cached.

The registry constructor takes `filePath`, a `credentials(profile)` factory, and `legacyAdapter`. `options()` is synchronous and returns new-task selections. `selectable(selectionId)` validates new selections. `resolve(selectionId)` returns a cached adapter, including previous revisions. `state()` checks Keychain configuration without contacting a provider. The UI accepts `{ api: { command }, active, onChanged }`. The main process holds its existing maintenance gate around mutations and the runtime resolves the task's saved model revision at start and generation. `ModelAdapter.limits` caps output for historical revisions even after they leave the new-task catalog. Per-task readiness/status prevents an unrelated provider connection from enabling an unconfigured model. Nonsecret profile metadata is integrated with the recovery backup allowlist; credentials remain excluded and restored work remains paused.

## Boundaries

- Remote endpoints require HTTPS. HTTP is allowed only for canonical localhost, 127.0.0.1 and ::1. Redirects are disabled, so credentials are not forwarded to a redirected host.
- A changed endpoint gets a different Keychain item. Saving a same-endpoint revision can copy the previous key through the main process. Removing or repairing a key affects only the selected revision; older keys remain for older tasks until explicitly removed. Repairing a key changes no model, endpoint or limits. Archiving is not credential revocation.
- Every generated tool call is checked against the offered schema. Unknown tools, unexpected fields, malformed arguments, multiple calls in one turn, incomplete responses, model identity changes and invalid usage are rejected before tool dispatch.
- The adapter retains exact serialized request bytes, requires a reservation before dispatch, and permits one dispatch only. Timeouts, cancellation, HTTP errors and rate limits never trigger implicit retries.
- Each configured model reserves its entire declared input ceiling plus the requested output allowance at declared prices. Input request bytes also have a conservative local ceiling. This is a local accounting estimate, not a guarantee of an external provider invoice. Unknown/malformed usage remains an uncertain attempt for the existing coordinator to account for. Cached input is charged at the full declared rate; no discounts are assumed. Model/server accounting beyond the ceiling stops further actions.
- Local billing means zero provider fees are recorded; hardware, memory, electricity and server overhead are not measured. A localhost gateway that calls paid cloud models must use metered billing.
- Supported response shape is text plus at most one client tool call per turn. Models requiring reasoning-state replay, provider built-in tools or proprietary protocols need additional integration. Structured text that merely resembles a tool call is never executed.
- The server must return the configured model identifier and usable token counts. Prefer pinned model IDs, including explicit Ollama tags. Aliases that return another model ID fail closed. No guarantee is made for every model offered by a gateway.
- Saving a connection reports `tested: false`. No discovery API, paid capability probe, model installation, live Ollama run or live cloud-provider check has been completed.

## Verification performed

- 22 focused provider tests passed, including three real Coordinator flows proving selected local protocol dispatch, saved clarification/checkpoint, original model/output caps after edits/archive, and blocked start for a missing selected key. Adapter/registry coverage includes: four protocol translations; tool-result continuations; real loopback HTTP fixture; real redirect refusal; bounded failure responses; schema failures; immutable revision persistence; endpoint-bound key isolation and historical key repair with an in-memory test vault; and owner-controller validation.
- Existing model and connection-controller tests: 24 passed.
- Existing native-helper wrapper tests: one passed; the explicitly gated Keychain write/read test remained skipped. No real Keychain items were touched.
- TypeScript check passed at this stage. Native helper source passed Clang syntax checking with warnings treated as errors. The native helper was rebuilt without reading or changing any real credential. Packaging and deployment are separate release steps.
- These prove source integration and deterministic backend behavior, not actual cloud/local model compatibility. Provider account access and installed local-model availability were not tested. Desktop/package proof and release regression results belong to the release status notes; no live provider success should be inferred from these fixtures.

## References and implementation rationale

Official documentation reviewed on 2026-09-30:

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling): strict function schemas and explicit tool-result continuation.
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create) and [tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls): native `tool_use` / `tool_result` translation.
- [Ollama chat](https://docs.ollama.com/api/chat) and [tool calling](https://docs.ollama.com/capabilities/tool-calling): local chat endpoint, tool names and reported token counts.
- [OpenRouter](https://openrouter.ai/docs/quickstart), [Together](https://docs.together.ai/docs/inference/openai-compatibility), [Groq](https://console.groq.com/docs/openai), and [LiteLLM](https://docs.litellm.ai/docs/proxy/client_setup/overview): compatible endpoint presets. Presets are configuration conveniences, not verified account/model compatibility.

The downloaded DeerFlow `backend/packages/harness/deerflow/models/factory.py` was inspected for its separation of provider settings from UI/profile metadata and per-call copies. The implementation here uses a small explicit protocol layer and immutable saved profiles, with no upstream code copied or upstream dependencies installed. Reasoning dialect differences found in that factory informed the explicit compatibility limitation above.
