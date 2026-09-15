# SDRF Editor User Guide

This guide is aimed at researchers and data managers who use [SDRF Editor](https://github.com/bigbio/sdrfedit) day to day. It explains how to create, import, edit, validate, and export SDRF (Sample and Data Relationship Format) files.

SDRF Editor runs entirely in the browser with no backend required; it's suited to organizing sample and data relationship metadata for proteomics experiments and preparing submissions to repositories such as PRIDE / ProteomeXchange.

---

## 1. Quick Start

### Running locally

```bash
npm install
ng serve
```

Open in your browser: `http://localhost:4200`

### Using it directly (embed / CDN)

You can also load the built frontend bundle via jsDelivr (see the Embedding section of [README.md](README.md)).

### Opening a file via URL parameters

- `?url=<SDRF file URL>`: automatically loads the TSV from the given address
- `?content=<base64-encoded TSV>`: loads the encoded content directly (e.g. used when redirecting from the template builder)

---

## 2. Home Page: Four Ways to Get Started

When you open the app with no table currently loaded, you'll see a welcome page where you can:

| Action | Description |
|------|------|
| **Create New SDRF** | Launch the guided wizard to create an SDRF from scratch |
| **Import SDRF File** | Import a `.tsv` / `.txt` / `.sdrf` file from your machine |
| **Load URL** | Enter a publicly accessible SDRF file URL to load it |
| **Load Example** | Load an official example dataset to get familiar with the interface |

If there's unsaved edit cache from a previous session in the browser, a **Recover Your Work** prompt may appear on startup, letting you recover or discard it.

---

## 3. Creating a New SDRF with the Wizard

After clicking **Create New SDRF**, fill in experiment information step by step. The progress bar lets you go back to completed steps; incomplete steps must be advanced through in order.

### Step overview

1. **Experiment Setup**
   Choose a sample / technology template (e.g. Human, Cell Lines, Vertebrates, MS Proteomics, DIA Acquisition, etc.).

2. **Sample Characteristics**
   Define sample characteristic columns such as organism, disease, tissue, and so on.

3. **Sample Values**
   Fill in a name, biological replicate, and candidate characteristic values for each sample, and declare the study factors (what you're grouping by).

4. **Runs & Files**
   Configure MS runs, channel packing, and raw data file mappings.

5. **Instrument & Protocol**
   Fill in instrument, cleavage agent, modification, and other information.

6. **Review & Create**
   Preview the result and generate the table, then continue editing in the main editor.

Once finished, the table appears in the main editing interface, where you can keep editing, validating, and exporting.

### AI Assistant panel

If [an assistant backend has been deployed](#102-wizard-ai-assistant-requires-a-backend), an **SDRF Assistant** chat panel appears to the right of the wizard (reopen it any time via `Ask AI` in the title bar). It covers three scenarios:

1. **You have a PXD accession**: just type in `PXD012345`. The assistant fetches PRIDE metadata and the RAW file list, locates the associated publication and reads its methods section, then suggests values for the template tier, sample characteristics, instrument, enzyme, modifications, plex kit, and file mappings. If the article isn't open access, it first tries to download a free PDF and parse it with MinerU; if that isn't possible, it prompts you to upload a PDF.

2. **You want to ask a specification question**: for example, "How should I write `comment[modification parameters]`?" The assistant answers using a vector index built over the [SDRF specification](https://sdrf.quantms.org/specification.html) and provides clickable section references. This case never modifies the wizard.

3. **You have your own article**: click **Attach PDF** to upload it (parsed via MinerU), or paste the methods section directly into the chat box. The suggestion flow afterward is the same as case 1.

Each suggestion renders as a card containing:

| Element | Meaning |
|------|------|
| Title and confidence | The suggestion content, plus a high / medium / low confidence level |
| `Current value → Suggested value` | What will change if applied |
| Basis | Whether the value comes from PRIDE, the article, or the specification |
| Step link | Jumps to the corresponding wizard step (only steps already reached) |
| Apply / Dismiss | Accept or ignore the suggestion; **the wizard is only changed if you click Apply** |

Multiple suggestions can be accepted at once with **Apply all**. All ontology values are validated against EBI OLS on the backend, so the model cannot fabricate accession numbers; suggestions with invalid parameters are blocked at apply time and the reason is shown.

---

## 4. Main Editor Interface

### Toolbar

| Button / Area | Function |
|-------------|------|
| **Export TSV** | Export the current table as TSV and download it |
| **Validate** | Open the validation panel |
| **+ Row** | Add a new row at the end of the table |
| **+ Column** | Add a column following SDRF naming conventions |
| **Filter** | Filter rows by column conditions |
| **Stats** | Open the column statistics sidebar |

The right side of the toolbar shows the column count, sample count, and a column-type legend:

- **Sample Accession**: columns related to sample identity
- **Sample Properties**: `characteristics[...]`
- **Data Properties**: `comment[...]`
- **Factor Values**: `factor value[...]`

When there are unsaved changes, the toolbar may show a change count (a local cache indicator).

### Column colors and required-field markers

- Column headers are color-coded by column type, making it easier to distinguish sample properties, data properties, and factors
- Required column names are marked with a `*`
- Click a header to sort; the edit button on a header opens the bulk-edit panel for that column

### Browsing large tables

The editor uses virtual scrolling to handle large row counts. **Go to row** at the bottom lets you jump to a row by entering its number.

---

## 5. Editing Cells

1. **Single-click** to select a cell
2. **Double-click** to open the cell editor

The editor offers different input types depending on the column type, for example:

- **Ontology**: search and select standardized terms via EBI OLS (e.g. organism, tissue, disease, instrument, etc.)
- **Age**: structured age input
- **Modification**: input related to protein modifications
- **Cleavage**: input related to cleavage agents
- **Dropdown selection**: predefined options such as pooled sample, labeling, etc.

### Reserved values

Some fields can use reserved values defined by the specification, with the following meanings:

| Value | Meaning |
|----|------|
| `not available` | Not collected or could not be determined |
| `not applicable` | Does not apply to this sample type |
| `anonymized` | Redacted for privacy or similar reasons |
| `pooled` | The sample is a pooled mixture |

The table visually distinguishes these reserved values.

### Right-click menu

Right-clicking a cell provides common operations, such as:

- Select all cells with the same value / the entire column
- Edit or clear the selected cell(s)
- Insert a row above / below, delete selected rows
- Add or delete a column

### Bulk operations

- Check the checkbox on the left of a row (or select all visible rows via the header checkbox), then use the **Bulk Toolbar** to change columns for the selected samples in bulk
- Use the column statistics panel to filter samples by value, then edit them in bulk
- The edit entry point next to a column header lets you bulk-assign values to that column

---

## 6. Filtering & Statistics

### Filter

Click **Filter** to add conditions. Supported operators:

- equals / contains / starts_with / ends_with
- is_empty / is_not_empty

Filtering only affects the currently visible rows, making it easier to locate problem samples in a large table.

### Stats

The **Stats** sidebar shows the value distribution for each column, and lets you:

- Select the samples matching a given value
- Start a bulk edit from the statistics results

Useful for checking missing values, inconsistent spelling, or unusual distributions.

---

## 7. Validation (Validate)

Click **Validate** to open the validation panel. Two backends are available:

| Mode | Description |
|------|------|
| **PRIDE API** (default) | Sends the current SDRF to PRIDE's deployed validation service |
| **Local browser** | Runs `sdrf-pipelines` in the browser via Pyodide; the file never leaves your machine |

### Recommended workflow

1. Choose a Backend (API or Local)
2. Check the **Templates** to validate against (the set of templates matching your experiment type)
3. Click **Validate via API** or **Validate Locally**
4. Review the errors / warnings summary

Validation results are aggregated by identical error message:

- Click an affected row number to jump to the corresponding cell
- If suggested wording is available, it's shown in the error card

The first time you enable **Local browser**, the local validation environment needs to download; wait until the status becomes Ready before validating.

> **Privacy tip**: if your data is sensitive and you'd rather not upload it, use the **Local browser** mode.

---

## 8. Export

Use **Export TSV** on the toolbar to download the current edited result. The exported file can be used directly for downstream QC, repository submission, or integration with other tools.

(Excel export is also supported at the code level; the UI focuses on TSV export.)

---

## 9. Local Cache & Recovery

While you edit, the app caches your progress locally in the browser.

- If you close the tab and reopen it and unfinished work is detected, you'll be prompted with **Recover Your Work**
- Choosing **Recover** restores the cached version matching the sample count, column count, and number of edits
- If you don't need it, you can discard the cache and re-import or start a new one

Even so, it's recommended to actively use **Export TSV** at important milestones as a formal backup.

---

## 10. AI Assistance (Optional)

The project has two independent AI capabilities, both optional.

### 10.1 Editor recommendations (browser-only)

Used to suggest metadata quality improvements and validation-issue fixes for the currently open table. Configurable providers include:

- OpenAI
- Anthropic
- Google Gemini
- Local Ollama

The API key is only ever used client-side; you can choose to save it for the session only, or persist it encrypted (see the settings dialog for details).

### 10.2 Wizard AI assistant (requires a backend)

The assistant in the wizard needs a local FastAPI service, because it has to download PDFs, call MinerU, and hold LLM and embedding keys — none of which belong in the browser. Keys live only on the server; the browser never sees them.

```bash
cd backend
uv venv .venv && uv pip install -r requirements.txt   # or python3 -m venv + pip
cp .env.example .env                                  # fill in LLM_API_KEY
python -m app.rag.build_index                         # build the specification knowledge base index
uvicorn app.main:app --port 8000
```

Key settings in `backend/.env`:

| Variable | Purpose |
|------|------|
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | Any OpenAI-compatible endpoint that **supports tool calling** (OpenAI, DeepSeek, Qwen's OpenAI-compatible mode, OpenRouter, vLLM, Ollama) |
| `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` | Vectorization for the specification knowledge base. Works without it too — retrieval falls back to lexical matching; add the key later and re-run `build_index` |
| `MINERU_MODE` / `MINERU_FLAVOR` / `MINERU_API_KEY` | PDF parsing. `api`+`official` uses the mineru.net online API, `api`+`simple` uses a self-hosted service, `local` uses the local `mineru` command line |
| `CORS_ORIGINS` | Frontend origins allowed to access the backend, e.g. `http://localhost:4200` |

Use `curl http://localhost:8000/api/health` to see which capabilities are ready. The frontend probes this endpoint when opening the wizard, and only shows the assistant panel if the backend is reachable and an LLM is configured.

The backend address comes from `assistantBaseUrl` in `src/environments/environment.ts`; when embedding via CDN where rebuilding isn't possible, you can set `window.__SDRF_ASSISTANT_URL__` at runtime, or write `sdrf_assistant_url` in `localStorage` (the panel also offers an address input directly whenever it can't reach the backend).

Not configuring MinerU doesn't stop things from working: the assistant will instead ask you to paste the methods section into the chat box.

See [`backend/README.md`](backend/README.md) for more detailed deployment notes, and how to swap out the vector store or the parsing backend.

---

## 11. Common Workflow Examples

### A. Submitting a new experiment from scratch

1. Create New SDRF → complete the wizard
2. Check file names, channels, and factor values in the table
3. Validate (recommend selecting the matching template first)
4. Jump to and fix errors
5. Export TSV for repository submission

### A'. Back-annotating from an already-published dataset (requires the assistant backend)

1. Create New SDRF, then enter the PXD accession in the assistant panel on the right
2. Wait for the assistant to finish fetching PRIDE metadata and the publication; if the article isn't open access, upload a PDF when prompted
3. Review each suggestion card's `Current value → Suggested value`, Apply to accept or Dismiss to ignore
4. Go back to the wizard and fill in the fields the assistant had no basis for (sample count, per-sample values, etc.)
5. Review & Create → Validate → Export TSV

### B. Revising an existing SDRF

1. Import SDRF File (or Load URL)
2. Use Filter / Stats to locate problem columns
3. Fix via double-click editing or bulk editing
4. Validate → Export TSV

### C. Learning the specification conventions

1. Load Example
2. Observe column naming and reserved-value usage
3. Cross-reference the [SDRF Specification](https://sdrf.quantms.org/specification.html)

---

## 12. Usage Tips

- Follow SDRF column naming conventions: `characteristics[name]`, `comment[name]`, `factor value[name]`
- Prefer selecting biological terms via Ontology search rather than free text, to avoid spelling inconsistencies
- Before validating, confirm the selected Templates match your experiment type, otherwise you may see unrelated errors
- When editing large files, prefer Filter, row jump, and bulk edit over cell-by-cell operations
- Complete at least one validation before formal submission, and keep the exported TSV as a backup

---

## 13. Related Resources

- [SDRF project homepage](https://sdrf.quantms.org/)
- [SDRF specification](https://sdrf.quantms.org/specification.html)
- [proteomics-metadata-standard](https://github.com/bigbio/proteomics-metadata-standard)
- [sdrf-pipelines](https://github.com/bigbio/sdrf-pipelines)
- [sdrf-annotated-datasets](https://github.com/bigbio/sdrf-annotated-datasets)

For developer installation, build, embedding, and contribution instructions, see [README.md](README.md).

---

## License

Apache License 2.0
