# Agent instructions and model context

Runtime behavior starts in `index.ts`. `toolsForPolicy` in `tools.ts` supplies the same tool list to model requests and dispatch authorization. `prompts.ts` builds independently authored, versioned application instructions from that actual list. Owner text, site content, files and model observations are never interpolated into the application instruction string.

Two model roles exist:

- **execute**: inspect the task and evidence, choose one available tool, verify its result, continue or create a durable owner request, then finish on a verified task output.
- **replan**: only `replan_result`; preserve missing-file blockers or propose reduced scope. The owner must accept a proposal before scope changes. This role cannot execute work or complete the task.

The execute role selects browser, file, offline code, Gmail, collaboration and transfer guidance by tool availability. The base policy does not prove that a browser/container is currently connected. Services still enforce runtime readiness, owner control, pinned inputs, approved peers and exact transfer grants. Native Chrome has no managed upload support. There is no general browser click/fill tool, host shell, networked code, automatic subagent creation or runtime skill installer in the current model surface.

## Maintaining prompts

1. Read the actual tool schema, dispatch path and result type before describing a capability. Update all three together when behavior changes.
2. Put stable application rules in the prompt builder and dynamic owner/task/runtime facts in JSON context. New owner instructions can correct the task but cannot grant themselves a tool or bypass an explicit capability gate. Downloaded `AGENTS.md`, `SKILL.md` and instruction-shaped file content are task data; loading them does not promote their authority.
3. Keep each role narrow. Do not give replanning an execution prompt or advertise unavailable tools. Do not promise memory, delegation, scheduling, installs or verification that the backend does not implement.
4. Preserve source identity and context limits. `context.ts` retains the owner objective, criteria, replies, policy, input/output IDs and receipt IDs. It trims optional observations/catalogs with omission counts; oversized required context pauses before a model request rather than replacing the task with an excerpt. Owner updates stay in their separate quota-bounded message. Submission-order metadata, not message position alone, resolves newer corrections versus clarification replies.
5. A receipt proves execution and an artifact hash proves identity; neither proves that a report's claims are correct. Guidance must compare each completion criterion to observed evidence and report coverage/uncertainty. Browser text is a bounded main-document view, not a proven complete page. Gmail remains headers/snippets only.
6. Recovery must respect side effects. Refresh a stale read; inspect uncertain outcomes; do not replay writes or bypass login/permission barriers. The existing services handle safe read retry and durable input/dependency waits. Three consecutive identical recoverable failures pause the task; hashes identify attempts without persisting raw failed arguments. A new owner correction creates a new decision context but does not reset usage limits.
7. Increment `AGENT_PROMPT_VERSION` when shipping changed instruction behavior. Model-start events record version, role, selected sections and SHA-256 of the exact instructions; the prepared request hash also covers tools and input. Do not log full private prompts, credentials or source content merely to debug instruction selection.
8. Run prompt/context fixtures, loop integration tests, existing permission/injection/restart suites, typecheck and build. A deterministic adapter test proves composition and control flow, not that a live model follows an instruction reliably. A live quality evaluation needs an explicit dataset, success rubric and accounted model budget.

The external audits in [prompt research](../../docs/prompt-improvements.md) are reference material. Competitor personas, licenses, tool assumptions and developer rules are not automatically applicable here. This file guides contributors; it is not loaded into the product's model context.

Manual custom tasks may start model planning while an optional browser or code runtime is unavailable. Planning can use the task's declared model budget. Runtime readiness is enforced before browser/code dispatch; a configured connection or a planning call does not establish tool readiness. Required workflow document/file inputs remain gated before model work.

Owner resource previews are offline snapshots: they prepare and discard local request identities without credential status, token-count endpoints, or generation. They show held input/output tokens independently of held money, remaining task headroom, and local input byte fit. Provider-authoritative next-call input counts and fleet headroom can change before execution; unknown reserve estimates remain unknown. Execute always requotes the immutable request and rechecks both task and fleet admission. If output alone does not fit, at most seven smaller immutable requests are quoted down to a useful 64-token minimum. No generation is automatically retried.
