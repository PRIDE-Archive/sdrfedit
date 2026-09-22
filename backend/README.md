# SDRF Wizard AI Assistant — backend

Backend for the AI assistant in the SDRF Editor's **Create New SDRF** wizard. The
browser app stays a static SPA; this service is the only component that holds API
keys and the only one that can reach services a browser cannot (MinerU, PDF
downloads, embedding models).

It orchestrates the whole assistant turn: it calls the LLM, dispatches tools,
retrieves specification passages, and returns both a natural-language answer and
a list of **wizard actions** the frontend can apply after the user approves them.

## What it does

| Capability | How |
|---|---|
| Chat orchestration with tool calling | `app/llm/agent.py`, OpenAI-compatible streaming client in `app/llm/client.py` |
| SDRF specification Q&A (RAG) | `app/rag/` — chunked specification + embeddings, hybrid retrieval |
| PXD dataset metadata + raw file list | `app/tools/pride.py` (PRIDE Archive v3) |
| Paper retrieval | `app/tools/literature.py` (Europe PMC search + JATS full text) |
| Paywalled papers | `app/parsing/` — MinerU, plus `POST /api/uploads/pdf` for user-supplied PDFs |
| Verified ontology terms | `app/tools/ontology.py` (EBI OLS4) |
| Template layers and columns | `app/tools/templates.py` (bigbio/sdrf-templates) |

## Setup

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate    # or: uv venv .venv
pip install -r requirements.txt                        # or: uv pip install -r requirements.txt

cp .env.example .env      # then fill in LLM_API_KEY etc.
```

Build the specification knowledge base (a copy of the specification ships in
`data/spec/`, so this works offline):

```bash
python -m app.rag.build_index          # use the bundled copy
python -m app.rag.build_index --fetch  # re-download sdrf.quantms.org/specification.html
```

Run it:

```bash
uvicorn app.main:app --reload --port 8000
```

Check what is configured:

```bash
curl http://localhost:8000/api/health
```

```json
{
  "status": "ok",
  "llmConfigured": true,
  "embeddingsConfigured": true,
  "mineruConfigured": true,
  "specIndexReady": true,
  "specChunkCount": 98,
  "retrieval": "hybrid"
}
```

The frontend reads this endpoint and only shows the assistant panel when the
backend is reachable and `llmConfigured` is true. Point the frontend at the
backend with `assistantBaseUrl` in `src/environments/environment.ts`
(default `http://localhost:8000`).

The same local process also works with the official editor at
https://sdrf.quantms.org/sdrf-editor.html: the browser calls `localhost:8000`
from that HTTPS page. `CORS_ORIGINS` must include `https://sdrf.quantms.org`
(already the default in `.env.example`). Add any other hosted origin you use.

## Configuration

All settings come from `backend/.env` (see `.env.example`). Secrets never leave
the server; the browser never sees a key.

### LLM

Any OpenAI-compatible `/chat/completions` endpoint **with tool calling**:

```env
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
```

Works with OpenAI, DeepSeek, Qwen (compatible mode), OpenRouter, vLLM, and
Ollama (`LLM_BASE_URL=http://localhost:11434/v1`). Tool calling is required —
a model without it cannot gather evidence.

### Embeddings

```env
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_API_KEY=sk-...
EMBEDDING_MODEL=text-embedding-3-small
```

With embeddings configured, retrieval is hybrid (cosine similarity blended with
a BM25-style lexical score). Without them the index still builds and retrieval
degrades to lexical only, which answers most rule lookups but is weaker on
paraphrased questions. Re-run `build_index` after adding an embedding key.

The vector store is a numpy matrix plus a JSON sidecar in `data/spec_index/`
(~100 chunks, so an exhaustive scan is instant). `app/rag/store.py` is the only
file a swap to FAISS or Chroma would touch.

### MinerU (PDF parsing)

Used for papers that are not open access. Two contracts:

```env
# Hosted API
MINERU_MODE=api
MINERU_FLAVOR=official
MINERU_BASE_URL=https://mineru.net/api/v4
MINERU_API_KEY=...
```

