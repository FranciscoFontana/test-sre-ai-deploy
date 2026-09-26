# Versión Azure DevOps — build (CI) + release clásico (CD)

Segunda versión del pipeline con gate de QA por IA, **totalmente aislada** de la de
GitHub Actions. Si esta versión deja de funcionar, la de GitHub sigue igual: no
comparten puertos, contenedores, imágenes, scripts ni cuota de Gemini, y esta rama
no puede disparar nada en GitHub.

Esta rama es **huérfana**: no comparte historia con `main` y sólo contiene la entrega.
La app, el agente y el contrato se bajan de `main` en cada build.

```
    CI — pipeline "az-build"                  CD — release pipeline "az-release"
    (este YAML, versionado)                   (clásico, diseñado en la interfaz)

 ┌──────────────────────────────┐          ┌──────────┐   ┌──────────┐    ┌──────────────┐
 │ checkout main + esta rama    │          │ Artifact │──►│    QA    │─👤►│  Producción  │
 │ npm ci · typecheck · 45 tests│─────────►│ az-build │   │ deploy   │    │ aprobación   │
 │ docker build az-todo-app:sha │ publica  │ (trigger)│   │ agente IA│    │ deploy·smoke │
 │ publica 3 artifacts          │ artifacts└──────────┘   │ reporte  │    │ rollback     │
 └──────────────────────────────┘                         └──────────┘    └──────────────┘
```

## Qué hay en la rama

| Archivo | Qué es |
|---|---|
| `azure-pipelines.yml` | El build (CI). Sólo dice qué paso correr. |
| `ci/build.sh` | La lógica del build: dependencias, tests, imagen, artifacts. |
| `release/etapa.sh` | La lógica del release (CD). Cada tarea del release llama a una acción. |
| `lib/entorno.sh` | PATH con Node y Docker, común al build y al release. |
| `docker/compose.*.yml` | QA en `:9081` y producción en `:9080`, con nombres `az-*`. |
| `scripts/` | Copias de `main:scripts/` con nombres y puertos propios. |

**Regla de diseño:** el release clásico no queda versionado, así que sus tareas son
mínimas —cada una sólo llama a `release/etapa.sh <acción>`— y toda la lógica vive acá.

## Aislamiento respecto de la versión GitHub

| Recurso | GitHub | Azure |
|---|---|---|
| Producción | `:8080` · `todo-prod-app` | `:9080` · `az-todo-prod-app` |
| QA | `:8081` · `todo-qa-app` | `:9081` · `az-todo-qa-app` |
| Proyectos compose | `todo-prod` · `todo-qa` | `az-todo-prod` · `az-todo-qa` |
| Imágenes | `todo-app:*` | `az-todo-app:*` |
| Key de Gemini | proyecto de Google de GitHub | **otro** proyecto de Google |
| Disparo | push a `main` | manual |

---

# Puesta en marcha

Tres tandas: **A** prepara el entorno, **B** crea el build, **C** crea el release.
**Ninguna key ni token se pega en un chat ni se commitea.**

## Tanda A — preparación

### A0. Habilitar los releases clásicos

Las organizaciones creadas después de marzo de 2023 los traen deshabilitados.

1. `https://dev.azure.com/frfontana` → **Organization settings** → **Pipelines → Settings**.
2. **Disable creation of classic release pipelines** → **Off**.
   **Disable creation of classic build pipelines** → dejalo **On** (el build es YAML).
3. Recomendado: **Limit job authorization scope to current project for release
   pipelines** → **On**.

Si el interruptor aparece también en *Project settings → Pipelines → Settings*, tiene que
estar en Off ahí también.

### A1. Docker Desktop andando

Abrilo y esperá *Engine running*.

### A2. Proyecto

**+ New project**: nombre `test-sre-azure`, visibilidad **Private**, Version control Git,
Work item process Basic.

### A3. Key de Gemini en un proyecto de Google nuevo

`https://aistudio.google.com` → **Get API key** → **Create API key** → **creá un proyecto
nuevo** (por ejemplo `test-sre-azure`). No uses el de la key de GitHub: la cuota es por
proyecto y compartirla deja a GitHub sin cuota cuando Azure la gasta.

### A4. Conexión de servicio de GitHub

**Project settings** → **Service connections** → **New service connection** → **GitHub**:

| Campo | Valor |
|---|---|
| Choose authorization | **Grant authorization** |
| OAuth configuration | **AzurePipelines** → **Authorize** |
| Service connection name | **`github-producto`** (exacto: el YAML la busca por nombre) |
| Grant access permission to all pipelines | **Destildado** |

### A5. Token para registrar el agente

**User settings** → **Personal access tokens** → **+ New Token**: nombre
`registro-agente-azure`, organización `frfontana`, vencimiento **mañana**, scopes **Custom
defined** → **Show all scopes** → sólo **Agent Pools: Read & manage**.

### A6. Agente en `C:\azagent`

