# Published versions and rollback

Repository: https://github.com/Ritesh102000/Taskivra-Ai

| Source tag | Database schema | Guide | Scope |
| --- | --- | --- | --- |
| `v0.9.9` | 18 | `/versions/0.9.9/` | Original baseline at `834001d` |
| `v0.10.0` | 24 | `/versions/0.10.0/` | Integrated C01-C102 improvements |

Each tag is annotated and stays attached to its original commit. GitHub releases provide source archives and matching guide PDFs. The main branch and guide homepage show the newest published edition; version-specific guide pages preserve older editions and their own CSS, JavaScript and PDF.

## Open an exact source version

After saving any current changes, inspect versions without overwriting the working checkout:

```sh
git fetch origin --tags
git tag --list 'v*' --sort=version:refname
git worktree add --detach ../Taskivra-Ai-v0.9.9 v0.9.9
```

Choose the required tag in the final command. Run the selected version's own setup instructions in that checkout. Its dependency lockfile is part of the preserved release. Version changes may require different native helpers and runtime images; do not reuse unverified binaries just because the source tag changed.

## Preserve data before upgrading

Close the application and its browser/code runtimes. Preserve a private copy of the actual configured data root while it is closed, including the database and managed artifact bytes. Also preserve any runtime profiles and separately managed credential setup needed for your own recovery. Keep these copies private and outside Git; they can contain sensitive data. The app's backup archive excludes credentials/browser profiles and is not a full machine restore.

An app backup can be created before upgrade under the older version and restored by that compatible version. Backup restore requires the matching schema; a schema24 backup is not a schema18 downgrade mechanism.

## Return to an older app version

The old source is always retrievable by tag, but old code cannot open a newer-schema database. To return from 0.10.0/schema24 to 0.9.9/schema18, use the preserved schema18 pre-upgrade data copy with the old version, or a separate clean data root. Do not point the older app at the schema24 root. This release implements no automatic database downgrade, and work created after the upgrade cannot be promised to survive a rollback.

Never delete the newer data root to attempt rollback. Preserve it independently so you can return to 0.10.0. Switching source versions does not reverse previously performed external effects or revoke credentials.

## Publish subsequent versions

1. Update `package.json`, both root version entries in `package-lock.json`, guide edition metadata, README and changelog. Recovery/build manifests derive the application version from package metadata.
2. Run the applicable typecheck, build, tests and guide validation/rendering. Record passed and unexecuted gates honestly.
3. Freeze a matching guide directory under `guide-site/versions/<version>/`, including that edition's HTML, CSS, JavaScript and PDF. Do not overwrite an existing edition with different content. Archived pages must link to their own assets/PDF rather than the current edition.
4. Commit only reviewed release files. Create a new annotated `v<version>` tag on that exact commit; never force-update existing release tags. Push the commit and tags without rewriting remote history.
5. Publish a GitHub release with the matching PDF and source validation notes. Deploy only `guide-site`, verify public HTML/PDF responses and compare hosted PDF hashes with the local artifacts. Build executable artifacts after the release commit so provenance names that commit.

The original review records, marketing content, credential stores, local test evidence and disposable profiles are excluded from this publication. Source publication is separate from deploying a hosted application; the Vercel site contains static guide files only.

## Guide hosting revisions

Application tags remain immutable. Documentation-only hosting fixes can use separately annotated guide tags without changing the application version or frozen guide bytes. `guide-v0.10.0-r2` records the initial automatic trailing-slash attempt, which live checks found insufficient for dotted version names. `guide-v0.10.0-r3` preserves the verified explicit redirect/rewrite rules: directory URLs keep their trailing slash so archived HTML resolves CSS, JavaScript and PDF within its own edition. The terminal rewrite retains the existing security headers. Application source version 0.10.0 and both frozen guide contents remain unchanged.
