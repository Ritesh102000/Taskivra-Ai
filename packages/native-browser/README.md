# Desktop Chrome backend

This backend opens **ordinary installed Google Chrome with a separate user data directory for each agent**. It is a browser redesign, not an Electron webview and not the earlier streamed container browser. The existing container browser remains a separate selectable backend. Code execution remains in isolated containers.

## Owner setup

1. Install Google Chrome at `/Applications/Google Chrome.app`. Build the local profile verifier with `node packages/native-browser/setup.mjs` (macOS Command Line Tools/Clang required).
2. In Agent Workspaces, prepare the selected agent's Chrome profile and choose **Open Chrome setup**. This registers the native host only inside that agent's managed profile and opens its Extensions page.
3. In that dedicated window, enter `chrome://extensions` if Chrome opened a New Tab, enable Developer mode, choose **Load unpacked**, and select this repository's `extensions/agent-browser` directory. Return to the app and refresh connection status. This is required once for each dedicated profile.
4. Open the task browser. For login, take control and use the actual Chrome window, including MFA. Return control from Agent Workspaces when finished. Login data belongs to that dedicated Chrome profile; do not import a personal profile or turn on personal Chrome profile sync.

The extension is not installed into the owner's personal Chrome profile. Do not use Chrome's removed `--load-extension` flag or modify Chrome security policies. Chrome 137 removed that flag in branded builds; the supported development path is manual Load unpacked. A future signed/distributed app needs an extension distribution/update strategy.

The current extension reconnects on installation/startup and on a 30-second alarm. If the app was closed, reopen it and allow one reconnect interval or open the extension popup. Closing a disconnected task is safe; uncertain actions are never replayed.

After editing the unpacked extension's source, close its task browser session and use **Reload** on the extension's card at `chrome://extensions` in that agent's dedicated profile. Then reopen the task browser. Rebuilding the app or closing and reopening a Chrome window alone does not reliably load updated extension modules.

## Runtime API and integration

`NativeChromeRuntime` implements `packages/browser/runtime.ts`. Construct it with:

- `dataRoot`: the already chosen app data directory.
- `extensionPath`: absolute `extensions/agent-browser` directory.
- `hostPath`: absolute `packages/native-browser/native-host.mjs` path.
- Optional `chromePath` and `onChanged`. `bridgeInstallRoot` exists for isolated tests only; owner IPC cannot supply it.

The current `hostPath` is a source-resource locator: its sibling `bin/native-host` is the executable that is actually installed. It is compiled from `native-host.m` with Foundation and requires no Node, Electron or shell interpreter at runtime. Setup also builds the standalone `profile-parent` diagnostic verifier. Packaged applications must bundle the compiled native host and extension files. The private installed host/config live under `~/Library/Application Support/Agent Workspaces/runtime/browser-bridge/<data-root-hash>/<agent-id>/`, isolated by app-data root, with modes 0700/0600. This avoids asking Chrome to execute code from macOS-protected Desktop locations; no Full Disk Access or weakened Chrome policy is used. The app registers a new copy atomically, and a damaged profile registration is quarantined without blocking other agents.

Owner-only methods `setup(agentId)`, `agentStatus(agentId)` and `openProfile(agentId, {setup?: boolean})` return connection/setup metadata. They expose no credential or native socket token. Setup is available before a browser session opens. `status(agentId?)` reports the backend and transfer capability. These are trusted owner IPC operations, never model tools.

Owner setup uses LaunchServices to open the exact application with the exact dedicated profile. Agent startup uses the Chrome binary with `--no-startup-window`; agent operations create inactive tabs and unfocused windows. Only the explicit owner show action selects a tab or focuses a window.

## Connection and control

Each dedicated profile contains its own native-messaging manifest at `NativeMessagingHosts/com.agent_workspaces.browser.json`. The fixed public key in the extension manifest produces a stable extension ID; the native manifest allows only that origin. The compiled native host also checks the actual Chrome ancestor's NUL-delimited arguments using the macOS process API, requiring the exact canonical managed `--user-data-dir` prepared by the app. It does not open Chrome's cookie/history files. An extension in the personal profile cannot merely claim another agent ID.

The host connects to an app-owned Unix socket in a private 0700 directory with a 0600 socket. A per-runtime, per-profile random token binds the connection. There is no localhost HTTP server, open CDP endpoint, remote-debugging port, or model-visible native path. Native and socket JSON frames use a bounded little-endian four-byte length; the maximum frame is 900 KiB, with at most 16 pending app requests and a 15-second timeout. Timeout/disconnection closes admission and fails uncertain calls without retrying side effects.

The extension accepts a fixed command allowlist, not arbitrary JavaScript, selectors, CDP methods, shell commands or native inputs. Top-frame DOM text is limited to 16,000 characters and 150 opaque targets; labels are limited to 160 characters. Only HTTP(S) and initial `about:blank` are accepted as managed tab URLs. At most six tabs are managed in a session. The normal application task/run authorization and origin policy remain outside this transport.

DOM references bind to a document identity and mutation revision. Click, fill and scroll recheck the document inside the isolated extension world immediately before acting. Return-to-agent requires a fresh observation. Queue admission and results are fenced by session identity and monotonically increasing controller generation. Stop invalidates the queue, removes observers/references, detaches any debugger and closes the session's owned tabs. A late-created tab after cancellation is also closed. Chrome profile files and cookies remain for a later session.