1. **Organization settings** → **Agent pools** → **Default** → **Agents** → **New agent**
   → **Windows** → **x64** → **Download**.
2. En una **PowerShell común** (no Git Bash, **no como administrador**):

```powershell
mkdir C:\azagent; cd C:\azagent
```

```powershell
Expand-Archive -Path "$HOME\Downloads\vsts-agent-win-x64-*.zip" -DestinationPath .
```

```powershell
.\config.cmd
```

| Pregunta | Respuesta |
|---|---|
| Enter server URL | `https://dev.azure.com/frfontana` |
| Enter authentication type | Enter (PAT) |
| Enter personal access token | el token de A5 |
| Enter agent pool | Enter (`Default`) |
| Enter agent name | `DESKTOP-6LR1GGH-azure` |
| Enter work folder | Enter (`_work`) |
| Enter run agent as service? | **N** |
| Enter configure autologon and run agent on startup? | **N** |

```powershell
.\run.cmd
```

Tiene que decir **Listening for Jobs**. La ventana queda abierta, como la del runner de
GitHub, y hay que volver a levantarla después de cada reinicio.

3. **Revocá el PAT** (User settings → Personal access tokens → **Revoke**): el agente ya
   tiene sus propias credenciales.

---

## Tanda B — el build `az-build`

### B1. Crear el pipeline

**Pipelines** → **New pipeline** → **GitHub** → debajo de la lista, **Choose a different
connection** → **`github-producto`** → `FranciscoFontana/test-sre-ai-deploy` →
**Existing Azure Pipelines YAML file** → Branch **`azure-devops`**, Path
**`/azure-pipelines.yml`** → **Continue** → desplegable junto a **Run** → **Save**.

Si GitHub ofrece instalar la app *Azure Pipelines*, no hace falta. Si ya estaba instalada,
que sea con **Only select repositories**.

### B2. Renombrarlo a `az-build`

**Pipelines** → **⋮** sobre el pipeline → **Rename/move** → **`az-build`**.

### B3. Anular los triggers desde la interfaz

Segunda capa de protección: la interfaz puede pisar lo que dice el YAML.

**Edit** → **⋮** → **Triggers**:

- **Continuous integration**: tildá *Override the YAML continuous integration trigger from
  here* → **Disable continuous integration**.
- **Pull request validation**: tildá *Override the YAML pull request trigger from here* →
  **Disable pull request validation**.
- **Save**.

### B4. Primer build

**Run pipeline** → Branch **`azure-devops`** → **Run**. La primera vez pide permiso para
usar `github-producto` y el pool `Default`: **View** → **Permit**.

Al terminar: pestaña **Tests** con los 45 tests y tres artifacts, `entrega`, `producto-qa`
y `manifest`.

---

## Tanda C — el release `az-release`

### C1. Crear el release

**Pipelines** → **Releases** → **New pipeline** → **Empty job** → **Stage name: `QA`**.
Arriba, renombrá *New release pipeline* a **`az-release`**.

### C2. Artifact

**Artifacts** → **+ Add**:

| Campo | Valor |
|---|---|
| Source type | **Build** |
| Project | `test-sre-azure` |
| Source (build pipeline) | **`az-build`** |
| Default version | **Latest** |
| Source alias | **`_az-build`** (exacto: las tareas usan esta ruta) |

### C3. Disparo automático

Ícono del **rayo** sobre el artifact: **Continuous deployment trigger** → **Enabled**;
**Build branch filters** → Include `azure-devops`; **Pull request trigger** → Disabled.

### C4. Condiciones de QA

*Pre-deployment conditions* de **QA**: trigger **After release**, sin aprobación,
*Pull request deployment* Disabled.

### C5. Tareas de QA

**Agent job**: Display name `Agente QA`, Agent pool **Default**.

Tres tareas **Command line**. Todas con:

- **Script**: `"C:\Program Files\Git\bin\bash.exe" release/etapa.sh <acción>`
- **Advanced → Working Directory**: `$(System.DefaultWorkingDirectory)\_az-build\entrega`

| # | Display name | Acción | Control Options → Run this task | Environment Variables |
|---|---|---|---|---|
| 1 | `Desplegar en QA` | `qa-desplegar` | Only when all previous tasks have succeeded | — |
| 2 | `Agente de QA con IA` | `qa-agente` | Only when all previous tasks have succeeded | **`GEMINI_API_KEY`** = `$(GEMINI_API_KEY)` |
| 3 | `Publicar reporte` | `qa-reporte` | **Even if a previous task has failed, unless the deployment was canceled** | — |

La variable de entorno de la tarea 2 es imprescindible: las variables secretas no llegan
solas. Si falta, la tarea falla diciendo exactamente esto.

### C6. Stage Producción

Sobre la cajita QA → **+ Add** → **New stage** → **Empty job** → **`Producción`**.

### C7. Aprobación

*Pre-deployment conditions* de **Producción**:

