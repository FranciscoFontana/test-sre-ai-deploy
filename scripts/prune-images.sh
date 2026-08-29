#!/usr/bin/env bash
# Conserva las N imágenes todo-app más recientes y borra el resto.
# Sin esto, cada deploy deja una imagen y el disco de la máquina se llena.
# Nunca borra la imagen que está corriendo en producción.
set -euo pipefail

KEEP="${1:-5}"
IN_USE="$(docker inspect --format '{{.Config.Image}}' todo-prod-app 2>/dev/null || true)"

docker images todo-app --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' \
  | sort -r \
  | tail -n "+$((KEEP + 1))" \
  | cut -f2 \
  | while read -r image; do
      if [ "$image" = "$IN_USE" ]; then
        echo "[prune] conservando $image (en producción)"
        continue
      fi
      echo "[prune] borrando $image"
      docker rmi "$image" >/dev/null 2>&1 || true
    done

echo "[prune] listo"
