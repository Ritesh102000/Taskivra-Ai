# Selected Google inputs and detailed Gmail review

This first slice implements F09 and F10. F08 (a separate web-search provider and discovery workflow) remains outside this slice. These are product capability improvements, not evidence that market fit has been established.

## Selected Drive and Sheets snapshots

`GoogleWorkspaceService` uses a separate Google connection with the exact `drive.readonly` scope and separate macOS Keychain namespace, `com.agent-workspaces.drive`. It reuses the existing PKCE, loopback-callback, refresh, cancellation, timeout, bounded-response and exact-account verification machinery. Gmail credentials do not grant Drive authority. No Google client JSON, tokens, raw file bytes, or filesystem paths are returned to the renderer.

The owner chooses a project, an agent in that project, and one exact Google resource. The trusted controller resolves the project's approved Google account. Before content is requested, the backend checks both saved token identity and the live Drive profile. A mismatch, revoked token, unsupported file or oversized response fails without a successful import. Account/project membership is checked again before local persistence.

Supported selections:

- A regular text, CSV, TSV, Markdown, JSON or PDF file, up to 1 MiB.
- A Google Doc exported as plain text. Formatting, images, comments and embedded content are excluded.
- A finite, named-sheet A1 rectangle, at most 1,000 rows, 32 columns and 20,000 cells. Whole-column, whole-sheet and ambiguous ranges are rejected. The selected computed values become CSV. Date values may be Google serial numbers; formula-like text cells receive an apostrophe on CSV export and this transformation is disclosed in the receipt.

Imports read metadata before and after the content read and reject sources whose reported version or modification time changed. The immutable receipt records the verified account, selected resource, source version, retrieval time, range/shape where applicable, content hash, byte size and known omissions. The app imports a local snapshot; it does not modify, share, or synchronize the source. Shortcuts, folders, executable/archive content and unbounded downloads are unsupported.

Google's read-only Drive scope permits reading and downloading Drive files broadly. **Selection is enforced by this application's broker, not a per-file OAuth grant.** A production application-managed Google connection still requires external OAuth configuration and verification. This build supports an owner-imported Desktop client, with Drive and Sheets APIs enabled and consent/test-user setup completed. Google's documentation classifies the scope as restricted; its `drive.file` scope with Google Picker is a future narrower-provider-grant option. [Google Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

The Sheets values endpoint explicitly accepts `drive.readonly`, so the connection requests no additional Sheets scope. Only the specified range is retrieved. [Sheets values.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get)

## Detailed Gmail review

The original `readUnread` behavior remains unchanged: up to 50 unread headers/snippets, explicit coverage and preserved unread status. Existing tasks do not receive full-body tools automatically.

A new Gmail task may opt into `mailDetail: threads_and_attachments` through the reviewed workflow checkbox. Named saved procedures do not silently copy that grant. The trusted owner and agent controllers enforce the task's project-bound exact account and explicit detail permission on every operation.

- Search accepts an owner/task-scoped Gmail query, returns at most 20 headers/snippets per page, and follows at most five pages. Opaque cursors are bound to account, query and connection generation, are single-use, and expire after five minutes. The receipt distinguishes further results from the ability to continue within the page cap.
- A full thread must first have appeared in a recent search. Reads support up to 20 messages and bounded MIME depth/part counts. Only supported UTF-8 plain text is displayed. HTML, remote images and embedded active content are omitted. Unsupported encodings or oversized responses are reported, rather than silently counted as complete coverage.
- Thread body text is bounded to 12,000 characters in aggregate. Search and thread receipts fit within 22,000 bytes, preserve message identities, and explicitly mark shortened text/headers. They are observations, not mailbox writes.
- An attachment must be selected from a recent successful thread review. Only matching text, CSV, Markdown, JSON and PDF attachments up to 1 MiB are importable. Content, encoded size and declared size are checked. Imported bytes and a source/hash receipt go to the task's private managed files through the trusted import broker.

Search, full thread and attachment reads use GET endpoints only. No send, modify, archive, delete, or mark-read route is available. Google's thread API returns messages belonging to the selected thread; attachments require a separate retrieval endpoint. [Threads.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get), [Attachments.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get)

## Connection state and restart

A stored connection is distinguished from a live account check. The owner can choose **Verify account** after restart; this refreshes if necessary and checks only account identity, without listing mail or reading documents. Successful verification enables explicit project binding. Disconnect/reconnect and client replacement invalidate cached verification and recent Gmail selections. OAuth tokens remain outside app backups and project data.

## Integration surface

- `packages/contracts/google-workspace.ts`: typed owner commands, state, selection and receipt.
- `packages/google-workspace/index.ts`: `status`, `importClient`, `connect`, `verifyConnection`, `verifiedConnectedAccount`, `disconnect`, `importSelected`, `close`.
- `packages/gmail/index.ts`: original API plus `verifyConnection`, `verifiedConnectedAccount`, `searchReadonly`, `readThreadReadonly`, and `readAttachmentReadonly`.
- `packages/contracts/gmail-review.ts`: search/thread/attachment receipts and strict owner commands.
- `apps/desktop/renderer/GoogleWorkspace.tsx`: selected-import connection and form, with callback props for trusted IPC.
- `apps/desktop/renderer/GmailReview.tsx`: owner search, selected plain-text thread, and attachment import UI.
- `packages/google-workspace/setup.mjs`: builds the separate fixed-namespace native Keychain helper; it reads no credentials.

Import results are backend-only `{filename, mime, bytes, source}`. The controller must pass these through the managed artifact import broker, then return only version IDs and the source receipt. It must never accept renderer filesystem destinations, raw access tokens, or account substitutions for imports. No new schema is required by the connection services; project bindings and artifact provenance are integrated by their owning modules.

## Executed verification

22 new deterministic tests passed for selected Google inputs and detailed Gmail review. They cover wrong/stale accounts, profile-only verification, separate OAuth scope, synthetic PKCE callback, bounded stream reads, selected ranges, changed source versions, unsupported inputs, opaque cursor limits, selection expiry, MIME/body limits, HTML omission, safe attachments, and the model receipt size boundary. Existing 12 Gmail OAuth/unread tests also passed after the shared connection refactor. Workflow tests cover explicit detailed-mail opt-in and no grant copying into named saved procedures. Eight additional controller/import integration tests passed through the real managed artifact service, including provider fixture to private file plus receipt to preview, revoked binding during download and after staging, cancelled task admission, cross-project targets and zeroing buffers on early failures. The artifact import transaction checks the current account/project/task authority before committing metadata. Type checking passed. The Drive native helper compiled successfully without reading or writing credentials.

Tests use synthetic tokens, local callback fixtures and mocked Google responses. No paid model request, real Google consent, real mailbox read, real Drive read, or account write was performed. Real account/API configuration and end-to-end desktop UI verification remain external validation steps; successful fixture tests do not establish those results.
