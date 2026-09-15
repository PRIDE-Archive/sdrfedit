#!/bin/sh
# Builds the spec + cell-line vector indexes using whatever runtime config
# (embedding key etc.) the container was started with, then execs the CMD.
# Both builders are idempotent and degrade to lexical-only indexing when no
# embedding endpoint is configured, so this is safe to run on every start.
set -e

python -m app.rag.build_index || echo "spec index build failed, continuing with existing/lexical index"
python -m app.celllines.build_index || echo "cellline index build failed, continuing with existing/lexical index"

exec "$@"
