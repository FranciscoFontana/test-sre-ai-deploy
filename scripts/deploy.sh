#!/usr/bin/env bash
# Versión Azure: copia de main:scripts/deploy.sh con nombres y puertos propios (az-*, 9080/9081).
# Despliega una imagen ya construida en el entorno indicado.
# Uso: deploy.sh <qa|prod> <image_tag>
set -euo pipefail

ENVIRONMENT="${1:?falta el entorno (qa|prod)}"
IMAGE_TAG="${2:?falta el tag de imagen}"

case "$ENVIRONMENT" in
  qa)   COMPOSE_FILE="docker/compose.qa.yml";   BASE_URL="http://localhost:9081" ;;
  prod) COMPOSE_FILE="docker/compose.prod.yml"; BASE_URL="http://localhost:9080" ;;
  *)    echo "[deploy] entorno inválido: $ENVIRONMENT (esperaba qa o prod)" >&2; exit 1 ;;
esac

if ! docker image inspect "az-todo-app:${IMAGE_TAG}" >/dev/null 2>&1; then
  echo "[deploy] la imagen az-todo-app:${IMAGE_TAG} no existe localmente" >&2
  exit 1
fi

echo "[deploy] desplegando az-todo-app:${IMAGE_TAG} en ${ENVIRONMENT}"
IMAGE_TAG="$IMAGE_TAG" docker compose -f "$COMPOSE_FILE" up -d --wait --wait-timeout 90

bash "$(dirname "$0")/wait-healthy.sh" "$BASE_URL" 90
echo "[deploy] ${ENVIRONMENT} sirviendo ${IMAGE_TAG} en ${BASE_URL}"
