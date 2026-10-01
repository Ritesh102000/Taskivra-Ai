# Phase 7: local release and recovery foundations

This slice provides a portable backup/restore service, an Apple Silicon package builder, and an explicit fresh-Mac code-container setup recipe. Packaging itself does not download dependencies, create credentials or build Docker images. The main process owns the user dialogs, pause gate and owner-selected restored location. This is a local test release, not a signed public distribution.

## Recovery API and integration

```ts
const recovery = new RecoveryService({
  persistence: coordinator.persistence, // { dataRoot, databasePath }
  appVersion: app.getVersion(),
  withQuiesced: work => coordinator.withQuiesced(work),
});
await recovery.createBackup(newBackupDirectory);
await recovery.verifyBackup(selectedBackupDirectory);
await recovery.restoreBackup(selectedBackupDirectory, newDataDirectory);
```

`packages/contracts/recovery.ts` contains the result and manifest types. There is no new database migration. Current-schema backups are accepted; automatic conversion between schema versions is deliberately refused.

Integration requirements:

- Only owner main-process actions may supply paths. Use native dialogs to select a parent, then create a unique **new child directory**. An existing directory, including an empty one, is refused to guarantee no replacement.
- `withQuiesced` must block mutating IPC and background dispatch; suspend and drain the agent loop, model calls, code execution, browser sessions, imports, artifact operations, validation and replan jobs; pause runnable work; and leave it paused after completion or failure. It must hold that gate throughout the callback. The service rejects active database records as a second check and reserves SQLite's writer lock while snapshotting referenced files. It cannot inspect arbitrary external processes that ignore the application gate.
- Startup must refuse a data root containing `.recovery-incomplete`. A failed operation leaves this marker for diagnosis and never reports that root as usable.
- Restore returns a new path and does not automatically switch the running app to it. Explicit owner activation/relaunch is a separate main-process action. It must not overwrite the active data root.
- A restored task requires owner review and explicit Resume. Agents retain their enabled setting so existing owner controls remain usable; tasks are paused, the simulation driver and live configurations are disabled. Existing waiting requests and saved progress remain in the database. Browser authority/profile references and tab state are cleared, request capability grants are revoked, and Gmail connection-request bindings are removed. Project account approvals are cleared separately for Gmail and Google Workspace. Schedules are disabled, in-progress routine preparations cannot replay, and pending browser action approvals become stale; a dispatch with uncertain outcome requires review.

## What a backup contains

SQLite's online backup API captures committed WAL state from a read connection while a separate `BEGIN IMMEDIATE` reservation prevents competing writers. There is no copy of a live database file. The exported database uses DELETE journal mode and needs no WAL sidecars. Integrity and foreign-key checks precede acceptance.

The manifest lists SHA-256, byte size and type for the exported database, every ready artifact version, each workspace input snapshot and each code workspace revision, including their manifests. References are reconstructed from the backup database during verification; missing, duplicate, extra-listed, corrupt or inconsistent references fail. Missing/corrupt source artifacts must be resolved before a complete backup can be made.

Only those allowlisted paths are copied. Browser profiles, cookies, profile encryption keys, macOS Keychain contents, runtime sockets/journals/staging, and unimported downloads are excluded. Backups still contain private task history and user files, and are **not encrypted or content-redacted**. Secrets a user put into their own files or messages are not automatically removed. Hashes detect corruption; they do not authenticate a backup's author.

Default hard bounds: 30,000 files, 100 MiB per content file, 512 MiB database, 8 MiB manifest and 8 GiB total. Options may lower those limits. Paths reject traversal and absolute locations; file and directory links are refused, as are hard-linked source files. Files are copied exclusively into a new location, checked again during restore, and synced before the incomplete marker is removed. Partial outputs are never accepted as valid backups.

Credentials are not transferred or deleted from Keychain. A destination Mac can already have credentials in its existing Keychain; restoring data does not change that external state. Browsers require fresh setup/sign-in at the new data root.

## Local Mac package

From a completed build:

```sh
npm run build
node scripts/package-mac.mjs --check
node scripts/package-mac.mjs --out /absolute/path/to/a-new-package-directory
```

`--check` validates the runtime inventory and Apple Silicon executable architecture without creating a package. The builder copies the **installed** Electron.app and an explicit app-resource allowlist: built main/preload/renderer, seccomp policy, native browser host, profile helper, model, Gmail and Google Workspace Keychain helpers, Chrome extension files, portable code provisioning scripts and workers, the pinned document-library recipe, a minimal package manifest and runtime licenses. It verifies copied resources against their source hashes, refuses existing output locations, and records the package inventory. It never copies application data, environment files, or the development dependency tree.

The output includes `Agent Workspaces.app` and `package-manifest.json`. The copied bundle receives a local **ad-hoc signature**, which makes its modified metadata internally consistent. It has **no Developer ID signature and is not notarized**. This is a local testing package, not a public installer or automatic update channel. A `.package-incomplete` marker identifies failed package attempts.

