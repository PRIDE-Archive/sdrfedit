# SDRF Editor

[License](LICENSE)
[GitHub stars](https://github.com/2024-denglei/sdrfedit/stargazers)

Browser-based editor for the Sample and Data Relationship Format (SDRF): create, edit, validate, and export proteomics sample–data relationship tables. This fork builds on [bigbio/sdrfedit](https://github.com/bigbio/sdrfedit) with an improved **6-step creation wizard** and an optional **wizard AI assistant**.

For a longer walkthrough, see [USER.md](USER.md).

## Highlights

- **Main editor** — virtual scrolling for large tables, ontology-aware cells (EBI OLS), TSV / Excel export
- **Creation wizard (6 steps)** — from templates to a draft SDRF ready for review
- **Validation** — PRIDE SDRF Validator API by default; optional in-browser Pyodide / `sdrf-pipelines`
- **Editor AI recommendations** (optional, frontend-only) — metadata cleanup with your own LLM key
- **Wizard AI assistant** (optional, needs backend) — step-scoped suggestions as one-click Apply cards

## Quick start

### Frontend

```bash
npm install
ng serve
```

Open [http://localhost:4200](http://localhost:4200) .

Production build:

```bash
npm run build
```

Build output lives in `dist/` (committed so CDN / embed deployments stay in sync).

### Wizard AI backend (optional)

The assistant panel needs a small FastAPI service (LLM, MinerU, spec RAG, PRIDE / OLS, …):

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # set LLM_API_KEY and related options
python -m app.rag.build_index # build the specification vector index
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Health check:

```bash
curl http://127.0.0.1:8000/api/health
```

The frontend connects via `assistantBaseUrl` in `src/environments/environment.ts` (default `http://localhost:8000`). With the backend running on this machine, the assistant panel also appears in the official editor at [https://sdrf.quantms.org/sdrf-editor.html](https://sdrf.quantms.org/sdrf-editor.html). Embedded deployments can override the URL with `window.__SDRF_ASSISTANT_URL__` or `localStorage.sdrf_assistant_url`. See [backend/README.md](backend/README.md) for LLM, embedding, MinerU, and CORS configuration.

## Creation wizard (6 steps)


| Step                     | What you fill                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| 1 Experiment Setup       | Technology / sample / experiment templates + **biological sample count**                      |
| 2 Sample Characteristics | Characteristic candidate values + **study factor names and all group labels**                 |
| 3 Sample Values          | Source names, biological replicates, multi-value characteristics, **per-sample factor picks** |
| 4 Runs & Files           | Plex kit, MS-run packing, raw-file pool, **file→run mapping with fraction / tech**            |
| 5 Instrument & Protocol  | Instrument, cleavage agent, modifications (MS / UNIMOD)                                       |
| 6 Review & Create        | Preview and generate the table into the main editor                                           |


Notes:

- `**sampleCount**` = sum of biological replicates across conditions (distinct biological `source name`s) — not the number of conditions, and not the raw-file count
- **Study factors** are defined on Step 2 (candidates) and assigned per sample on Step 3
- AI suggestions appear as **cards**; nothing is written until you click Apply

## AI features

### 1. Editor recommendations (no backend)

On an open table, use a browser-configured OpenAI / Anthropic / Gemini / Ollama key to suggest fixes and metadata improvements.

Optional local example index for stronger suggestions:

```bash
git clone https://github.com/bigbio/sdrf-annotated-datasets.git
node scripts/build-sdrf-index.js ./sdrf-annotated-datasets/datasets
```

### 2. Wizard assistant (needs backend)

The chat panel beside **Create New SDRF** supports:

1. **ProteomeXchange accession (PXD…)** — fetch PRIDE metadata and raw names; prefer downloading the paper PDF and parsing it with MinerU into a session document, then propose Apply cards step by step
2. **Specification Q&A** — retrieve from a vector index of the [SDRF specification](https://sdrf.quantms.org/specification.html) with section citations
3. **Your own PDF or pasted methods** — upload or paste, then annotate the same way as (1)

Ontology values are verified server-side through EBI OLS so the model cannot invent accessions.

## Validation


| Mode          | Description                                                             |
| ------------- | ----------------------------------------------------------------------- |
| PRIDE API     | Default; calls the online SDRF validator                                |
| Local browser | Runs `sdrf-pipelines` in the browser via Pyodide (`src/assets/wheels/`) |


## Embedding (CDN)

Embed the committed build (example points at this repo’s `main`; change branch/tag as needed):

```html
<!DOCTYPE html>
<html>
  <head>
    <link
      rel="stylesheet"
      href="https://cdn.jsdelivr.net/gh/2024-denglei/sdrfedit@main/dist/sdrf-editor/browser/styles.css"
    />
  </head>
  <body>
    <app-root></app-root>
    <script
      src="https://cdn.jsdelivr.net/gh/2024-denglei/sdrfedit@main/dist/sdrf-editor/browser/polyfills.js"
      type="module"
    ></script>
    <script
      src="https://cdn.jsdelivr.net/gh/2024-denglei/sdrfedit@main/dist/sdrf-editor/browser/main.js"
      type="module"
    ></script>
  </body>
</html>
```

After frontend changes, rebuild with `npm run build` and commit the updated `dist/`.

## Project structure

```text
src/
├── app/components/sdrf-editor/     # Main editor
├── app/components/sdrf-wizard/     # Creation wizard
├── app/components/wizard-ai-panel/ # Wizard AI chat panel
├── app/core/services/              # Parse, validate, export, wizard state
├── app/core/services/assistant/    # Assistant API + action bridge
└── workers/                        # Pyodide and related workers
backend/                            # Wizard AI FastAPI service
├── app/llm/                        # Agent, prompts, streaming client
├── app/parsing/                    # MinerU PDF parsing
├── app/rag/                        # Spec chunking and retrieval
├── app/tools/                      # PRIDE, literature, OLS, templates
└── tests/
sdrf-proteomics/                    # Local specification / template reference material
```

## Related projects

- Upstream: [bigbio/sdrfedit](https://github.com/bigbio/sdrfedit)
- [SDRF specification site](https://sdrf.quantms.org)
- [proteomics-metadata-standard](https://github.com/bigbio/proteomics-metadata-standard)
- [sdrf-pipelines](https://github.com/bigbio/sdrf-pipelines)
- [sdrf-annotated-datasets](https://github.com/bigbio/sdrf-annotated-datasets)

## Contributing

```bash
git checkout -b feature/my-change
npm install
npm run build
# if you change the backend:
cd backend && pytest
```

Commit your changes; if the frontend bundle changes, include the updated `dist/`.

## License

Apache License 2.0