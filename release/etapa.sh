#!/usr/bin/env bash
# Release (CD) de la versión Azure. Cada tarea del release clásico "az-release"
# llama a una acción de este script. En la interfaz de Azure sólo se configura
# qué acción corre, en qué orden y con qué condición: la lógica queda versionada.
#
# Directorio de trabajo: la carpeta del artifact "entrega", que Azure descarga en
#   $(System.DefaultWorkingDirectory)\_az-build\entrega
# con los otros dos artifacts al lado:
#   ../producto-qa   el agente de QA y el contrato OpenAPI
#   ../manifest      image-tag.txt, el SHA de main que construyó el build
#
# Acciones del stage QA:          qa-desplegar · qa-agente · qa-reporte
# Acciones del stage Producción:  prod-desplegar · prod-smoke · prod-rollback · prod-cierre
set -euo pipefail

ETIQUETA=release
ACCION="${1:?falta la acción}"
ENTREGA="$(pwd)"
source "$ENTREGA/lib/entorno.sh"

RAIZ="$(cd .. && pwd)"
PRODUCTO_QA="$RAIZ/producto-qa"
MANIFEST="$RAIZ/manifest/image-tag.txt"
REPORTES="$RAIZ/qa-reports"
PREV_TAG_FILE="$RAIZ/prev-tag.txt"
QA_URL="http://localhost:9081"
PROD_URL="http://localhost:9080"
RELEASE="${RELEASE_RELEASENAME:-local-$(date +%Y%m%d-%H%M%S)}"

[ -f "$MANIFEST" ] || fallar "no encuentro $MANIFEST: ¿el release tiene el artifact manifest?"
IMAGE_TAG="$(tr -d '[:space:]' < "$MANIFEST")"

# Dónde queda la copia local de los reportes. Un release clásico no puede
# publicar artifacts, así que además de adjuntarlos a los logs se guardan acá.
historial_dir() {
  local base
  if [ -n "${REPORTES_HISTORIAL:-}" ]; then
    base="$(cygpath -u "$REPORTES_HISTORIAL")"
  elif [ -n "${AGENT_HOMEDIRECTORY:-}" ]; then
    base="$(cygpath -u "$AGENT_HOMEDIRECTORY")/reportes-qa"
  else
    base="$RAIZ/reportes-qa"
  fi
  echo "$base/$RELEASE"
}

version_en() {
  curl -fsS --max-time 5 "$1/version" 2>/dev/null \
    | sed -n 's/.*"gitSha":"\([^"]*\)".*/\1/p'
}

