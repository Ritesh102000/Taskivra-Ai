# Connect Gmail through Google Desktop OAuth

Agent Workspaces uses the system browser for this connection. Google documents Desktop OAuth with PKCE and a loopback callback; embedded browser authorization can be rejected. The isolated agent browser is not used to enter the OAuth credentials. [Google's installed-app flow](https://developers.google.com/identity/protocols/oauth2/native-app)

## Current verified setup

On 11 September 2026, the owner's Google Cloud project was configured with Gmail API enabled, External/Testing audience, only the intended account as a test user, and only `gmail.readonly` in Data Access. The Desktop client JSON was imported through the native picker. The owner completed consent in Safari, the exact requested account was verified, and the blocked task automatically resumed and succeeded. The isolated Google browser login remains rejected; this result verifies the supported Desktop OAuth alternative.

One actual API listing returned 50 entries with `hasMore:true` and truncated snippets. Its `resultSizeEstimate` of 201 is approximate, not an exact unread count. No bodies or attachments were accessed and unread state was preserved. The agent report required a private v2 correction for partial-coverage wording and an invented checksum footer; native Add version preserved the original, and application-computed hashes were independently verified. [Native acceptance evidence](evidence/gmail-native.json) contains no mail content or credentials. General report accuracy and long-term real token refresh remain separate checks.

Full app restart preserved the Connected status, completed task and unchanged usage: seven cumulative model calls costing $0.021763 with no reservation remaining. Corrected v2 reopened successfully. Revised report instructions passed the focused host/Electron suites (87 passes and 3 skips each), typecheck and build; no new paid reporting run was performed.

## Setup reference

The current owner connection has completed these steps. Use this reference for a new client or account; use **Connect Gmail** again when reconnection is required.

1. In [Google Cloud Console](https://console.cloud.google.com/), select the project you want to own this connection. Enable **Gmail API** in APIs & Services → Library.
2. Configure **Google Auth Platform → Branding** with the app name and contact details. Set **Audience → External → Testing**, and add the **exact full Gmail address for the intended account** as a test user. Use the same address saved in the Agent Workspaces task; another connector's account does not authorize this task. Google limits testing access to listed test users. [Manage app audience](https://support.google.com/cloud/answer/15549945?hl=en)
3. Add only `https://www.googleapis.com/auth/gmail.readonly` in **Data Access**. Google classifies this as a restricted scope. This implementation has no send, modify, trash, delete, or mark-read operation. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
4. In **Clients**, create an OAuth client with application type **Desktop app**, then download its JSON. A Web application client or service-account key will be rejected. The application chooses an ephemeral `127.0.0.1` callback port; no public callback host is needed. [Desktop OAuth credentials and redirects](https://developers.google.com/identity/protocols/oauth2/native-app)
5. In Agent Workspaces **Settings → Gmail connection**, import the downloaded client JSON with the native file picker. Then choose **Connect Gmail** for the task's saved account. The system browser opens Google's consent page.
6. Sign in to the exact intended account and review the requested read-only permission. After Google's callback, return to Agent Workspaces. A connected account is shown only after Gmail's profile endpoint confirms that exact address. A wrong account cannot release the task's connection blocker.

The automated setup tests created no real project or consent grant and read no real mailbox. The native acceptance above was a separate, owner-authorized Google setup and live connection.

## Reading and reconnecting

The app verifies the profile before every unread listing. It requests at most 50 unread message IDs, followed by metadata for From, To, Subject, Date, and snippets. It does not download message bodies or attachments. Pagination is reported with `hasMore`; it does not imply the first page contains every unread message. Metadata reads preserve unread state. [List messages](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [Get message metadata](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)

The full result is bounded to 22 KiB. The app keeps the returned message identities and verified account information, shortening text if needed and reporting `summariesTruncated`. Mail text remains untrusted data for the model.

With an External app in Testing, refresh tokens for Gmail normally expire after seven days. Reconnect through the same Settings flow when authorization expires or is revoked. Publishing and verification requirements are a separate decision, not something this implementation changes automatically. [Google token expiration rules](https://developers.google.com/identity/protocols/oauth2)

Disconnect removes the local token from Keychain; it does not revoke the grant in the Google account. The owner can also remove the app from [Google account connections](https://myaccount.google.com/connections).

## Local implementation and proof

Client configuration and refresh/access tokens are held only in the native coordinator process and a separate, nonsynchronizing macOS Keychain service, `com.agent-workspaces.gmail`. They are not saved in SQLite, agent workspaces, artifacts, renderer state, model messages, command arguments, or logs. The owner-selected original JSON remains wherever the owner downloaded it.

Build the helper explicitly with `node packages/gmail/setup.mjs`. This compiles the helper without reading or changing credentials. Run `node --import tsx --test tests/phase5/gmail.test.ts tests/phase5/gmail-keychain.test.ts` for local mocked-Google tests; the tests exercise a real local loopback listener but make no Google calls and read no real Keychain item.

Validation covers PKCE/state checks, wrong-account refusal, exact read-only scope, refresh, late-token cancellation, bounded responses/timeouts, and the 50-message limit. Real Google consent and bounded mailbox retrieval also passed for the current Desktop client and intended account. Mocked refresh tests do not establish long-term live reconnection behavior or broader provider-policy compatibility.
