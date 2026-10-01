# Fleet local website lab — 0.9.9

Version 0.9.9 includes **Test local website** in Fleets. A user supplies one objective; the lead plans work, specialists claim eligible items, exchange observations and pass exact reports back for a combined result. This mode assesses an actual app-owned synthetic website through its public interface. The earlier **Review published files** mode remains available with its original scope; its behavior is documented in [Fleet implementation status](fleet-implementation-status.md).

## Website and browser behavior

**Start training website** launches Harbor Desk at `http://127.0.0.1:4318/`. The app verifies that it started its own server. A process already occupying that port does not become an approved target. The site contains fictional data and training flaws; findings still require observed, reproducible evidence.

Each lab agent begins logged out, knowing only that fixed URL. It can discover public pages and self-register a fictional account through the website when registration is offered. No source pack, administrator credentials, hidden answers or preselected user accounts are attached to the task. Implementation assets and lab control endpoints are excluded from the agent's website tools.

The lab uses real Electron browser windows with a separate temporary session for each agent, independent cookies and multiple tabs. These sessions are ephemeral: closing the browser clears its storage, and reopening starts logged out. Website DOM controls and observations come from the loaded page; they are not simulated screenshots. Lab browsing requires no Chrome extension setup. The browser sessions run on the Mac; they are not Docker containers.

Agents use `lab_open`, `lab_observe`, `lab_action` and `lab_close`. Actions use exact controls from a current observation and its page revision. A fill, click or navigation may invalidate earlier controls, so the agent must obtain fresh observations. There are two browser slots; the lead closes its session while waiting so specialists can use them. The owner can inspect browser progress and use the existing take-control/return-control flow.

## Terminal and code tools

`lab_command` accepts a JSON argument array shaped like a small `curl` request. It returns one actual bounded HTTP response from the same fixed training website, using that agent's current synthetic browser cookies. Supported methods are GET, POST, PUT and DELETE, with small inline request bodies and limited headers. Responses are capped at 24,000 bytes, requests have a ten-second timeout, and redirects are returned without being followed.

This terminal tool does not invoke a host shell or execute the computer's `curl` program. Arbitrary websites, host files, executables, shell operators, upload/output files, proxies and credential headers are unavailable. Personal cookies are not imported. It is an HTTP checker for this local site, not an all-PC command tool.

`code_execute` provides Python, Node.js or shell **inside the existing offline isolated container runtime**. In this mode its mounted inputs are restricted to the same fleet's permitted report versions. It can calculate, compare or format observed evidence; it cannot contact the website, access its source or use the browser's cookies. Docker Desktop and the approved prebuilt code image must be ready before container execution can work. Adding this mode does not install models, dependencies or runtime images automatically.

Unrestricted computer control, arbitrary host commands, personal filesystem access and a general networked terminal are not supported by this feature.

## Coordination, evidence and controls

The lead creates incremental roles, work items and dependencies with `fleet_plan`. Workers use exclusive `fleet_claim` claims, exchange scoped `fleet_message` updates and save reports for their assigned work. Independent items can run concurrently within the saved fleet and workspace limits. Dependencies require completed exact report versions; messages alone do not establish a finding.

Successful page observations, page actions and local HTTP responses are saved as source receipts. Workers cite their own receipts in reports. Completed reports are published within the project and staged as exact input versions for the lead or dependent workers. The lead reads those reports, adds follow-up work when evidence calls for it, and synthesizes a final result after required items finish. The report sections are **Findings, Evidence, Impact, Remediation and Coverage**, with observed behavior, reproduced flaws and potential concerns distinguished explicitly. Structure and provenance checks do not certify factual correctness.

Website text, peer messages and retrieved reports remain untrusted evidence. Agents cannot obtain broader tools or targets through these inputs. The local mode starts with no imported sources and does not allow later source-file requests or permission expansion; necessary clarification is supported.

**Save draft** does not call a model. **Start fleet** authorizes planning and internal handoffs within the selected lead/worker connections and limits. Model profiles remain pinned to their saved revisions. Fleet and per-task spend, call, token, tool-step and active-time limits remain enforced; uncertain calls retain their reservations. Limits are not reset by new work or retries.