Returning control adopts allowed tabs opened during manual login and selects the active managed tab from the dedicated profile's last focused window. The selection changes only the app's opaque tab reference; it does not activate a tab or focus Chrome. A browser-internal or unadopted tab leaves the prior managed selection intact. The app then obtains a fresh observation of the selected tab.

`chrome.debugger` is used only for an owner preview during agent control: attach, fixed `Page.captureScreenshot`, detach. Before completing human takeover, `chrome.debugger.getTargets` must confirm that no owned tab remains attached. Failed detachment prevents the handoff, and session cleanup still closes owned tabs. Known login URLs and password/one-time-code pages return no page text, targets or screenshot, and reject agent inputs. Human control returns redacted tab metadata and no frames; input occurs directly in Chrome and never crosses the app's input transport. A takeover waits for the fenced current operation to settle before completing.

## Permissions and changed boundary

The extension requests `nativeMessaging`, `tabs`, `scripting`, `debugger`, `alarms` and HTTP(S) host permissions. Broad host access is necessary to inspect approved sites dynamically, but only this reviewed extension code exposes the fixed command surface. Chrome's permission prompt is an owner installation step, not a model approval. It does not request clipboard, cookie export, filesystem, downloads, microphone or camera APIs. It has no externally-connectable website endpoint.

**This is a host browser boundary.** A dedicated profile separates cookies/history from personal Chrome but is not an OS/container filesystem or network sandbox. Chrome uses its normal browser sandbox and host network; the Docker egress/LAN-blocking policy does not carry over. Web pages and owner actions can trigger normal Chrome prompts/downloads. Ordinary Chrome profile storage replaces the old encrypted container-profile checkpoint; browser cookies/history are managed by Chrome, while the app protects its profile directory and bridge configuration permissions. The app does not promise end-to-end encryption of all Chrome profile files.

Managed artifact upload/download is explicitly unsupported in this backend. Native manual downloads are not automatically imported into private task files. Use the container browser when the task needs the existing scoped artifact transfers. The native extension rejects upload/read-download commands instead of accepting arbitrary host paths. Native key synthesis is intentionally limited; use DOM references for agent actions and the actual Chrome window for human input. Cross-origin frames, browser-internal pages, desktop file pickers and clipboard automation are not agent tools.

Google and other providers can still require checks or reject a particular login. Using ordinary Chrome without an attached automation debugger during login does not guarantee provider acceptance. The supported Gmail OAuth fallback remains independent.

## Verification

Run `npx tsx --test tests/phase6/native-browser.test.ts` for the bounded tests. These cover framing, command allowlist, session/controller fencing, background focus behavior, screenshot detachment, manual-control privacy, active-tab selection after return, sensitive-page/stale-DOM rejection, transfer rejection, real Unix socket/profile authentication, real Coordinator-to-extension reply compatibility, linked-file protection, stop during tab creation, retry after a previous socket owner exits, per-profile quarantine, and fail-closed debugger detachment (several assertions share a test).

These tests use synthetic Chrome APIs and a fake attested host connection. They do not claim actual Google login, mailbox access, native extension installation, or a production security audit. The native host and diagnostic helper compile successfully. Actual installed-extension authentication and the opt-in public-page workflow both passed in the dedicated QA profile. The live check verified navigation, a real JPEG preview, `chrome.debugger.getTargets` detachment before human control, redacted human observation, generation fencing, fresh return and session stop. Actual owner login/provider acceptance remains outside that proof. The sanitized receipt is `evidence/verification.json`.

The separate owner-completed Google passkey sign-in in the production Mail Assistant profile is recorded in [Phase 6 verification](../../docs/phase6.md). That later login evidence is distinct from the bounded public-page receipt above.

For the opt-in installed-extension check, close the desktop app using the disposable QA data root, ensure the reviewed extension is installed in that profile, and run:

```sh
AW_NATIVE_BROWSER_TEST=1 AW_NATIVE_QA_ROOT=/absolute/repo/.test-data/qa-root AW_NATIVE_QA_AGENT=<qa-agent-id> npx tsx --test tests/phase6/native-live.test.ts
```

It rejects roots outside this repository's `.test-data` directory and refuses to observe preexisting pages other than blank/example.com/example.org. It makes no model calls or mailbox requests. The test closes only that session's owned tabs and retains the dedicated QA profile/installation so the owner can inspect setup. The live test is skipped by default; do not count that skip as runtime proof. The short `bridge-diagnostic.json` beside an installed native host contains only a static stage code, timestamp, PID and parent PID; it never contains credentials, URLs, page content or socket tokens. Remove a completed test's exact hash-named installation only after its profile/process is no longer in use; do not remove other installations or personal Chrome data.

Official references:

- [Chrome's extension update announcement, June 2025](https://developer.chrome.com/blog/extension-news-june-2025).
- [Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
- [Chromium source: per-user native host path derives from DIR_USER_DATA](https://chromium.googlesource.com/chromium/src/+/c6b4a8729cc20c38363d104fecc7d746d69f94da/chrome/common/chrome_paths.cc).
- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger).
- [Google Account supported-browser guidance](https://support.google.com/accounts/answer/7675428?co=GENIE.Platform%3DDesktop&hl=en).
