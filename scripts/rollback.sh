#!/usr/bin/env bash
# Vuelve producción al tag indicado.
# Uso: rollback.sh <tag_anterior>
set -euo pipefail

PREVIOUS_TAG="${1:-}"

if [ -z "$PREVIOUS_TAG" ]; then
  echo "[rollback] no hay versión anterior a la cual volver (primer deploy)." >&2
  echo "[rollback] bajando producción para no dejar un build roto sirviendo." >&2
  docker compose -f docker/compose.prod.yml down || true
  exit 1
fi

if ! docker image inspect "todo-app:${PREVIOUS_TAG}" >/dev/null 2>&1; then
  echo "[rollback] la imagen anterior todo-app:${PREVIOUS_TAG} ya no existe localmente" >&2
  exit 1
fi

echo "[rollback] volviendo producción a todo-app:${PREVIOUS_TAG}"
IMAGE_TAG="$PREVIOUS_TAG" docker compose -f docker/compose.prod.yml up -d --wait --wait-timeout 90
bash "$(dirname "$0")/wait-healthy.sh" "http://localhost:8080" 90
echo "[rollback] producción restaurada en ${PREVIOUS_TAG}"
