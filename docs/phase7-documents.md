# Phase 7: bounded PDF and workbook reading

`DocumentService.extractForAgent` reads an exact task-pinned PDF or XLSX version using a fixed helper inside the existing isolated code container. The model supplies only an artifact version and a bounded page or cell range. It cannot supply Python, paths, shell commands or a different source file to this tool. The result records the source SHA-256, explicit coverage and a verified private JSON artifact produced through the normal code export pipeline.

The helper reuses the existing container's non-root user, memory/process/time limits, network prohibition, task lease and cancellation checks. No PDF or workbook parser runs on the host. A failed extraction does not commit a new workspace revision. File contents are untrusted source material, not agent instructions.

## Supported scope

- Ordinary PDFs: text from up to 10 selected pages per call, 2,000-page document limit and 32,000-character text budget. Page numbers, total pages, truncation and the next page are explicit. Image-only pages are flagged; OCR is not performed. Encrypted PDFs are refused.
- Ordinary XLSX workbooks: a selected worksheet and up to 50 rows by 50 columns per call. Cells retain coordinates, types and number formats. Dates/times are explicit ISO values; integers outside JavaScript's exact numeric range use a marked decimal string. Formula text is retained with an independently read cached value; formulas are never calculated and cached values may be missing or stale. External workbook links are not loaded.
- Archives containing VBA, macro sheets, ActiveX or embedded objects are refused. ZIP entry count, expanded size, compression ratio, encryption and traversal are bounded before workbook parsing. DefusedXML is required.
- Input size is at most 32 MiB; each extracted artifact is at most 192 KiB. Larger documents need a different reviewed workflow. There is no claim that all visual content, chart content, merged-cell presentation or PDF reading order is preserved.

The reviewed runtime recipe installs `pypdf 6.19.0`, `openpyxl 3.1.5`, `et-xmlfile 2.0.0` and `defusedxml 0.7.1` with exact wheel hashes. Library versions are checked against the runtime image before dispatch. The recipe is [containers/code/documents-recipe.json](../containers/code/documents-recipe.json); portable provisioning and rollback boundaries are documented in [phase7-release-foundations.md](phase7-release-foundations.md).

## Evidence and verification

The real fixture creates PDF and XLSX files inside a disposable container, exports them as private artifacts, pins the exact versions to a task, reads them through `DocumentService`, and verifies the exported extraction artifacts. It also checks encrypted-file failure retains the prior workspace, active workbook content is rejected, outbound connectivity is unavailable, and large integers do not silently lose precision.

```sh
AW_DOCUMENT_DOCKER_TEST=1 AW_DOCUMENT_TEST_IMAGE=agent-workspaces-code:documents-portable-test node --import tsx --test tests/phase7/documents.test.ts
```

The test uses no cloud model or owner documents. Without the explicit environment flag, ordinary regression runs skip the Docker integration case and still validate tool argument bounds. Recorded checks are in [document-extraction.json](phase7/evidence/document-extraction.json) and [document-extraction-portable.json](phase7/evidence/document-extraction-portable.json). These prove the extraction/export pipeline using synthetic files; they do not prove arbitrary real-world documents or visual report quality. PDF/XLSX report authoring can use the same reviewed libraries through authorized code execution, but this slice does not add a report-template designer.
