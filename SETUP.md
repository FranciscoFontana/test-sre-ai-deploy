# Puesta en marcha

Pasos que hay que hacer una sola vez, en orden. Todo lo que sigue asume
Windows con Git Bash disponible (viene con Git for Windows).

---

## 1. Docker Desktop

El pipeline construye y corre contenedores en tu máquina.

1. Instalá [Docker Desktop](https://www.docker.com/products/docker-desktop/) con backend **WSL2**.
2. Abrilo al menos una vez y dejá que termine de arrancar.
3. Verificá desde una terminal:

```bash
docker compose version
```

Si el comando responde con una versión, está listo. Dejá Docker Desktop
corriendo: si está cerrado, el pipeline falla en el paso de build.

---

## 2. Self-hosted runner

GitHub Actions corre en la nube. Para que el deploy aterrice en **tu** Docker
local hace falta un runner instalado acá.

1. En GitHub: **Settings → Actions → Runners → New self-hosted runner**.
2. Elegí **Windows x64** y seguí los comandos que te muestra la página
   (descarga, `config.cmd`, token). Instalalo **fuera** de esta carpeta,
   por ejemplo en `C:\actions-runner`.
3. Cuando pregunte por labels adicionales, agregá `docker`.
4. Instalalo como servicio para que no dependa de tener una consola abierta:

```bash
./svc.sh install && ./svc.sh start
```

En Windows los equivalentes son `.\svc.ps1 install` y `.\svc.ps1 start` desde
PowerShell, en la carpeta del runner.

El runner tiene que quedar en estado **Idle** en la página de Runners.

> **Por qué el repo es privado:** un self-hosted runner ejecuta el código del
> repositorio en tu máquina. En un repo público, cualquiera podría abrir un PR
> con un workflow modificado y correr código arbitrario acá. No conectes este
> runner a un repositorio público.

---

## 3. Secret con la API key de Anthropic

El agente de QA necesita credenciales para hablar con Claude.

1. Conseguí una API key en <https://console.anthropic.com/settings/keys>.
2. En GitHub: **Settings → Secrets and variables → Actions → New repository secret**.
3. Nombre exacto: `ANTHROPIC_API_KEY`. Pegá la key como valor.

Si el secret falta o es inválido, el agente termina con código de salida `2`
y el pipeline se detiene. No se interpreta como "QA aprobado".

---

## 4. Primer deploy

```bash
git push -u origin main
```

Andá a la pestaña **Actions** del repositorio. Deberías ver correr, en orden:
`build` → `deploy-qa` → `ai-qa` → `deploy-prod` → `cleanup`.

Al terminar, producción queda sirviendo en <http://localhost:8080>.

---

## 5. Comprobar que el gate realmente frena un deploy

Esto es lo que demuestra que el sistema sirve. En
`.github/workflows/deploy.yml`, dentro del job `deploy-qa`, cambiá:

```yaml
env:
  SEED_BUG: none
```

por:

```yaml
env:
  SEED_BUG: empty-title
```

Commiteá y pusheá. El pipeline debe:

1. Pasar `build` (los tests determinísticos no cubren ese caso).
2. Levantar QA con el bug activo.
3. **Fallar en `ai-qa`**: el agente encuentra que `POST /api/todos` acepta un
   título vacío con 201 cuando el contrato exige 400.
4. **No ejecutar `deploy-prod`**: producción sigue sirviendo la versión anterior.

El reporte del agente queda en el resumen del job y como artifact.
Después revertí el cambio a `none`.

Bugs disponibles: `none`, `empty-title`, `delete-404`.

---

## Comandos útiles

Estado de los entornos:

```bash
docker compose -f docker/compose.prod.yml ps
```

Logs de producción:

```bash
docker compose -f docker/compose.prod.yml logs -f
```

Volver producción a una versión anterior a mano:

```bash
bash scripts/rollback.sh <sha-anterior>
```

Ver qué versión está sirviendo producción:

```bash
curl -s http://localhost:8080/version
```

---

## Problemas frecuentes

**El job queda en "Waiting for a runner"** — el runner está apagado o sin los
labels correctos. Los jobs piden `[self-hosted, windows]`.

**`docker: command not found` en el runner** — el servicio del runner arrancó
antes que Docker Desktop, o se instaló con un PATH que no lo incluye. Reiniciá
el servicio del runner después de que Docker esté corriendo.

**El agente sale con código 2** — no es un fallo de QA, es que el gate no pudo
ejecutarse: falta el secret, la key es inválida, o el entorno de QA no
respondió. El log dice cuál de los tres.

**`Bind for 0.0.0.0:8080 failed: port is already allocated`** — hay algo más
usando el puerto. Cambialo en `docker/compose.prod.yml`.
