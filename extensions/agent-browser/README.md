# Agent Workspaces Browser Bridge

Load this unpacked extension only in the dedicated Chrome profile opened by Agent Workspaces. Its stable ID comes from the public `key` in `manifest.json`; no signing secret is included. The native host accepts only that extension origin and verifies the real Chrome profile process before connecting.

- `background.mjs`: native port lifecycle and trusted owner/session dispatch.
- `policy.mjs`: fixed command schema, URL checks and generation/controller queue.
- `session.mjs`: opaque tabs, background operations, screenshot detachment and stop cleanup.
- `page.mjs`: fixed isolated-world DOM inspection/action function, stale-reference checks and login protection.
- `gmail.mjs`: existing bounded, read-only Gmail listing extractor; it never opens messages or changes unread state.

No remote code, model code, content-script message bridge, cookies API, clipboard API or host paths are accepted. Human login takes place directly in Chrome while page inspection and debugger attachment are suspended.

See `packages/native-browser/README.md` for setup, permission explanations, the changed host-browser boundary and tested limitations. Reload the extension after development changes; the app must reconnect before agent actions resume.