| Campo | Valor |
|---|---|
| Select trigger | **After stage** → **QA** |
| Pre-deployment approvals | **Enabled**, aprobador: vos |
| Timeout | **1 day** (si vence, la release se rechaza sola) |
| *The user requesting a release or deployment should not approve it* | **Destildado** — si no, nadie puede aprobar |
| *Revalidate identity of approver before completing the approval* | Destildado |
| *Skip approval if the same approver approved the previous stage* | Destildado |
| Pull request deployment | Disabled |
| Deployment queue settings | **Specific: 1** · **Deploy all in sequence** |

### C8. Tareas de Producción

**Agent job**: Display name `Deploy producción`, Agent pool **Default**. Cuatro tareas
**Command line**, mismo Script y Working Directory que en QA:

| # | Display name | Acción | Control Options → Run this task |
|---|---|---|---|
| 1 | `Desplegar en producción` | `prod-desplegar` | Only when all previous tasks have succeeded |
| 2 | `Smoke test` | `prod-smoke` | Only when all previous tasks have succeeded |
| 3 | `Rollback` | `prod-rollback` | **Only when a previous task has failed** |
| 4 | `Cierre: bajar QA y resumen` | `prod-cierre` | **Even if a previous task has failed, unless the deployment was canceled** |

### C9. Variables

**Variables** → **Pipeline variables**:

| Name | Value | Secreto | Scope | Settable at release time |
|---|---|---|---|---|
| `GEMINI_API_KEY` | la key de A3 | **Sí** (candado) | **QA** | No |
| `SEED_BUG` | `none` | No | **QA** | No |

### C10. Guardar y respaldar

**Save**. Después, **Releases** → `az-release` → **⋮** → **Export**, y guardá el JSON en
esta rama como `release/az-release.json`, para que la configuración de la interfaz también
quede versionada. Volvé a exportarlo cada vez que cambies algo del release.

---

## Uso

1. **Pipelines** → `az-build` → **Run pipeline** (rama `azure-devops`).
2. Al terminar el build se crea una release sola (`Release-1`, `Release-2`…).
3. **QA** despliega en `:9081`, corre el agente y publica el reporte.
4. **Producción** espera tu aprobación. Antes de aprobar, mirá:
   - el reporte en la pestaña **Extensions** de la release;
   - el HTML completo en `C:\azagent\reportes-qa\Release-N\qa-report.html`;
   - QA en vivo en `http://localhost:9081`.
5. **Approve** o **Reject**.

### Dónde quedan los reportes del agente

Un release clásico no puede publicar artifacts (*"Artifact publishing is not supported in
Classic release pipelines"*), así que:

| Qué | Dónde |
|---|---|
| `qa-report.md` | Pestaña **Extensions** de la release |
| `qa-report.html` y `.json` | Logs de la tarea *Publicar reporte* → **Download all logs** |
| Los tres | `C:\azagent\reportes-qa\<Release-N>\` |

### Probar que el gate frena un deploy

`az-release` → **Edit** → **Variables** → `SEED_BUG` = `empty-title` → **Save** → correr
`az-build`. QA tiene que fallar y Producción no dispararse. Después volverlo a `none`.

### Una diferencia con la versión GitHub

Los stages clásicos no tienen un "siempre": QA se baja en la tarea de cierre de
Producción. Si QA falla o rechazás la aprobación, **QA queda levantado en `:9081`** hasta
la próxima release, que lo reemplaza. Sirve para ver el estado que el agente rechazó.

---

## Probar sin Azure

Toda la lógica está en scripts, así que se puede simular en local armando la misma
estructura de carpetas que deja el agente:

```
build/entrega     ← esta rama            release/_az-build/entrega      ┐
build/producto    ← git clone de main    release/_az-build/producto-qa  ├ salen de build/staging
                                         release/_az-build/manifest     ┘
```

Desde `build/entrega`: `bash ci/build.sh <paso>` para `verificar`, `dependencias`,
`typecheck`, `tests`, `imagen`, `prune` y `empaquetar`. Desde `release/_az-build/entrega`:
`bash release/etapa.sh <acción>`, en el orden del release.

---

## Salida limpia

1. Borrar `az-release` y `az-build`, o el proyecto `test-sre-azure`.
2. Volver **Disable creation of classic release pipelines** a **On**.
3. Borrar esta rama y su worktree local.
4. `docker compose -p az-todo-prod down` y `docker compose -p az-todo-qa down`.
5. Borrar las imágenes `az-todo-app:*`.
6. `.\config.cmd remove` en `C:\azagent` y borrar la carpeta.
7. Revocar la key de Gemini de Azure y, en GitHub → Settings → Applications, la
   autorización OAuth de Azure Pipelines.

La versión GitHub no necesita ningún paso: nunca se tocó.

## Disciplina que queda

- Los cambios de producto van a `main`; Azure los toma en el próximo build.
- Un arreglo en un script de despliegue se hace dos veces: en `main:scripts/` y acá.
- Si cambiás el release en la interfaz, volvé a exportar el JSON.
