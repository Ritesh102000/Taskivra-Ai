# Third-party notices

This file records the origin and license of the copied or adapted seccomp profiles listed below. These notices apply to those third-party materials; they do not select a license for this project's original code.

## Playwright seccomp profile

- Project: [Microsoft Playwright](https://github.com/microsoft/playwright).
- Version: `v1.63.0`, commit `1b025d7e20a026371cd5f98ba0cdce48892737c8`.
- Source: [`utils/docker/seccomp_profile.json`](https://github.com/microsoft/playwright/blob/1b025d7e20a026371cd5f98ba0cdce48892737c8/utils/docker/seccomp_profile.json).
- License: Apache License 2.0. The exact upstream [LICENSE](https://github.com/microsoft/playwright/blob/1b025d7e20a026371cd5f98ba0cdce48892737c8/LICENSE) and [NOTICE](https://github.com/microsoft/playwright/blob/1b025d7e20a026371cd5f98ba0cdce48892737c8/NOTICE) are retained verbatim in [licenses/PLAYWRIGHT-LICENSE.txt](licenses/PLAYWRIGHT-LICENSE.txt) and [licenses/PLAYWRIGHT-NOTICE.txt](licenses/PLAYWRIGHT-NOTICE.txt).
- Upstream notice: Playwright, Copyright (c) Microsoft Corporation.

| Repository file | Relationship to upstream |
| --- | --- |
| `spikes/phase0/browser/seccomp-upstream.json` | Unmodified, byte-for-byte copy. |
| `spikes/phase0/browser/seccomp.json` | Locally modified copy. |
| `containers/browser/seccomp.json` | Same locally modified profile as the Phase 0 copy. |

The original file has SHA-256 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`.

The two modified profiles reformat the JSON, remove the minimum-kernel `ptrace` allowance, add a `clone3` rule returning `ENOSYS`, and add an unconditional `chroot` syscall allowance for Chromium's private user namespace. The default-deny action and upstream namespace rules are retained. The original implementation provenance and rationale are in [spikes/phase0/browser/README.md](spikes/phase0/browser/README.md#sandbox-evidence-and-seccomp-review).

Both modified files carry an explicit adaptation notice in the existing namespace rule's `comment` field. Their current SHA-256 is `ba43e5317c232b4ee9e0caf06354a1269eaf67d4d34e9833f76471dfb431bcbe`. The earlier hash recorded in the Phase 0 provenance describes the tested adaptation before adding that notice; only comment text changed, with no syscall behavior change.

The retained Playwright NOTICE describes its project-level Puppeteer attribution. It is reproduced as upstream supplied it; it does not assert that Puppeteer code was copied into these JSON profiles.

## Docker seccomp profile origin

Playwright's [Docker documentation](https://playwright.dev/docs/docker#crawling-and-scraping) identifies its profile as the default Docker seccomp profile with extra user namespace cloning permissions and links the following source:

- Source: [`profiles/seccomp/default.json`](https://github.com/docker-archive/engine/blob/d0d99b04cf6e00ed3fc27e81fc3d94e7eda70af3/profiles/seccomp/default.json), Docker Engine commit `d0d99b04cf6e00ed3fc27e81fc3d94e7eda70af3` (now in the official archived repository).
- License: Apache License 2.0. The exact upstream [LICENSE](https://github.com/docker-archive/engine/blob/d0d99b04cf6e00ed3fc27e81fc3d94e7eda70af3/LICENSE) and [NOTICE](https://github.com/docker-archive/engine/blob/d0d99b04cf6e00ed3fc27e81fc3d94e7eda70af3/NOTICE) are retained verbatim in [licenses/DOCKER-SECCOMP-LICENSE.txt](licenses/DOCKER-SECCOMP-LICENSE.txt) and [licenses/DOCKER-SECCOMP-NOTICE.txt](licenses/DOCKER-SECCOMP-NOTICE.txt).
- Upstream notice: Docker, Copyright 2012-2017 Docker, Inc. This product includes software developed at Docker, Inc. (https://www.docker.com).

The Playwright upstream JSON is structurally identical to this Docker profile after removing Playwright's added `clone`/`setns`/`unshare` rule. The Docker source file has SHA-256 `50fe67edba965c34491888675386f9034463a5aac2017551c8f87f9723a4d274`.

The retained Docker NOTICE contains additional project-level references. It is reproduced as upstream supplied it; it does not assert that those additional components are included in these JSON profiles.

## Installed dependencies

Package manifests and lockfiles also declare third-party dependencies. Those packages retain their own licenses and notices when installed. This file is scoped to the copied or adapted seccomp profiles; it is not a complete notice inventory for separately built installers or container images.
