#!/usr/bin/env bash
# Versión Azure: copia de main:scripts/current-prod-tag.sh con nombres y puertos propios (az-*, 9080/9081).
# Imprime el tag de imagen que está corriendo ahora en producción.
# Vacío si no hay nada desplegado todavía. Se lee del contenedor en ejecución,
# no de un archivo de estado, para que no pueda quedar desincronizado.
set -euo pipefail

IMAGE="$(docker inspect --format '{{.Config.Image}}' az-todo-prod-app 2>/dev/null || true)"
if [ -z "$IMAGE" ]; then
  exit 0
fi
echo "${IMAGE##*:}"
