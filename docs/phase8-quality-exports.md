# Phase 8 quality checks and formatted exports — implementation handoff

Status: service, renderer controls, completion-gate integration and owner export bridge are implemented. Focused tests and actual PDF/DOCX/XLSX fixture validation passed. This is not a full product release acceptance claim; packaged-app interface validation remains part of the integrating change.

## Quality checks

`ResultService.checkQuality(taskId, versionId)` reads an exact task-produced output through the artifact integrity boundary. It works before completion as well as from owner Results inspection. Its response records the source version, SHA-256, checker version, time, checked byte coverage and individual pass/warn/fail findings. Results shows this assessment separately from owner acceptance.

The checker detects empty output, malformed JSON/CSV, duplicate or empty CSV headings, missing exact Markdown headings specified by a saved workflow (or an explicit `Required sections:` line), wrong saved-workflow output format, and exact evidence/artifact references that do not belong to the task. Only successful source-tool receipts qualify; login/waiting observations do not. An accepted reduced-scope request prevents the original saved workflow headings from overriding the revised criteria.

Warnings cover unsupported or partial content, prose criteria, missing saved report evidence, possible placeholders, and headings that exceed the complete parser bounds. CSV row, column, cell and byte parser limits also produce coverage warnings rather than falsely declaring a valid large dataset defective. Malformed CSV remains a failure. A pass means only that the listed structural checks passed. It does not certify factual accuracy, calculations, semantic relevance or fulfillment of prose criteria. Receipt membership is not evidence that a source supports every claim.

Integration: the live finish path awaits `checkQuality`, rechecks the task claim, and refuses completion when `canFinish` is false using an actionable `output_required` error. Saved workflow output requirements are exposed in task context. Warnings remain visible in Results. The checker never marks the owner review accepted.

`ResultService.assertRevisionSource` is an optional synchronous authority fence before a new revision creates a task, owner decision, action receipt or input staging. Restricted workflows use it to require a fresh scoped setup instead of inheriting generic revision behavior. This does not interfere with ordinary revisions.

## Formatted exports

`ReportExportController` accepts only `{type:'results.exportReport', taskId, versionId, format}`. The owner-only bridge is `reportExport`, channel `agent-workspaces:report-export`. A native save dialog supplies the destination; renderer-supplied paths are rejected. The controller rechecks completed-result membership and exact verified bytes after the dialog. Existing destinations and symlinks cannot be overwritten. Private staging uses the managed artifact reservation boundary and is released after success or failure.

- Markdown/plain-text results: PDF and Word DOCX reports with restrained typography, styled headings/tables, a review label and the exact source version/hash.
- CSV results: Excel XLSX with frozen headings, filters, readable column widths and a separate source-record sheet. Every cell is editable literal text, preserving identifiers and preventing formula execution. No macros, hyperlinks, embedded objects or external connections are generated.
- Exact original export remains available independently.

PDF uses a fixed escaped HTML template in an ephemeral hidden Electron sandbox. JavaScript, external resources, permissions, popups, navigation and downloads are denied. A 30-second timeout destroys the temporary renderer. The DOCX/XLSX writer creates a small stored ZIP from fixed Office XML parts; it reads no archive inputs and needs no new package.

Complete coverage is mandatory for formatted exports. Text reports support the existing parser bounds (65,536 characters, 1,000 blocks, at most 200 table data rows and 20 columns). CSV supports 1 MiB, 10,000 data rows, 100 columns and 100,000 cells; cells must fit Excel's 32,767-character bound. Generated exports cannot exceed 16 MiB. Oversized or unsupported sources are rejected with an exact-original-export fallback, never silently clipped. Raw Markdown HTML is inert visible text; images and external pages are not loaded.

## Validation performed

Focused tests cover exact task/output ownership using a real temporary Coordinator, missing headings and forged references, complete CSV shape, honest parser-limit warnings, source-hash mismatch, checksum-proven UTF-8 BOM handling, literal plain-text punctuation, escaped hostile content, stored ZIP checksums/parts, XLSX classification and literal formula-like cells, native-dialog cancellation, source recheck, no overwrite and symlink rejection. The real live loop driven by a scripted local adapter rejects an incomplete report, exposes the missing headings, accepts only its corrected saved version, and preserves owner review as unreviewed. A restricted revision callback leaves task/review/action counts unchanged after rejection.

`npx tsx --test tests/phase8/finish-quality.test.ts tests/phase8/quality.test.ts tests/phase8/exports.test.ts tests/phase7/results.test.ts` passed 26 tests with no failures or skips. The 17 Phase 8 tests also passed under Electron's bundled Node. No paid model was involved.

Actual fixture-only checks used `tests/phase8/exports-render-check.ts` bundled for Electron and `tests/phase8/exports-verify.py` with installed independent parsers. The PDF rendered as one complete readable page. A deliberately raw script/image/style/iframe probe generated zero requests to its loopback HTTP sentinel, and PDF text extraction contained the JavaScript-disabled sentinel without the executed sentinel. Runtime preferences confirmed JavaScript and Node integration disabled, sandbox/context isolation/web security enabled. Every archive part parsed as XML; ZIP checksums passed. Python-docx read all 17 report paragraphs and the exact table. Openpyxl read both sheets, all 15 cells as literal strings, preserved leading-zero identifiers and formula-like text, and found no external links. LibreOffice rendered Word to one page and the workbook to two pages; every page was visually inspected and remained readable without clipping. Evidence and renderings are in `.test-data/phase8-export-proof/`.

Not yet validated in this handoff: packaged-app UI controls, live paid-model finish behavior, or compatibility with every application that opens Office files. The working production app and user data were not touched. No external model calls or paid requests were made.

## Reusable UI fixture

`npx tsx scripts/phase8-ui-fixture.ts [new-folder-name]` creates a fresh direct child of `.test-data`, refusing any existing destination. The default fixture is `.test-data/phase8-ui-20260930`. It uses the real Coordinator, provider registry, immutable artifact services, three-role review service, quality gate and owner handoff/acceptance services with a deterministic scripted adapter. It never connects to a model server, reads credentials or accesses an external target.

The created project contains three agents, a published harmless `sample-api.ts` illustration, one completed three-role review with two explicit handoffs and three report results, plus a second paused review for interface exploration. Every report states that its findings are synthetic and not live verified. The saved local provider is labeled “Synthetic fixture — server not running”; its loopback endpoint is illustrative and must not be treated as a running local LLM. The first two reports are accepted by the synthetic owner flow, while the final report remains unreviewed. Shutdown leaves zero enabled tasks/routines. Database integrity and foreign-key checks pass. The default seed required 12 scripted model turns and zero paid/API/network calls. Rerunning against the existing destination was verified to fail without changing `fixture-proof.json`.

## Design references

The downloaded DeerFlow `subagents/report_contract.py` distinguishes self-reports and exact tool receipts from independent verification; its thread exporter excludes hidden reasoning and internal context by default. These informed the evidence boundary. This implementation is original code, does not copy their report contract/export code, and exports only the selected saved deliverable and its source metadata.
