"""Runtime configuration, loaded from environment / backend/.env."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    cors_origins: str = (
        "http://localhost:4200,http://127.0.0.1:4200,https://sdrf.quantms.org"
    )

    # Set when served behind a path-prefixing ingress (e.g. /pride/services/sdrf-assistant)
    # so FastAPI generates correct docs/openapi URLs.
    root_path: str = ""

    llm_base_url: str = "https://api.openai.com/v1"
    llm_api_key: str = ""
    # "Authorization" (default, Bearer-style) or "X-API-Key" for gateways that
    # reserve the Authorization header for a different credential type.
    llm_auth_header: str = "Authorization"
    llm_model: str = "gpt-4o-mini"
    llm_temperature: float = 0.2
    llm_max_tool_rounds: int = 16
    llm_timeout_seconds: float = 120.0

    embedding_base_url: str = "https://api.openai.com/v1"
    embedding_api_key: str = ""
    embedding_model: str = "text-embedding-3-small"
    embedding_batch_size: int = 64

    mineru_mode: str = "api"
    # official = hosted mineru.net v4 contract; simple = self-hosted /file_parse
    mineru_flavor: str = "official"
    mineru_base_url: str = "https://mineru.net/api/v4"
    mineru_api_key: str = ""
    mineru_timeout_seconds: float = 300.0
    mineru_poll_interval_seconds: float = 5.0

    spec_url: str = "https://sdrf.quantms.org/specification.html"
    spec_index_dir: str = "data/spec_index"
    spec_source_file: str = "data/spec/specification.md"

    # Curated Cellosaurus / cell-line tables (repo sdrf-proteomics/) + vector index.
    cellline_db_file: str = "../sdrf-proteomics/cl-annotations-db.tsv"
    cellline_synonyms_file: str = "../sdrf-proteomics/ai-synonyms.tsv"
    cellline_index_dir: str = "data/cellline_index"

    max_upload_mb: int = 30
    session_ttl_seconds: int = 7200

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def spec_index_path(self) -> Path:
        return self._resolve(self.spec_index_dir)

    @property
    def spec_source_path(self) -> Path:
        return self._resolve(self.spec_source_file)

    @property
    def cellline_db_path(self) -> Path:
        return self._resolve(self.cellline_db_file)

    @property
    def cellline_synonyms_path(self) -> Path:
        return self._resolve(self.cellline_synonyms_file)

    @property
    def cellline_index_path(self) -> Path:
        return self._resolve(self.cellline_index_dir)

    @property
    def llm_configured(self) -> bool:
        # Local runtimes (Ollama / vLLM) accept any key, so a base URL is enough there.
        return bool(self.llm_api_key) or "localhost" in self.llm_base_url or "127.0.0.1" in self.llm_base_url

    @property
    def embeddings_configured(self) -> bool:
        return bool(self.embedding_api_key) or "localhost" in self.embedding_base_url

    @property
    def mineru_configured(self) -> bool:
        return self.mineru_mode == "local" or bool(self.mineru_api_key)

    def _resolve(self, value: str) -> Path:
        path = Path(value)
        return path if path.is_absolute() else BACKEND_ROOT / path


@lru_cache
def get_settings() -> Settings:
    return Settings()
