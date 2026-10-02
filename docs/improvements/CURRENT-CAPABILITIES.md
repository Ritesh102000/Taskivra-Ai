# Current application and test entrypoints

Use the repository README for local startup and `docs/guide/README.md` for the beginner guide. Architecture/design/implementation-plan documents describe their dated planning baseline; they are not current setup instructions. Per-package phase histories remain available for design context.

Owner workflows live in Overview, Workflows, Fleets, Projects, Requests, Results, Routines and Settings. A saved task does not start a paid call. Fleet follow-up creates fresh paused work and retains explicit lineage; grants are never cloned. Manual planning may run while an optional calculation runtime is unavailable. File preparation and actual calculation tools remain gated, and a result must disclose unexecuted calculations rather than claim verification.

Inspect exact grants in a task’s Activity panel. Pause before ending future use. Revocation retains historical effects and cannot recall previously uploaded or published bytes. Resource previews show local fit, headroom and unknown holds; unknown dispatch is never automatically replayed or released. Saved request repair reuses only the exact authorized explanation within finite request limits.

Results preserve exact output identities and owner acceptance. Structural checks do not certify facts. Sources, declared inspected coverage, execution receipts, assessment and accepted baselines remain separate. Supplied source manifests preserve owner-selected exact versions. Fleets also offers a native folder picker and reviewed repository source pilot: up to16files/32KiBsource/64KiBJSON, exact immutable bytes with excluded paths disclosed before capture. It requires host /usr/bin/python3, reads only pinned selected-folder descriptors and bounded local Git loose objects/index metadata, and never executes Git configuration/hooks. Packed objects/worktrees or unsupported metadata remain unknown. The shared snapshot must be explicitly selected before starting a fleet; it establishes no full-repository coverage and installs no dependencies.

History and archive is reachable from All tasks. Archive only finished work with resolved operations. It releases active task/agent/fleet occupancy, retains exact historical identities and bytes, and never releases unknown reservations. Restore checks capacity and never starts work. Agent, task and fleet history use bounded scoped pages; retained bytes still count toward storage.

Local commands:

- `npm run typecheck`
- `npm run build`
- `npm run test:electron` (synthetic service/persistence tests and explicitly gated optional runtimes)
- `npm run test:phase0` (separate host requirements)
- `python3 scripts/build-guide.py --validate` (no output writes)
- `python3 tests/improvements/guide-validation.py`
- `node tests/renderer/run-renderer-fixture.mjs`
- `node tests/renderer/run-features-fixture.mjs`
- `node tests/renderer/run-provenance-fixture.mjs`
- `node tests/renderer/run-repository-fixture.mjs`
- `node tests/renderer/run-provider-fixture.mjs` (actual mounted renderer with synthetic bridge and disposable Chromium profile)

Do not launch the ordinary app as an isolation shortcut: `AW_DATA_ROOT` does not redirect the host Keychain service. UI verification uses a custom main without the production preload or credential helpers. Real Chrome/Docker/parser gates require their recorded prerequisites; skipped gates remain unverified.

Fresh code installation: deliberately review and run `npm run code:setup -- --prepare-base`, then `npm run code:setup`, then `npm run code:check`. Runtime preparation can access the network; execution remains offline. This work did not install dependencies or alter owner accounts.

Runtime evidence: existing code image passed seven real checks; portable-document image passed two. Current browser image was rebuilt offline from pinned local bases and passed two checks. Initial stale-image/owner-redaction failures remain recorded under `.testdata/improvements/runtime-gates/`. Native live Chrome requires a dedicated initialized QA profile and remains unexecuted. Exact gate: `AW_NATIVE_BROWSER_TEST=1 AW_NATIVE_QA_ROOT=<initialized-dedicated-root-under-.test-data> AW_NATIVE_QA_AGENT=<dedicated-agent-id> npx tsx --test tests/phase6/native-live.test.ts`. These placeholders require an authorized initialized profile, not a personal Chrome directory.
