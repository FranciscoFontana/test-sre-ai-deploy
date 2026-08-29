# Pipeline de despliegue automatizado con QA por IA

Prueba de concepto de un flujo CI/CD donde **un agente de IA decide si un build
llega a producción**. No es un linter ni un generador de tests: es un agente que
recibe el contrato de la API, explora el entorno de QA recién desplegado
haciendo requests reales, y devuelve un veredicto que bloquea o habilita el deploy.

```
                    ┌─────────────────────────────────────────┐
   git push ───────►│         GitHub Actions                  │
   (a main)         │      (self-hosted runner local)         │
                    └────────────────┬────────────────────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
  ┌───────────┐              ┌──────────────┐            ┌────────────────┐
  │  build    │─────────────►│  deploy-qa   │───────────►│     ai-qa      │
  │           │              │              │            │                │
  │ typecheck │              │  :8081       │            │ Claude explora │
  │ vitest    │              │  efímero     │            │ la API y da un │
  │ docker    │              │              │            │ veredicto      │
  └───────────┘              └──────────────┘            └───────┬────────┘
                                                                 │
                                                    ┌────────────┴────────────┐
                                                    │                         │
                                              GATE ✅ pass              GATE ❌ fail
                                                    │                         │
                                                    ▼                         ▼
                                          ┌──────────────────┐        deploy detenido
                                          │   deploy-prod    │        prod intacta
                                          │   :8080          │
                                          │   + smoke test   │
                                          │   + rollback     │
                                          └──────────────────┘
```

## Qué hay acá

| Carpeta | Qué es |
|---|---|
| `app/` | API REST de tareas en Node + TypeScript. El sujeto de prueba. |
| `qa-agent/` | El agente de QA: usa Claude con tool use para probar la API. |
| `contracts/openapi.yaml` | El contrato. Fuente de verdad para el agente. |
| `docker/` | Dockerfile multi-stage y los composes de QA y producción. |
| `scripts/` | Deploy, rollback, smoke test, espera de health, limpieza de imágenes. |
| `.github/workflows/` | El pipeline. |

## Cómo funciona el gate

El agente recibe tres herramientas y nada más:

- **`http_request`** — hace requests contra el entorno de QA. La URL base está
  fijada del lado del servidor: el modelo sólo elige un `path`, nunca un host.
  Es lo que lo confina al entorno bajo prueba.
- **`report_finding`** — registra un bug. Append-only: no hay forma de borrar
  ni editar lo ya reportado.
- **`finish_run`** — cierra la corrida con un veredicto.

Después decide el código de salida:

| Código | Significado | Efecto |
|---|---|---|
| `0` | QA aprobado | el deploy a producción continúa |
| `1` | QA rechazó el build | el deploy se detiene |
| `2` | El gate no pudo ejecutarse | el deploy se detiene |

La distinción entre `1` y `2` es deliberada. Si la API de Claude falla, si falta
el secret o si el entorno de QA no levanta, **no se asume que el build está bien**:
no saber si algo funciona no es lo mismo que saber que funciona.

Una corrida que termina sin llamar a `finish_run` — porque agotó el tope de
iteraciones — también cuenta como fallo por cobertura incompleta.

## Costo

El agente corre con **Claude Haiku 4.5** ($1 / $5 por millón de tokens de
entrada / salida). Una corrida ronda **$0.10 – $0.25**. Tres controles lo acotan:

- **Prompt caching** sobre el bloque estable (reglas de QA + contrato OpenAPI),
  que se sirve del caché desde la segunda iteración.
- **Tope de 20 iteraciones** y de 80 requests HTTP por corrida.
- **`max_tokens` de 4096** por turno.

El agente imprime `cache_read` en el log de cada corrida. Si se queda en cero a
lo largo de varias iteraciones, algo variable se coló en el prefijo del prompt.

## IA y tests determinísticos, no uno en lugar del otro

El job `build` corre 21 tests de Vitest antes de que el agente entre en escena.
Esa es la red determinística: siempre cubre lo mismo, siempre da el mismo
resultado. El agente es la capa exploratoria encima, y **es no determinista** —
dos corridas sobre el mismo código pueden encontrar cosas distintas.

Un agente de IA como único gate sería una mala idea. Como capa adicional sobre
tests fijos, encuentra lo que nadie anticipó al escribirlos.

## Desarrollo local

Levantar la app:

```bash
cd app && npm ci && npm run dev
```

Correr los tests determinísticos:

```bash
cd app && npm test
```

Correr el agente de QA contra la app local (necesita `ANTHROPIC_API_KEY`):

```bash
cd qa-agent && npm ci && QA_BASE_URL=http://localhost:3000 npm run qa
```

## Configuración del agente

| Variable | Default | Qué hace |
|---|---|---|
| `QA_BASE_URL` | — | Entorno a probar. Obligatoria. |
| `ANTHROPIC_API_KEY` | — | Credencial de la API. Obligatoria. |
| `ANTHROPIC_WORKSPACE_ID` | — | Sólo si la key está vinculada a una identidad. |
| `QA_MODEL` | `claude-haiku-4-5` | Modelo a usar. |
| `QA_FAIL_ON` | `high` | Gravedad mínima que bloquea el deploy. |
| `QA_MAX_ITERATIONS` | `20` | Tope de iteraciones del loop agéntico. |
| `QA_MAX_REQUESTS` | `80` | Tope de requests HTTP por corrida. |
| `QA_OUT_DIR` | cwd | Dónde escribir `qa-report.md` y `.json`. |

## Puesta en marcha

Ver [SETUP.md](SETUP.md): Docker Desktop, el self-hosted runner, el secret, y
cómo comprobar que el gate frena un deploy de verdad.

## Alcance

Es una prueba de concepto. Quedan deliberadamente afuera: registry de imágenes,
deploys blue/green, observabilidad, y persistencia (el store es en memoria).
