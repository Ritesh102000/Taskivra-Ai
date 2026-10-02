# Changelog

Published source versions are preserved by annotated Git tags and GitHub releases. This project remains a local desktop pre-release; releases do not imply signed installers or validated clean-machine installation.

## 0.10.0 - 2 October 2026

The complete C01-C102 improvement program adds reviewed immutable repository snapshots, exact source-range reading, current-grant visibility and future-use revocation, linked fleet mailboxes and fresh follow-up drafts, resource previews, archive/history controls, exact result provenance, quarantined-file repair, runtime diagnostics and nonsecret build provenance.

Recovery, committed-operation reporting, model accounting, file staging, workflow requirements, routine/DST behavior, Gmail selections, browser/code cleanup, report/export fidelity and mounted UI states are repaired. The [implementation ledger](docs/improvements/ledger.json) records all 53 defects, 10 risks and 39 proposals; the [verification record](docs/improvements/integration.md) preserves failures and test boundaries.

Verification: Electron 738 passed, 18 explicitly skipped, zero failed; separate Phase0 41 passed; typecheck/build and ledger validation passed. Existing isolated code, browser and document runtime gates passed. Native Chrome QA, real Google/paid providers, dependency downloads, native Office visuals and signed packaging remain unexecuted external gates.

Database schema changes from 18 to 24. Preserve pre-upgrade compatible data before attempting rollback; source tags do not downgrade databases. The repository snapshot pilot requires host `/usr/bin/python3` and captures at most 16 files/32 KiB source/64 KiB JSON.

The matching guide adds a chapter explaining the new controls. Frozen editions remain available at [guide versions](https://taskivra-ai-guide.vercel.app/versions/).

## 0.9.9 - 1 October 2026

Baseline source at commit `834001d85bbf57ef64e82c7263714b4f9ecfc824`: local Agent Workspaces application and complete beginner guide. Database schema 18. The annotated `v0.9.9` tag preserves this exact original state; no baseline source history is rewritten.

See [versioning and rollback](docs/releases/VERSIONING.md).
