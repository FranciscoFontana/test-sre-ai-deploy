#!/usr/bin/env bash
# Imprime el tag de imagen que está corriendo ahora en producción.
# Vacío si no hay nada desplegado todavía. Se lee del contenedor en ejecución,
# no de un archivo de estado, para que no pueda quedar desincronizado.
set -euo pipefail

IMAGE="$(docker inspect --format '{{.Config.Image}}' todo-prod-app 2>/dev/null || true)"
if [ -z "$IMAGE" ]; then
  exit 0
fi
echo "${IMAGE##*:}"
