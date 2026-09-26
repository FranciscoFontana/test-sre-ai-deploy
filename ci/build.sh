#!/usr/bin/env bash
# Build (CI) de la versión Azure. Cada paso de azure-pipelines.yml llama a una
# acción de este script; el YAML sólo dice qué paso correr.
#
# Directorio de trabajo: el checkout de esta rama (entrega). El de main
# (producto) queda al lado, en ../producto: así lo deja azure-pipelines.yml.
set -euo pipefail

ETIQUETA=build
ACCION="${1:?falta la acción}"
ENTREGA="$(pwd)"
source "$ENTREGA/lib/entorno.sh"

BUILD_DIR="$(cygpath -u "${AGENT_BUILDDIRECTORY:-$(cd .. && pwd)}")"
PRODUCTO="$BUILD_DIR/producto"
STAGING="$(cygpath -u "${BUILD_ARTIFACTSTAGINGDIRECTORY:-$BUILD_DIR/staging}")"
RESULTADOS="$BUILD_DIR/test-results"

[ -d "$PRODUCTO/app" ] || fallar "no encuentro el checkout de main en $PRODUCTO"

sha_main() {
  git -C "$PRODUCTO" rev-parse HEAD
}

case "$ACCION" in
  verificar)
    log "bash   $(command -v bash)"
    log "node   $(node --version)"
    log "npm    $(npm --version)"
    log "docker $(docker --version)"
    docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 \
      || fallar "Docker no responde: ¿está abierto Docker Desktop?"
    log "main   $(sha_main)"
    ;;

  dependencias)
    cd "$PRODUCTO/app"
    npm ci --no-audit --no-fund
    # Los tests de interfaz usan un Chromium real. La descarga queda cacheada en
    # el perfil del usuario, compartida con la versión GitHub: es idempotente.
    npx playwright install chromium
    ;;

  typecheck)
    cd "$PRODUCTO/app"
    npm run typecheck
    ;;

  tests)
    mkdir -p "$RESULTADOS"
    cd "$PRODUCTO/app"
    # El reporter JUnit alimenta la pestaña Tests de Azure. Va por línea de
    # comandos para no tener que tocar la configuración de la app en main.
    npx vitest run --reporter=default --reporter=junit \
      --outputFile.junit="$(winpath "$RESULTADOS/junit.xml")"
    ;;

  imagen)
    SHA="$(sha_main)"
    cd "$PRODUCTO"
    docker build -f docker/Dockerfile -t "az-todo-app:$SHA" --build-arg GIT_SHA="$SHA" .
    # Etiqueta visible en la lista de builds: qué commit de main se construyó.
    echo "##vso[build.addbuildtag]main-${SHA:0:7}"
    log "imagen az-todo-app:$SHA lista"
    ;;

  prune)
    # Va en el build, y no en el release, porque el build corre siempre, pase lo
    # que pase después con la aprobación.
    bash scripts/prune-images.sh 5
    ;;

  empaquetar)
    # Lo que el release necesita, y nada más: el release no ve el repo, sólo
    # estos tres artifacts.
    SHA="$(sha_main)"
    rm -rf "$STAGING/entrega" "$STAGING/producto-qa" "$STAGING/manifest"
    mkdir -p "$STAGING/entrega" "$STAGING/producto-qa/qa-agent" \
             "$STAGING/producto-qa/contracts" "$STAGING/manifest"

    cp -r scripts docker release lib "$STAGING/entrega/"

    cp "$PRODUCTO/qa-agent/package.json" "$PRODUCTO/qa-agent/package-lock.json" \
       "$PRODUCTO/qa-agent/tsconfig.json" "$STAGING/producto-qa/qa-agent/"
    cp -r "$PRODUCTO/qa-agent/src" "$STAGING/producto-qa/qa-agent/"
    cp "$PRODUCTO/contracts/openapi.yaml" "$STAGING/producto-qa/contracts/"

    echo "$SHA" > "$STAGING/manifest/image-tag.txt"
    {
      echo "main=$SHA"
      echo "build=${BUILD_BUILDNUMBER:-local}"
      echo "fecha=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } > "$STAGING/manifest/build-info.txt"

    log "artifacts listos:"
    (cd "$STAGING" && find entrega producto-qa manifest -maxdepth 2 | sort)
    ;;

  *)
    fallar "acción desconocida: $ACCION"
    ;;
esac
