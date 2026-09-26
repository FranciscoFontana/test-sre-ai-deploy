# Entorno común del build (ci/build.sh) y del release (release/etapa.sh).
# Se carga con `source`, no se ejecuta.
#
# El agente de Azure corre con el PATH del sistema, y docker.exe no está ahí:
# Docker Desktop lo agrega sólo al PATH del usuario. Se resuelve en este archivo,
# versionado, en vez de en la interfaz del release clásico, que no queda en el repo.

anteponer() {
  if [ -d "$1" ]; then
    PATH="$1:$PATH"
  fi
}

anteponer "/c/Program Files/Docker/Docker/resources/bin"
if [ -n "${LOCALAPPDATA:-}" ]; then
  anteponer "$(cygpath -u "$LOCALAPPDATA")/Programs/DockerDesktop/resources/bin"
fi
anteponer "/c/Program Files/nodejs"
export PATH

# Node, docker y los logging commands de Azure no entienden rutas de Git Bash
# como /c/Users/...: hay que pasarles la forma de Windows.
winpath() {
  cygpath -w "$1"
}

log() {
  echo "[$ETIQUETA] $*"
}

# Además del mensaje, marca el error en la interfaz de Azure.
fallar() {
  echo "##vso[task.logissue type=error]$*"
  echo "[$ETIQUETA] ERROR: $*" >&2
  exit 1
}
