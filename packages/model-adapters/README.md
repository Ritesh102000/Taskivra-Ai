# Model adapter and Keychain boundary

The Phase 5 adapter uses the OpenAI Responses API through native `fetch`. It exposes provider-neutral messages, function tools, usage, and quotes. It does not execute tools. The coordinator owns task authorization, leases, persistent budgets, and tool dispatch.

The default is the pinned **`gpt-4.1-mini-2025-04-14`** snapshot. OpenAI documents function calling and structured outputs for this non-reasoning model. Standard pricing verified on 2026-09-11 is **$0.40 input / $0.10 cached input / $1.60 output per million tokens**. `MODEL_CHOICES` exports these rates and source URLs. Adding a model requires verified pricing and an explicit adapter change; arbitrary unpriced models are rejected. [Model documentation](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [standard API pricing](https://developers.openai.com/api/docs/pricing).

## Exact request and durable budget sequence

```ts
const credentials = new MacKeychainCredentials({ helperPath: absoluteHelperPath });
const adapter = new OpenAIResponsesAdapter({ credentials });
const prepared = adapter.prepare({ instructions, input, tools, maxOutputTokens: 2048 });
try {
  const quote = await adapter.quote(prepared, { signal });
  // Coordinator: atomically reserve quote.inputTokens + quote.outputTokens,
  // quote.maxCostMicrousd, and one generation attempt; recheck the run lease.
  const turn = await adapter.complete(prepared, { signal });
  // Coordinator: atomically settle known usage/cost, then authorize each tool.
} finally {
  adapter.discard(prepared);
}
```

`prepare` is local and reads no credential. It retains immutable request bytes privately and returns only identity/hash/size/model metadata. `quote` makes one authenticated call to the official `/v1/responses/input_tokens` endpoint with the same input, instructions and tool schemas used for generation. OpenAI documents that this includes message formatting and tool-schema overhead. A repeated successful quote returns its cached result; a failed quote is not retried. A token quote is a separate network request, not a local estimate. [Token counting](https://developers.openai.com/api/docs/guides/token-counting).

`complete` requires that exact prepared object's successful quote and allows only one generation attempt. It sends `store:false`, `stream:false`, `service_tier:"default"`, `parallel_tool_calls:false`, `truncation:"disabled"`, and only strict function tools. It does not send previous-response IDs, built-in tools, reasoning options, or automatic retries. A standard-tier uncached input reservation plus the maximum output allowance gives a conservative price bound at the documented rates. Costs use integer microdollars rounded upward.

On a valid provider response, actual usage and cached-token discounts settle the reservation. On a refusal, incomplete response, or invalid tool arguments with valid usage, `ModelAdapterError.usage` and `.costMicrousd` still carry known billing evidence. Unknown outcomes have null usage and cost: the coordinator must retain the full token and money reservation, including after process restart. Usage above the exact quote raises `model_reservation_exceeded` with actual usage; further generation must stop. The adapter itself has no persistent ledger and does not claim to enforce an account-wide dollar limit.

## Tool and response limits

| Boundary | Limit |
| --- | --- |
| Serialized generation request | 128 KiB |
| Instructions / each input message | 32 KiB / 64 KiB |
| History messages / pending prepared turns | 64 / 8 |
| Exact counted input | 200,000 tokens |
| Generation output | 64–4,096 tokens; default 2,048 |
| Quote / generation total deadline | 20 seconds / 45 seconds, including credential read |
| Serialized provider response | 512 KiB, also enforced without Content-Length |
| Tools / returned tool calls | 32 definitions / at most one call |
| Tool argument JSON / returned text | 16 KiB / 32 KiB |
| Schema depth / nodes / properties per object | 12 / 2,048 / 64 |
| Argument array elements | 256 |
| Unused prepared-turn lifetime | 5 minutes |

Tool schemas require `additionalProperties:false` and every object property in `required`; nullable unions express optional values. The supported subset includes bounded strings, numbers, integers, arrays, nested objects, enums, const and bounded `anyOf`. `$ref`, arbitrary schema extensions and unsafe property names are rejected. Arguments are parsed and validated locally even when the provider accepted strict mode. Names use letters, digits, underscore and hyphen. [Strict function calling](https://developers.openai.com/api/docs/guides/function-calling#strict-mode).

All returned output is untrusted. The adapter rejects unknown tools, multiple calls, malformed arguments, provider built-in output and reasoning items before returning a turn. It retains no raw reasoning or opaque provider continuation. The coordinator can persist bounded ordinary tool results and reconstruct subsequent stateless requests. Owner authorization, content trust, browser destinations, file access and evidence-based completion remain separate broker responsibilities.

Timeout and owner cancellation abort the network operation and release response readers. HTTP, native helper and transport errors use reviewed static messages; raw provider bodies, exception objects, request headers and credentials are not logged. `store:false` disables stored Responses state; it does **not** assert zero provider retention or override the account's data policy.

## Native macOS credentials

Build explicitly, with no download or credential access:

```sh
node packages/model-adapters/setup.mjs
```

This compiles the local Objective-C source using Apple Security.framework and LocalAuthentication into `bin/keychain-helper`. The desktop passes its absolute path to `MacKeychainCredentials`; this directory is a local ignored build output. The production item is a non-synchronizing generic password with service `com.agent-workspaces.openai`, account `owner`.

The helper's `set-stdin` command accepts a bounded key only through a private pipe closed by its caller. It refuses interactive terminal input to avoid echo. Do not place a key in shell arguments, shell history, environment variables, source files, temporary files or logs. The owner setup controller writes directly to the child's stdin; success prints only `saved`. `status` reads attributes and prints only `configured` or `missing`. The app's `read` operation uses a private stdout pipe; do not invoke it in a terminal or inherit stdout into logs. A `delete` command removes only the fixed item. There is no bulk Keychain operation.

The helper verifies a stored value internally before reporting success and clears mutable key buffers. JavaScript strings and Security.framework-owned memory cannot be guaranteed immediately erased; credentials exist transiently in the trusted coordinator process for HTTPS authorization. No model key goes to the renderer, browser worker, code worker or task files.

## Verification

Default tests perform no model network calls and do not read the real owner Keychain item:

```sh
npx tsx --test tests/phase5/model*.test.ts
AW_MODEL_KEYCHAIN_TEST=1 npx tsx --test tests/phase5/model-keychain.test.ts
```

The explicit Keychain test compiles a separate helper with a unique test service, stores a synthetic value through stdin, checks round-trip/rejected-update behavior, and deletes only that test item. It never addresses the production service.

The live synthetic probe is a separate, paid opt-in; do not include its flag in default tests:

```sh
AW_MODEL_LIVE_TEST=1 AW_MODEL_EVIDENCE=1 npx tsx --test tests/phase5/model-live.test.ts
```

On 2026-09-11 it made one count request and one generation: 71 counted input tokens, a 128-token output reservation, 16 actual output tokens, a $0.000234 generation reservation and $0.000054 rounded usage cost. It verified one strict function call. `evidence/live-probe.json` records those numbers without the key or raw response. This establishes adapter protocol connectivity; it does not establish Gmail login, mail-task quality, or all agent-loop acceptance criteria.
