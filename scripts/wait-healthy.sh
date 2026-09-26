#!/usr/bin/env bash
# Versión Azure: copia de main:scripts/wait-healthy.sh con nombres y puertos propios (az-*, 9080/9081).
# Espera a que un entorno responda 200 en /healthz.
# Uso: wait-healthy.sh <base-url> [timeout_segundos]
set -euo pipefail

BASE_URL="${1:?falta la URL base}"
TIMEOUT="${2:-90}"
DEADLINE=$(( $(date +%s) + TIMEOUT ))

echo "[wait-healthy] esperando a ${BASE_URL}/healthz (timeout ${TIMEOUT}s)"

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if curl -fsS --max-time 5 "${BASE_URL}/healthz" >/dev/null 2>&1; then
    echo "[wait-healthy] OK: ${BASE_URL} responde"
    curl -fsS --max-time 5 "${BASE_URL}/version" || true
    echo
    exit 0
  fi
  sleep 2
done

echo "[wait-healthy] TIMEOUT: ${BASE_URL} no respondió en ${TIMEOUT}s" >&2
exit 1
