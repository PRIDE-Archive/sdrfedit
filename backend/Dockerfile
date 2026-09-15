# SDRF Wizard AI Assistant backend
#
# Build context is the REPO ROOT (not backend/), because the app reads
# cell-line reference tables from the sibling sdrf-proteomics/ directory
# (see CELLLINE_DB_FILE / CELLLINE_SYNONYMS_FILE in app/config.py):
#
#   docker build -f backend/Dockerfile -t sdrfedit-backend .
#
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# UID/GID pinned to 1000 to match runAsUser/runAsGroup/fsGroup in
# backend/k8s/deployment.yaml -- otherwise the container runs as 1000 while
# these files are owned by appuser's arbitrary auto-assigned UID, and the
# entrypoint's index-build step fails with a permission error.
RUN groupadd -r -g 1000 appuser && useradd -r -u 1000 -g appuser appuser

# Install Python dependencies first for better layer caching.
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Sibling data repo (cell-line / Cellosaurus tables) — only the two files the
# app actually reads, resolved relative to backend/ as ../sdrf-proteomics/*.
COPY sdrf-proteomics/cl-annotations-db.tsv sdrf-proteomics/ai-synonyms.tsv sdrf-proteomics/

# Application code (includes the bundled data/spec/specification.md, so the
# spec index can be built offline).
COPY backend/ backend/

RUN mkdir -p backend/data/spec_index backend/data/cellline_index \
    && chmod +x backend/docker-entrypoint.sh \
    && chown -R appuser:appuser /app

WORKDIR /app/backend
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
