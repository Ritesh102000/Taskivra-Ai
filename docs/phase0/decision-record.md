# Phase 0 decision record

Started 11 September 2026. The planning baseline remains in the three root documents. This record distinguishes implementation evidence from decisions and unfinished gates. After these results were reported, the owner authorized [Phase 1](../phase1.md) with a simulated driver; the open gates below remain open for live integration.

## Owner decisions

- Mac first; cloud APIs first; code in isolated containers.
- One browser session with multiple tabs and a private workspace per agent; explicit global sharing and requests to the owner.
- **OpenAI** selected during Phase 0.
- **`~/Library/Application Support/Agent Workspaces`** selected as the persistent data root.
- **Remember logins locally** confirmed when authorizing Phase 3. Its encrypted per-agent checkpoint/restore implementation is recorded in [Phase 3](../phase3.md); the original Phase 0 spikes remain disposable.

Exact model, dollar spend cap, required real website/login/MFA, provider retention preferences, and browser profile deletion/backup controls remain unresolved. The choice to retain local logins is confirmed; its implementation defaults are not additional owner-confirmed product requirements. Do not replace the remaining entries with guessed confirmations.

The owner accepted preparing the small model probe and leaving the paid request and real login pending. No paid model request or real-account login was performed.

## Measured environment

The inventory command writes timestamped, sanitized details to `evidence/environment.json`.

- Mac: ARM64, macOS 26.6, 16 GiB physical RAM, 10 CPUs.
- Docker Desktop was installed but stopped. It was started for this phase; Engine 29.4.0 reports ARM64 Linux and about 7.75 GiB VM RAM.
- Host Node 26.7.0, npm 11.19.0, Python 3.14.2.
- Initial filesystem check reported about 13 GiB free. A precise subsequent APFS check reported 11.68 GiB. Available space changes during runtime startup and image builds; refer to the latest inventory rather than treating either number as fixed.
- Final inventory at 06:45 UTC reports **72.76 GiB available**. The increase was observed externally; the spike did not delete unrelated data to produce it.
- No OpenAI API key was present in the invoking environment. Inventory does not inspect unrelated credential files or Keychain items.

The spike uses an 8 GiB pre-build free-space threshold to avoid exhausting this Mac. This is an implementation precaution, not a measured product requirement. No unrelated images, volumes, or user files are pruned.

## Selected feasibility approach

- Keep Phase 0 in `spikes/phase0/`; no Electron scaffold or production task scheduler yet.
- Docker Desktop is the available runtime used for the checks. Python standard-library host probes avoid adding dependencies merely for inventory and evidence collection.
- Browser: a custom Chromium-headless-shell-only image with Playwright 1.63.0, built from an exact ARM64 Node image digest. It avoids downloading Firefox/WebKit. Headless-only compatibility with the owner's required website remains a gate.
- Code: a small pinned Node/Alpine image with a pinned Python package. Payloads are UID 10000 with no capabilities; a separate trusted supervisor uses root with only `CAP_KILL` for quiescing. This is a specific refinement of the baseline's non-root recommendation: arbitrary code never receives the supervisor identity or capability. The runtime image's source and exact identity are recorded with the spike.
- Egress: independently enforced per-browser network isolation and a restricted proxy. Any private fixture target is an exact, test-only allowance; production rejects private destinations.
- Spikes use synthetic files and disposable profiles. Selecting a data root does not imply a production workspace database or persistent session implementation exists.
- Model: the Responses API, strict function schema, independent host validation, one explicit request, bounded output, `store: false`, and actual usage reporting. Model choice and live invocation remain explicit. No dollar costs are inferred.

## Gate status

The implemented feasibility checks pass within their recorded scope. Required live-provider and login checks remain deferred, so Phase 0 is not yet fully complete.

