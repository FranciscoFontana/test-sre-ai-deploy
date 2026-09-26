#!/usr/bin/env bash
# Versión Azure: copia de main:scripts/smoke-prod.sh con nombres y puertos propios (az-*, 9080/9081).
# Chequeos determinísticos post-deploy. Sin IA: si esto falla, hay rollback.
# Uso: smoke-prod.sh <sha_esperado>
set -euo pipefail

EXPECTED_SHA="${1:?falta el sha esperado}"
BASE_URL="http://localhost:9080"

echo "[smoke] /healthz"
curl -fsS --max-time 5 "${BASE_URL}/healthz" | grep -q '"ok"'

echo "[smoke] /readyz"
curl -fsS --max-time 5 "${BASE_URL}/readyz" | grep -q '"ready"'

echo "[smoke] /version devuelve el sha desplegado"
ACTUAL_SHA="$(curl -fsS --max-time 5 "${BASE_URL}/version" | sed -n 's/.*"gitSha":"\([^"]*\)".*/\1/p')"
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "[smoke] FALLO: producción sirve '${ACTUAL_SHA}' pero se desplegó '${EXPECTED_SHA}'" >&2
  exit 1
fi

echo "[smoke] la API responde"
curl -fsS --max-time 5 "${BASE_URL}/api/todos" | grep -q '"items"'

echo "[smoke] todo OK — producción sirve ${EXPECTED_SHA}"