```env
# Self-hosted MinerU exposing POST /file_parse
MINERU_MODE=api
MINERU_FLAVOR=simple
MINERU_BASE_URL=http://localhost:8888
```

```env
# Local `mineru` CLI on this machine (needs the models, possibly a GPU)
MINERU_MODE=local
```

Parsing is behind `app/parsing/base.py:PdfParser`, so adding a backend means one
new class and one line in `app/parsing/factory.py`.

If MinerU is unavailable the assistant degrades gracefully: it asks the user to
paste the relevant methods text instead (`POST /api/uploads/text`).

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/chat` | Assistant turn as SSE. Events: `status`, `token`, `actions`, `citations`, `error`, `done`. |
| `POST /api/chat/sync` | Same turn, buffered into one JSON response. Useful for smoke tests. |
| `POST /api/uploads/pdf` | Multipart `sessionId` + `file`. Parses with MinerU and registers the document. |
| `POST /api/uploads/text` | Multipart `sessionId` + `text`. Registers pasted manuscript text. |
| `GET /api/health` | Capability report. |

### Wizard actions

The assistant never mutates the wizard directly. It calls an internal
`propose_wizard_actions` tool, and the backend validates each proposal against a
whitelist in `app/schemas.py:ALLOWED_OPS` before returning it:

```json
{
  "step": "protocol",
  "op": "setCleavageAgent",
  "args": [{ "name": "Trypsin", "msAccession": "MS:1001251" }],
  "label": "Cleavage agent: Trypsin",
  "reasoning": "Methods section states in-solution trypsin digestion.",
  "confidence": "high"
}
```

`op` names mirror the public setters of `WizardStateService`
(`src/app/core/services/wizard-state.service.ts`), so the frontend bridge
dispatches them without a translation table. Anything outside the whitelist is
dropped server-side, and the user still has to approve each action in the panel.

## Annotation methodology

The system prompt in `app/llm/prompts.py` follows the methodology of
[bigbio/sdrf-skills](https://github.com/bigbio/sdrf-skills): gather evidence
from PRIDE and the paper before proposing anything, resolve every controlled
value through OLS rather than recalling it, and check the specification for the
rule behind a column before suggesting a value for it.

## Smoke tests

```bash
python -m pytest tests -q          # unit tests, no network or API keys needed
python scripts/smoke_tools.py      # exercises PRIDE / OLS / Europe PMC / templates (network)
```


### Publication acquisition

PRIDE references are resolved using PMID (restricted to MED records), then normalized
DOI. Conflicting identifiers require clarification; title-only matches are candidates.
The assistant reuses matching session documents, otherwise downloads Europe PMC JATS
XML first. XML is stored as a `documentId`, just like PDFs parsed through MinerU, and
can be read with `read_document`. Tables and supplementary-file references are retained;
supplementary attachments themselves are not automatically downloaded in this version.

If XML is unavailable or fails, open PDF candidates from Europe PMC and Unpaywall are
tried before offering upload. Set `UNPAYWALL_EMAIL` to a real maintainer contact to enable
Unpaywall. Without it, Europe PMC acquisition still works. PDF parsing requires the
existing MinerU configuration; XML does not. Only an actual `%PDF-` response is accepted.

Original downloads are cached in `PUBLICATION_CACHE_DIR` (default `data/publications`)
for `PUBLICATION_CACHE_TTL_SECONDS` (default seven days), with a size limit of
`PUBLICATION_CACHE_MAX_MB` (default 256). Cleanup runs on cache access. Mount this path
on persistent storage to reuse downloads across container restarts. Parsed documents
remain session-scoped and expire with the existing session TTL. A failed PDF parse
retains the original download for retry. Tool results distinguish `download_failed`,
`parse_failed`, and `ready`; discovery distinguishes `abstract_only`, `unavailable`,
`identifier_conflict`, and `needs_confirmation`. Transient HTTP errors retry up to
three attempts; abstracts are not treated as full-text evidence.