| Gate | Status | Required evidence |
|---|---|---|
| Runtime/ARM64 inventory | Passed | `evidence/environment.json` |
| Code containment and stable export | Passed for spike | `../../spikes/phase0/code/evidence/integration.json`: 16/16 real container cases; 16 host export tests |
| Browser sandbox/tabs/control | Passed for fixture | `../../spikes/phase0/browser/evidence/integration.json`: two isolated workers; `navigation-regression.json`: 10/10 checks on the corrected image; `evidence/viewer.json`: actual owner-viewer interaction |
| External browser egress | Passed for tested topology | `../../spikes/phase0/egress/integration-evidence.json`: 44/44 checks covering fixture protocols, public HTTPS, and network bypass checks |
| Real model tool call | Deferred with owner agreement | Exact model, credential, explicit limits, validated live response with usage; local validator tests and dry run pass |
| Required real login/MFA | Deferred with owner agreement | Named site and owner-performed login through the viewer |
| Persistent profile policy | Choice confirmed; Phase 3 checkpoint/restore tested | Owner chose remember logins locally. Phase 3 retains encrypted per-agent bundles with bounded restoration; deletion/backup UX remains pending. Phase 0 profiles stay disposable. |
| Concurrency limits | Preliminary measurement only | Two simultaneous fixture workers measured 208.1 MiB/97 PIDs and 171.9 MiB/84 PIDs; representative sites and combined browser/code load still need measurement |

Unit tests validate local boundaries; they do not substitute for runtime evidence. Phase 0 is not complete while a required gate is pending or failing.

The final `npm test` run passed all **41 local tests**: 16 code-export, 9 egress, 9 model-validation, and 7 browser-protocol tests. Separately, the code container suite passed 16 runtime cases. The corrected browser image passed all 10 navigation/runtime checks. Its owner viewer was exercised through a real browser: take control, pointer focus, ordered keyboard input, synthetic login through Enter, automatic account-page observation, and return to the agent with fresh state. No real credentials or login frames are retained.

The earlier two-worker cookie-isolation report records its original image ID. The navigation regression and owner-viewer report identify the corrected image `sha256:a32d31643c1ee3c0041d2f41c49e32fea386ea8d84cf579a72c0754ceb6a8817`. This preserves the distinction between historical concurrency evidence and final navigation evidence.

Code tests used a small adversarial profile (256 MiB memory, 32 MiB workspace, 16 MiB temporary storage) plus a separate smoke check at the planning defaults. Browser egress fixtures exercised HTTP/HTTPS/WS/WSS and public HTTPS. Browser IPv6 is disabled; proxy IPv6 destination classification has local tests, not a live IPv6 routing proof. TLS destination filtering does not implement application-level private-file upload grants.

Both owner viewers were stopped, and all Phase 0 test containers and networks were removed using matching ownership labels. `../../spikes/phase0/egress/cleanup-evidence.json` records 8/8 cleanup checks. Built images remain available for reproduction. No unrelated Docker resources were changed.

## Boundaries retained for later phases

- Proposed two-agent concurrency and resource defaults are not performance guarantees.
- Code-job Stop and task Stop will require distinct explicit contracts before Phase 4/5 integration.
- Switching tasks within one agent's browser needs a tab/state preservation contract before the scheduler permits it.
- Publishing derived private material and cross-agent text sharing require concrete owner-grant contracts at the broker.
- SQLite lifecycle/recovery, the full file-request flow, the native desktop shell, production previews, and packaged distribution belong to later phases.

## Technical sources checked during implementation

- [Playwright Docker guidance](https://playwright.dev/docs/docker): sandbox/non-root requirements and image/version compatibility. The upstream development image is not treated as proof of safe untrusted browsing; broad development flags in its examples are not adopted.
- [Docker container controls](https://docs.docker.com/engine/containers/run/) and [tmpfs lifecycle](https://docs.docker.com/engine/storage/tmpfs/): execution limits, mounts, and loss of uncommitted tmpfs data at teardown.
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) and [Responses request/response reference](https://developers.openai.com/api/reference/python/resources/responses/methods/create): strict tool schema, output caps, response storage, and usage fields.
