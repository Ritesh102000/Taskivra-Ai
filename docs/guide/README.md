# Beginner guide sources

The beginner guide introduces Taskivra AI to someone who has not used or built the project. It documents the current local desktop pre-release, not a hosted application. Worked examples are instructions to adapt; they are not records of completed live runs.

- [Read the online guide](https://taskivra-ai-guide.vercel.app)
- [Open the published PDF](https://taskivra-ai-guide.vercel.app/Taskivra-AI-Guide.pdf)
- [Repository PDF](../../output/pdf/Taskivra-AI-Guide.pdf)

## One content source, two editions

`guide-content.json` contains the introductory, setup, usage, troubleshooting, and reference chapters. `use-cases.json` contains eight worked examples. Each example defines prerequisites, reusable agent instructions, the objective and completion criteria, sample inputs, numbered steps, review questions, and limitations.

`scripts/build-guide.py` combines these sources and generates:

- `guide-site/index.html` using `guide-site/template.html`.
- `output/pdf/Taskivra-AI-Guide.pdf` with a linked contents page, subsection links, bookmarks, and return-to-contents links.
- An identical hosting copy at `guide-site/Taskivra-AI-Guide.pdf`.

The website's presentation and navigation live in `guide-site/styles.css` and `guide-site/guide.js`. Update the JSON and template rather than editing the generated HTML directly. Keep chapter IDs stable so existing links continue to work.

## Regenerate

Use Python 3 with ReportLab installed in your own documentation environment. Provide the DejaVu Sans regular, bold, and mono TTF fonts. The builder checks common local font locations; if needed, set `TASKIVRA_FONT_DIR` to your font folder. It does not download fonts or install dependencies.

From the repository root:

```sh
python3 scripts/build-guide.py
```

For a website-only iteration:

```sh
python3 scripts/build-guide.py --html-only
```

Regenerate both editions before publishing a content change. Update the guide edition and application version deliberately; do not describe a planned or scripted feature as demonstrated live behavior.

## Review before publication

Open the full PDF, render and inspect every page, check all internal link and bookmark destinations, and confirm the two PDF copies are byte-identical. Check the online page on desktop and mobile, including chapter/subsection links, search, keyboard focus, narrow tables/code blocks, no-JavaScript reading, and the PDF download. No API key, OAuth client, browser profile, private task file, or test capture belongs in the guide.

## Hosting

Vercel project `taskivra-ai-guide` uses **`guide-site` as its Root Directory**, framework Other, no install/build command, and output directory `.`. Its GitHub connection points to this repository. Only static documentation is intended for hosting. `guide-site/vercel.json` defines response headers and static-page settings.

For a manual CLI deployment, link the repository root to the same Vercel project and inspect `vercel deploy --dry --json` first. The root `.vercelignore` excludes application code and local data; review the list if new root files or folders are added. The intended regular files are the generated HTML, CSS, JavaScript, PDF, and guide Vercel configuration. Deploy from the repository root so the configured Root Directory resolves correctly:

```sh
npx vercel deploy --prod --yes --local-config guide-site/vercel.json
```

Local `.vercel` metadata and credentials must remain ignored. Verify the deployment is Ready, the guide and PDF are accessible without authentication, and the published PDF matches the final local copy before updating or announcing links.