The running native Chrome bridge copies and launches `packages/native-browser/bin/native-host`, a native executable. `hostPath` supplies its resource directory. Current browser and credential paths do not need a separately installed Node runtime; the older JS host and profile helper are retained only as compatible resources.

External requirements remain visible: Google Chrome plus per-agent extension setup for native browsing; Docker Desktop for isolated code; owner cloud-model configuration and separate Gmail/Google Workspace OAuth for those capabilities. The optional container-browser provider still depends on its Phase 0 base and egress setup; it is not covered by the portable code recipe. A fresh-Mac app launch, browser handoff and signed/notarized distribution remain release gates.

## Explicit portable code setup

The package includes the minimal source recipe and workers needed to build a code image. On an Apple Silicon Mac with Docker Desktop running, the repository command is:

```sh
AW_DOCKER_PATH=/Applications/Docker.app/Contents/Resources/bin/docker node packages/code-runtime/setup.mjs --build --bootstrap-base --recipe containers/code/documents-recipe.json --allow-network --tag agent-workspaces-code:documents-reviewed
```

The same script works from the packaged resources using Electron's bundled Node runtime; no host Node installation is required. Replace the example app path with its actual location:

```sh
AW_DOCKER_PATH=/Applications/Docker.app/Contents/Resources/bin/docker ELECTRON_RUN_AS_NODE=1 "/Applications/Agent Workspaces.app/Contents/MacOS/Electron" "/Applications/Agent Workspaces.app/Contents/Resources/app/packages/code-runtime/setup.mjs" --build --bootstrap-base --recipe "/Applications/Agent Workspaces.app/Contents/Resources/app/containers/code/documents-recipe.json" --allow-network --tag agent-workspaces-code:documents-reviewed
```

`--bootstrap-base --allow-network` explicitly permits setup-time downloads. It starts from the official ARM64 Node 24.14.0 / Alpine 3.23 manifest pinned in `portable-base.mjs`, installs Python 3.12.14-r0, verifies base provenance and captures the resolved local image digest. The document recipe pins Python package versions and wheel SHA-256 hashes. This is not a fully vendored or bit-for-bit reproducible OS build: Alpine transitive packages still come from its repository; the recorded resolved image is the execution boundary. Job execution remains network-disabled.

The explicit test tag preserves an installed working default image. After fixture proof and with all code jobs stopped, the owner may promote the reviewed image to `agent-workspaces-code:4`, retaining the previous image tag for rollback. Passing `--build` without `--bootstrap-base` continues to use the existing Phase 0 base; it does not silently replace a working installation. The package does not automatically run this setup script.

On 2026-09-30 the portable recipe built and passed the real PDF/XLSX fixture on this Mac using `agent-workspaces-code:documents-portable-test`, digest `sha256:ba6360a8f8050f975ec5057123c3d89c6ae1f9f40c5b7f2c8fd22a07c62bcf8e`. The installed default uses the separately tested document image `sha256:f86ae86afc718e87c88857a961cf36a469fb95675378cebb75f4f5f4420632f0`; its previous stdlib image remains `agent-workspaces-code:4-before-documents-20260930`. This proves fresh-base construction on the development Mac, not a complete clean-machine installer test.

## Local routine recovery

Schedules require an accepted result from a saved read-only workflow, exact input versions, reviewed run limits, a monthly estimated-spend cap and an expiry date. Each due local day has one durable occurrence; preparation uses a leased owner claim, and an interrupted preparation/dispatch is blocked without automatic replay. An external model request cannot be promised exactly once across a crash; uncertain usage remains reserved.

The app must be open and the Mac awake. Missed occurrences more than 15 minutes late are skipped. Sleep and backup use the coordinator's quiescence gate and leave schedules disabled, so waking the Mac requires explicit owner re-enabling. Pausing a schedule does not cancel an already dispatched task; the owner can pause/stop that task separately. Pausing during preparation invalidates that preparation even if the schedule is immediately re-enabled. No notification or background wake capability is claimed by the storage tables alone.

## Verification boundary

`node --import tsx --test tests/phase7/recovery*.test.ts` exercises committed WAL capture, preserved checkpoints, paused restore and capability revocation, refused active work/writers, no-overwrite, corruption/missing/partial files, symlinks/hardlinks, path/size bounds, workspace/code snapshots, disabled restored schedules/notification authority and the package-resource allowlist. Routine tests additionally exercise two service instances, restart before task creation, two failed attempts within one month, uncertain usage reservations, and pause/expiry/approval-revocation races. Tests use disposable fixture roots, not the owner's data, credentials, or containers. `--check` validates installed runtime resources; launching the final package on a fresh Mac is a separate acceptance check.