**Pause fleet** and **Stop fleet** fence further tool execution and close the lab browsers. Waiting leads and completed worker handoffs also close their browser sessions. Saved plans, claims, reports, messages and usage survive interruption. Restart, sleep and backup require explicit resume; stopping a fleet is final. Browser cookies and synthetic website state are temporary and must not be confused with durable task progress.

Configured model input fitting removes optional older context against the exact serialized request size. It preserves required owner intent, corrections, tool-call identities and file/evidence handles, protects the latest browser observation with its exact tab/revision/control references, and discloses cumulative omissions. Older history and optional peer context are removed before current browser controls. Required context plus the current browser observation that cannot fit fails before dispatch instead of silently erasing controls and causing repeated observation loops. Model token and spend reservations retain their configured ceilings. Local-mode task views expose browser/code controls; imported-evidence task views retain the static-review display.

## Build and verification status

The verified local package directory is:

`dist/packages/Agent-Workspaces-0.9.9-arm64-local/`

Its application is [Agent Workspaces.app](<../dist/packages/Agent-Workspaces-0.9.9-arm64-local/Agent Workspaces.app>). This is an Apple Silicon local package; distribution signing/notarization is outside the local package workflow. The development entry point remains `dist/main/main.cjs`, produced by `npm run build`.

| Check | Recorded result | What it establishes |
| --- | --- | --- |
| Typecheck | Passed | Current TypeScript source and new regression tests compile. |
| Affected regression run | 80 passed | Configured adapters, protected current controls during input fitting, prompts, local/static task display, browser evidence and actual AgentLoop/Fleet behavior with synthetic ports. |
| Real Electron browser checks | 9 passed, reported by the root verification run | Real local browser/service behavior, including observation and interaction checks; this is separate from model intelligence. |
| Full release regression suite | 663 passed; 18 optional checks skipped; 0 failed (681 total) | Electron runtime regression suite, including both Fleet modes and input fitting. |
| Paid model website assessment | Paused; incomplete | Real OpenAI calls reached the public website; no final report, verified finding or real specialist overlap. |

The affected regression run includes an actual AgentLoop test with a scripted lead, two overlapping scripted workers, separate fake browser sessions, browser actions, local-command dispatch, shared messages, grounded reports and final synthesis. It contains no source pack and makes no paid model request. Adapter transport tests use mocks or synthetic loopback fixtures. These checks demonstrate application mechanics; they do not demonstrate autonomous discovery by a live model.

The live run made 93 model calls using the pinned `gpt-4.1-mini-2025-04-14` connection. Recorded settled spend is $0.232286; uncertain calls retain $0.157288 in reservations, within the $2 shared cap. The lead created two specialist roles and three work items, but its dependencies serialized the work; no item or final report has completed. Successful real browser reads occurred, alongside invalid planner arguments, repeated navigation and model timeouts. App rebuilds and explicit resumes were manual implementation interventions, not autonomous repairs. No flaw hints, private answer key or site source was provided to the fleet. No model-discovered flaw is verified.

Version 0.9.9 adds a bounded wait after navigation for client-side controls to appear. Typecheck/build passed, but this last navigation change still needs its real Electron browser harness rerun. The prior runtime passed nine real-browser checks; the tenth new navigation check is pending. macOS locked during recording, so desktop controls and the final resume currently require the owner to unlock it. The user started screen recording; its saved path and footage have not been verified. The startup black clip is not demo footage. See `.test-data/fleet-lab-run-20260930/live-run-summary.json` for the non-secret run summary. Video/demo evidence must disclose these interventions and incomplete coverage.

## Implementation map

- `packages/fleet` owns local-mode scope, plans, exclusive claims, internal handoffs and aggregate limits.
- `packages/agent-loop` exposes the local tools, selects the local-mode prompt, records evidence and fits model context without widening budgets.
- `packages/local-lab` starts/verifies the bundled website and brokers bounded local HTTP requests.
- `apps/desktop/main/lab-browser-runtime.ts` supplies per-agent ephemeral Electron browser sessions and current DOM observations/actions.
- `packages/browser` retains browser ownership, revision fencing, inspection and handoff controls; `packages/code` retains offline container execution and exact input scope.
- Schema 18 adds mode and fixed-site metadata to saved fleets while existing fleets default to imported evidence review.

This status document describes the implemented local training feature. It does not assert unrestricted computer automation or reproduction of an external incident.
