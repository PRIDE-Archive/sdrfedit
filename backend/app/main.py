"""SDRF Wizard AI Assistant backend.

Run with:
    uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .celllines.store import get_cellline_store
from .rag.store import get_spec_store
from .routers import chat, uploads
from .schemas import HealthResult

settings = get_settings()

app = FastAPI(
    title="SDRF Wizard AI Assistant",
    version="1.0.0",
    description="LLM orchestration, specification RAG, PRIDE/paper retrieval and MinerU parsing "
    "for the SDRF Editor creation wizard.",
    root_path=settings.root_path,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(chat.router)
app.include_router(uploads.router)


@app.get("/api/health", response_model=HealthResult, tags=["meta"])
async def health() -> HealthResult:
    """Capability report the frontend uses to decide whether to show the panel."""
    store = get_spec_store()
    celllines = get_cellline_store()
    return HealthResult(
        llmConfigured=settings.llm_configured,
        embeddingsConfigured=settings.embeddings_configured,
        mineruConfigured=settings.mineru_configured,
        specIndexReady=store.ready,
        specChunkCount=store.chunk_count,
        retrieval=store.retrieval_mode,
        celllineIndexReady=celllines.ready,
        celllineRecordCount=celllines.record_count,
        celllineRetrieval=celllines.retrieval_mode,
    )
