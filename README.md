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
  │ typecheck │              │  :8081       │            │ Gemini explora │
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
| `qa-agent/` | El agente de QA: usa Gemini con function calling para probar la API. |
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

La distinción entre `1` y `2` es deliberada. Si la API del modelo falla, si falta
el secret o si el entorno de QA no levanta, **no se asume que el build está bien**:
no saber si algo funciona no es lo mismo que saber que funciona.

Una corrida que termina sin llamar a `finish_run` — porque agotó el tope de
iteraciones — también cuenta como fallo por cobertura incompleta.

## Qué deja cada corrida

El agente escribe tres archivos, que el pipeline sube como artifact del job:

| Archivo | Para qué |
|---|---|
| `qa-report.html` | El presentable. Se abre en el navegador: veredicto, cobertura, chequeos y evidencia. |
| `qa-report.md` | El que se comenta en el PR y va al resumen del job. |
| `qa-report.json` | El estructurado, para consumir desde otra herramienta. |

Los tres tienen cuatro secciones:

**Cobertura del contrato.** Se enumeran todos los casos que documenta el
OpenAPI —cada combinación de método, ruta y código de respuesta— y se cruzan
contra las requests que el agente ejecutó. Esta parte **no depende de lo que el
agente diga**: se calcula del log, así que no puede exagerar su propia
cobertura. Muestra también las requests fuera de contrato, que suelen ser
exploración legítima.

**Qué probó el agente.** Cada request lleva un campo `purpose` obligatorio
donde el agente declara qué está verificando, escrito como el nombre de un
test. Las requests se agrupan por esa intención y forman la lista de chequeos.
El ❌ de un chequeo se deriva de que un hallazgo apunte al mismo endpoint; la
lista de hallazgos sigue siendo la fuente de verdad.

**Hallazgos.** Cada bug con su gravedad, lo que exige el contrato, lo que
devolvió la aplicación y cómo reproducirlo.

**Evidencia.** Todas las requests con el cuerpo enviado y el recibido,
truncados. Es lo que permite auditar cualquier afirmación de las secciones
anteriores en vez de creerle al agente.

## Costo

El agente corre con **Gemini 3.5 Flash Lite en la capa gratuita** de Google AI Studio:
sin tarjeta de crédito y sin costo por corrida. Lo que se consume es cuota, no dinero.

Los límites de la capa gratuita son acotados — del orden de 10 requests por minuto
y unos cientos por día, y Google los ajusta con el tiempo. Para esta prueba de
concepto alcanzan: cada corrida usa unas 20 llamadas al modelo, así que entran
varias corridas por día.

Tres cosas amortiguan esos límites:

- **Reintentos con backoff** ante un 429. En capa gratuita chocar contra el límite
  por minuto es esperable, y no debe abortar el gate: el agente espera y reintenta.
  Sólo se rinde tras varios intentos, e informa que probablemente sea cuota diaria.
- **Tope de 12 iteraciones** y de 80 requests HTTP por corrida.
- **`maxOutputTokens` de 4096** por turno.

En esta capa **no hay prompt caching**, así que las reglas de QA y el contrato se
mandan enteros en cada iteración. Es la principal razón para mantener el contrato
acotado: pesa contra el límite de tokens por minuto.

> Cambiar de proveedor toca sólo `src/agent.ts`. El estado de la corrida, el gate,
> el reporte y las herramientas no saben con qué modelo están hablando.

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

Correr el agente de QA contra la app local (necesita `GEMINI_API_KEY`):

```bash
cd qa-agent && npm ci && QA_BASE_URL=http://localhost:3000 npm run qa
```

## Configuración del agente

| Variable | Default | Qué hace |
|---|---|---|
| `QA_BASE_URL` | — | Entorno a probar. Obligatoria. |
| `GEMINI_API_KEY` | — | Credencial de Google AI Studio. Obligatoria. |
| `QA_MODEL` | `gemini-3.5-flash-lite` | Modelo a usar. |
| `QA_FAIL_ON` | `high` | Gravedad mínima que bloquea el deploy. |
| `QA_MAX_ITERATIONS` | `12` | Tope de iteraciones del loop agéntico. |
| `QA_MAX_REQUESTS` | `80` | Tope de requests HTTP por corrida. |
| `QA_MAX_OUTPUT_TOKENS` | `4096` | Tope de tokens de salida por turno. |
| `QA_OUT_DIR` | cwd | Dónde escribir `qa-report.md` y `.json`. |

## Puesta en marcha

Ver [SETUP.md](SETUP.md): Docker Desktop, el self-hosted runner, el secret, y
cómo comprobar que el gate frena un deploy de verdad.

## Alcance

Es una prueba de concepto. Quedan deliberadamente afuera: registry de imágenes,
deploys blue/green, observabilidad, y persistencia (el store es en memoria).