case "$ACCION" in
  # ------------------------------------------------------------------ QA
  qa-desplegar)
    log "$RELEASE · QA <- az-todo-app:$IMAGE_TAG · SEED_BUG=${SEED_BUG:-none}"
    SEED_BUG="${SEED_BUG:-none}" bash scripts/deploy.sh qa "$IMAGE_TAG"
    ;;

  qa-agente)
    # En un release clásico las variables secretas no llegan solas al proceso:
    # hay que mapearlas en la tarea. Sin esto el agente diría "falta la key" y
    # parecería un secret mal cargado cuando está bien cargado.
    [ -n "${GEMINI_API_KEY:-}" ] || fallar \
      "la tarea no recibe GEMINI_API_KEY. En la tarea 'Agente de QA con IA' → Environment Variables, agregá GEMINI_API_KEY = \$(GEMINI_API_KEY)"

    rm -rf "$REPORTES"
    mkdir -p "$REPORTES"
    cd "$PRODUCTO_QA/qa-agent"
    npm ci --no-audit --no-fund
    npx playwright install chromium

    log "$RELEASE · agente de QA contra $QA_URL"
    # El código de salida del agente decide el stage: 0 aprueba, 1 encontró un
    # bug, 2 no pudo ejecutarse. Con 1 o 2 el stage QA falla y Producción no
    # se dispara.
    QA_BASE_URL="$QA_URL" \
    QA_OUT_DIR="$(winpath "$REPORTES")" \
    QA_CONTRACT_PATH="$(winpath "$PRODUCTO_QA/contracts/openapi.yaml")" \
    QA_FAIL_ON="${QA_FAIL_ON:-high}" \
    QA_MAX_ITERATIONS="${QA_MAX_ITERATIONS:-22}" \
      npm run qa
    ;;

  qa-reporte)
    # Corre aunque el agente haya fallado: es justo cuando más importa leerlo.
    if [ ! -f "$REPORTES/qa-report.md" ]; then
      mkdir -p "$REPORTES"
      printf '%s\n' \
        "## ⚠️ El agente de QA no llegó a generar un reporte" \
        "" \
        "El gate no pudo ejecutarse. Revisá el log de la tarea *Agente de QA con IA*." \
        > "$REPORTES/qa-report.md"
    fi

    echo "##vso[task.uploadsummary]$(winpath "$REPORTES/qa-report.md")"
    for f in qa-report.html qa-report.json; do
      if [ -f "$REPORTES/$f" ]; then
        echo "##vso[task.uploadfile]$(winpath "$REPORTES/$f")"
      fi
    done

    DEST="$(historial_dir)"
    mkdir -p "$DEST"
    cp "$REPORTES"/qa-report.* "$DEST/"
    log "reporte: pestaña Extensions de la release, adjunto a los logs, y en $(winpath "$DEST")"
    ;;

  # ------------------------------------------------------------------ Producción
  prod-desplegar)
    # Se captura ANTES de desplegar: es la versión a la cual volver si el smoke
    # test falla. Se lee del contenedor en ejecución, no de un archivo de estado.
    rm -f "$PREV_TAG_FILE"
    PREV="$(bash scripts/current-prod-tag.sh)"
    echo "$PREV" > "$PREV_TAG_FILE"
    echo "##vso[task.setvariable variable=PREV_TAG]$PREV"
    log "$RELEASE · producción <- az-todo-app:$IMAGE_TAG (antes: ${PREV:-nada desplegado})"
    bash scripts/deploy.sh prod "$IMAGE_TAG"
    ;;

  prod-smoke)
    bash scripts/smoke-prod.sh "$IMAGE_TAG"
    ;;

  prod-rollback)
    # Defensa contra una condición mal configurada en la interfaz. Esta tarea
    # tiene que correr sólo si falló una anterior; si por error corre siempre,
    # deshace cada deploy bueno. Como la configuración del release no está
    # versionada, el script no confía en ella: si producción ya está sana con
    # la versión de esta release, no hay nada que revertir.
    if bash scripts/smoke-prod.sh "$IMAGE_TAG" >/dev/null 2>&1; then
      echo "##vso[task.logissue type=warning]Rollback omitido: producción está sana y sirve $IMAGE_TAG. Si ningún paso falló, esta tarea no debería haber corrido: revisá Control Options → Run this task, tiene que ser 'Only when a previous task has failed'."
      log "producción sana con $IMAGE_TAG: no hay nada que revertir"
      exit 0
    fi

    PREV="$(cat "$PREV_TAG_FILE" 2>/dev/null || true)"
    log "rollback de producción a: ${PREV:-(no hay versión anterior)}"
    bash scripts/rollback.sh "$PREV"
    ;;

  prod-cierre)
    # Los stages clásicos no tienen un "siempre": QA se baja acá. Si QA falló
    # o la aprobación se rechazó, este stage no corre y QA queda levantado
    # hasta que la próxima release lo reemplace.
    log "bajando QA"
    docker compose -f docker/compose.qa.yml down --remove-orphans || true

    ACTUAL="$(version_en "$PROD_URL" || true)"
    RESUMEN="$RAIZ/deploy-resumen.md"
    {
      echo "## Deploy a producción · $RELEASE"
      echo
      if [ "$ACTUAL" = "$IMAGE_TAG" ]; then
        echo "✅ Producción sirve \`$IMAGE_TAG\` en $PROD_URL"
      elif [ -n "$ACTUAL" ]; then
        echo "❌ Esta release traía \`$IMAGE_TAG\`, pero producción sirve \`$ACTUAL\`:"
        echo "el deploy falló y se volvió a la versión anterior."
      else
        echo "❌ Producción no responde en $PROD_URL."
      fi
    } > "$RESUMEN"
    echo "##vso[task.uploadsummary]$(winpath "$RESUMEN")"
    cat "$RESUMEN"
    ;;

  *)
    fallar "acción desconocida: $ACCION"
    ;;
esac
