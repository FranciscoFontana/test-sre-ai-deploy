import type { ReportData } from "./report.js";
import { SEVERITIES, type RequestLogEntry, type Severity } from "./session.js";

/**
 * Todo lo que entra acá viene del modelo o de la aplicación bajo prueba, así
 * que se escapa sin excepción antes de meterlo en el HTML.
 */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "#c92a2a",
  high: "#e8590c",
  medium: "#e6a817",
  low: "#1c7ed6",
  info: "#868e96",
};

function statusClass(status: number | null): string {
  if (status === null) return "err";
  if (status >= 500) return "s5";
  if (status >= 400) return "s4";
  if (status >= 200 && status < 300) return "s2";
  return "s3";
}

function statusText(entry: RequestLogEntry): string {
  return entry.status === null ? "ERR" : String(entry.status);
}

const STYLE = `
:root{--bg:#fff;--fg:#16161d;--muted:#6b6b76;--line:#e4e4e9;--card:#fafafa;
--ok:#2b8a3e;--bad:#c92a2a;--warn:#b35c00;--accent:#3b5bdb;}
@media (prefers-color-scheme:dark){:root{--bg:#16161d;--fg:#eceff4;--muted:#9a9aa6;
--line:#2c2c36;--card:#1d1d26;--ok:#51cf66;--bad:#ff6b6b;--warn:#ffa94d;--accent:#748ffc;}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1rem;background:var(--bg);color:var(--fg);
font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:60rem;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 .3rem}
h2{font-size:1.1rem;margin:2.5rem 0 .8rem;padding-bottom:.4rem;border-bottom:1px solid var(--line)}
.sub{color:var(--muted);font-size:.85rem;margin:0 0 1.5rem}
.verdict{padding:1.1rem 1.3rem;border-radius:10px;font-weight:600;font-size:1.15rem;
margin-bottom:1.5rem;border:1px solid}
.verdict.ok{background:color-mix(in srgb,var(--ok) 12%,transparent);
border-color:var(--ok);color:var(--ok)}
.verdict.bad{background:color-mix(in srgb,var(--bad) 12%,transparent);
border-color:var(--bad);color:var(--bad)}
.verdict.warn{background:color-mix(in srgb,var(--warn) 12%,transparent);
border-color:var(--warn);color:var(--warn)}
.verdict .note{margin:.5rem 0 0;font-weight:400;font-size:.9rem;color:var(--fg)}
.verdict ul{margin:.6rem 0 0;padding-left:1.2rem;font-weight:400;font-size:.9rem;color:var(--fg)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.7rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.7rem .85rem}
.card .k{font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.card .v{font-size:1.25rem;font-weight:600;margin-top:.15rem;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:.87rem}
th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.87em}
.wrap{overflow-x:auto}
.bar{height:9px;border-radius:5px;background:var(--line);overflow:hidden;margin:.5rem 0 1rem}
.bar>i{display:block;height:100%;background:var(--ok)}
.badge{display:inline-block;padding:.08rem .45rem;border-radius:4px;font-size:.75rem;
font-weight:600;font-family:ui-monospace,monospace}
.s2{background:color-mix(in srgb,var(--ok) 18%,transparent);color:var(--ok)}
.s3{background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent)}
.s4{background:color-mix(in srgb,#e6a817 22%,transparent);color:#a67c00}
.s5,.err{background:color-mix(in srgb,var(--bad) 18%,transparent);color:var(--bad)}
@media (prefers-color-scheme:dark){.s4{color:#ffd43b}}
.finding{border:1px solid var(--line);border-left-width:4px;border-radius:8px;
padding:.9rem 1.1rem;margin-bottom:.9rem;background:var(--card)}
.finding h3{margin:0 0 .5rem;font-size:1rem}
.finding dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:.3rem .8rem;font-size:.87rem}
.finding dt{color:var(--muted);white-space:nowrap}
.finding dd{margin:0;overflow-wrap:anywhere}
pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:.6rem .8rem;
overflow-x:auto;font-size:.8rem;margin:.4rem 0 0}
details{border:1px solid var(--line);border-radius:8px;padding:.6rem .9rem;margin-bottom:.5rem;
background:var(--card)}
summary{cursor:pointer;font-size:.88rem;font-weight:500}
.req{display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap}
.req .m{font-weight:600;font-size:.8rem;min-width:3.5rem}
.purpose{color:var(--muted);font-size:.83rem;margin:.25rem 0 0}
.pass{color:var(--ok);font-weight:600}
.fail{color:var(--bad);font-weight:600}
.note{color:var(--muted);font-size:.8rem;margin-top:.6rem}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--line);
color:var(--muted);font-size:.78rem}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(20rem,1fr));gap:1rem}
.shot{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--card)}
.shot img{display:block;width:100%;height:auto;border-bottom:1px solid var(--line)}
.shot .cap{padding:.6rem .8rem}
.shot .cap .step{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.shot .cap .what{font-size:.87rem;margin-top:.15rem;overflow-wrap:anywhere}
.shot.ko{border-color:var(--bad)}
.uitl{font-size:.85rem}
.uitl td:first-child{color:var(--muted);white-space:nowrap}
`;

export function buildHtmlReport(data: ReportData): string {
  const { meta, gate, coverage, checks, counts } = data;
  const pct = coverage.total === 0 ? 0 : Math.round((coverage.covered / coverage.total) * 100);
  const h: string[] = [];

  h.push("<!doctype html>");
  h.push('<html lang="es"><head><meta charset="utf-8">');
  h.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
  h.push("<title>Reporte de QA automatizado</title>");
  h.push(`<style>${STYLE}</style></head><body><main>`);

  h.push("<h1>Reporte de QA automatizado</h1>");
  h.push(
    `<p class="sub">Entorno <code>${esc(meta.baseUrl)}</code> · modelo <code>${esc(meta.model)}</code> · ${esc(new Date(meta.startedAt).toLocaleString("es-AR"))}</p>`,
  );

  // Veredicto
  if (gate.passed) {
    h.push('<div class="verdict ok">✅ GATE APROBADO — el deploy puede continuar');
    if (data.outcome) h.push(`<ul><li>${esc(data.outcome.summary)}</li></ul>`);
    h.push("</div>");
  } else if (gate.exitCode === 2) {
    h.push('<div class="verdict warn">⚠️ GATE NO EJECUTADO — la corrida se interrumpió');
    h.push(
      '<p class="note">El deploy se detiene porque no se llegó a verificar la aplicación, ' +
        "no porque se haya encontrado un problema. Lo que sigue es lo que el agente alcanzó " +
        "a hacer antes del corte.</p><ul>",
    );
    for (const r of gate.reasons) h.push(`<li>${esc(r)}</li>`);
    h.push("</ul></div>");
  } else {
    h.push('<div class="verdict bad">❌ GATE BLOQUEADO — el deploy se detiene<ul>');
    for (const r of gate.reasons) h.push(`<li>${esc(r)}</li>`);
    h.push("</ul></div>");
  }

  // Tarjetas
  h.push('<div class="cards">');
  const tarjetas: [string, string][] = [
    ["Chequeos", String(checks.length)],
    ["Requests HTTP", String(data.requestLog.length)],
    ["Acciones de UI", String(data.uiLog.length)],
    ["Cobertura", `${coverage.covered}/${coverage.total}`],
    ["Hallazgos", String(data.findings.length)],
    ["Iteraciones", `${meta.iterations}/${meta.maxIterations}`],
    ["Duración", `${(meta.durationMs / 1000).toFixed(0)} s`],
  ];
  for (const [k, v] of tarjetas) {
    h.push(`<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`);
  }
  h.push("</div>");

  if (data.findings.length > 0) {
    h.push('<p class="note">');
    h.push(
      SEVERITIES.filter((s) => counts[s] > 0)
        .map(
          (s) =>
            `<span class="badge" style="background:color-mix(in srgb,${SEVERITY_COLOR[s]} 18%,transparent);color:${SEVERITY_COLOR[s]}">${s}: ${counts[s]}</span>`,
        )
        .join(" "),
    );
    h.push("</p>");
  }

  // Cobertura
  h.push("<h2>Cobertura del contrato</h2>");
  h.push(
    `<p class="sub">Se verificaron <strong>${coverage.covered} de ${coverage.total}</strong> casos documentados en el OpenAPI (${pct}%). Esta sección se calcula del log de requests, no de lo que el agente declare.</p>`,
  );
  h.push(`<div class="bar"><i style="width:${pct}%"></i></div>`);
  h.push('<div class="wrap"><table><tr><th>Caso del contrato</th><th>Estado</th><th>Veces</th></tr>');
  for (const row of coverage.rows) {
    const estado = row.covered
      ? '<span class="pass">✅ verificado</span>'
      : '<span style="color:var(--muted)">⬜ no probado</span>';
    h.push(
      `<tr><td><code>${esc(row.method)} ${esc(row.pathTemplate)}</code> → <span class="badge ${statusClass(row.status)}">${row.status}</span><br><span class="purpose">${esc(row.description)}</span></td><td>${estado}</td><td>${row.hits}</td></tr>`,
    );
  }
  h.push("</table></div>");
  if (coverage.offContract.length > 0) {
    h.push(
      `<p class="note">Además ejecutó ${coverage.offContract.length} requests fuera del contrato (rutas o combinaciones no documentadas), que es exploración legítima.</p>`,
    );
  }

  // Chequeos
  h.push("<h2>Qué probó el agente</h2>");
  h.push(
    '<div class="wrap"><table><tr><th></th><th>Chequeo</th><th>Superficie</th><th>Evidencia</th></tr>',
  );
  for (const c of checks) {
    const marca = c.failed ? '<span class="fail">❌</span>' : '<span class="pass">✅</span>';
    const superficies: string[] = [];
    if (c.entries.length > 0) superficies.push(`API ${c.entries.length}`);
    if (c.uiEntries.length > 0) superficies.push(`UI ${c.uiEntries.length}`);
    const badges = [
      ...c.entries.map((e) => `<span class="badge ${statusClass(e.status)}">${statusText(e)}</span>`),
      ...c.uiEntries.map(
        (e) => `<span class="badge ${e.ok ? "s2" : "err"}">${esc(e.action)}</span>`,
      ),
    ].join(" ");
    h.push(
      `<tr><td>${marca}</td><td>${esc(c.purpose)}</td><td>${esc(superficies.join(" + "))}</td><td>${badges}</td></tr>`,
    );
  }
  h.push("</table></div>");
  h.push(
    '<p class="note">El texto de cada chequeo lo escribió el agente antes de ejecutar la request. La marca ❌ se deriva de que un hallazgo apunte al mismo endpoint; la lista de hallazgos es la fuente de verdad.</p>',
  );

  // Recorrido por la interfaz
  if (data.uiLog.length > 0) {
    const fallidas = data.uiLog.filter((e) => !e.ok).length;
    h.push("<h2>Recorrido por la interfaz</h2>");
    h.push(
      `<p class="sub">El agente operó la aplicación en un navegador real: <strong>${data.uiLog.length} acciones</strong>` +
        (fallidas > 0
          ? `, de las cuales <strong class="fail">${fallidas} fallaron</strong>.`
          : ", todas exitosas.") +
        " Cada captura es el estado de la pantalla justo después de la acción.</p>",
    );

    h.push('<div class="wrap"><table class="uitl"><tr><th>#</th><th>Acción</th><th>Sobre</th><th>Detalle</th><th></th></tr>');
    data.uiLog.forEach((e, i) => {
      h.push(
        `<tr><td>${i + 1}</td><td><code>${esc(e.action)}</code></td><td>${esc(e.target ?? "—")}</td><td>${esc(e.detail ?? "—")}</td><td>${e.ok ? '<span class="pass">✅</span>' : `<span class="fail">❌ ${esc(e.error ?? "")}</span>`}</td></tr>`,
      );
    });
    h.push("</table></div>");

    const conCaptura = data.uiLog
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.screenshot !== undefined);
    if (conCaptura.length > 0) {
      h.push('<div class="shots" style="margin-top:1.2rem">');
      for (const { e, i } of conCaptura) {
        h.push(`<figure class="shot ${e.ok ? "" : "ko"}" style="margin:0">`);
        // Sin loading="lazy": la imagen ya está embebida en el documento, así que
        // no hay descarga que diferir, y con lazy no se decodifica al imprimir
        // a PDF ni al ver el reporte de un vistazo.
        h.push(`<img src="${esc(e.screenshot)}" alt="Paso ${i + 1}: ${esc(e.purpose ?? e.action)}">`);
        h.push('<figcaption class="cap">');
        h.push(`<div class="step">paso ${i + 1} · ${esc(e.action)}${e.ok ? "" : " · falló"}</div>`);
        h.push(`<div class="what">${esc(e.purpose ?? "")}</div>`);
        h.push("</figcaption></figure>");
      }
      h.push("</div>");
    }
  }

  // Hallazgos
  h.push("<h2>Hallazgos</h2>");
  if (data.findings.length === 0) {
    h.push('<p class="sub">No se encontraron desviaciones respecto del contrato.</p>');
  } else {
    for (const f of data.findings) {
      h.push(`<div class="finding" style="border-left-color:${SEVERITY_COLOR[f.severity]}">`);
      h.push(`<h3>${esc(f.title)}</h3>`);
      h.push(
        `<p><span class="badge" style="background:color-mix(in srgb,${SEVERITY_COLOR[f.severity]} 18%,transparent);color:${SEVERITY_COLOR[f.severity]}">${f.severity}</span> <code>${esc(f.endpoint)}</code></p>`,
      );
      h.push("<dl>");
      h.push(`<dt>Esperado</dt><dd>${esc(f.expected)}</dd>`);
      h.push(`<dt>Observado</dt><dd>${esc(f.actual)}</dd>`);
      h.push("</dl>");
      h.push(`<pre>${esc(f.reproduction)}</pre>`);
      h.push("</div>");
    }
  }

  // Evidencia
  h.push("<h2>Evidencia</h2>");
  h.push(
    '<p class="sub">Cada request que el agente ejecutó, con lo que envió y lo que recibió. Es lo que respalda todo lo de arriba.</p>',
  );
  data.requestLog.forEach((e, i) => {
    h.push("<details><summary>");
    h.push(
      `<span class="req"><span class="badge ${statusClass(e.status)}">${statusText(e)}</span> <span class="m">${esc(e.method)}</span> <code>${esc(e.path)}</code> <span class="purpose">${esc(e.purpose ?? "")}</span></span>`,
    );
    h.push("</summary>");
    h.push(`<p class="note">#${i + 1} · ${e.latencyMs} ms${e.bodyBytes ? ` · ${e.bodyBytes} bytes enviados` : ""}</p>`);
    if (e.requestBody) h.push(`<p class="note">Enviado:</p><pre>${esc(e.requestBody)}</pre>`);
    if (e.responseBody) h.push(`<p class="note">Recibido:</p><pre>${esc(e.responseBody)}</pre>`);
    if (e.error) h.push(`<p class="note">Error: ${esc(e.error)}</p>`);
    h.push("</details>");
  });

  h.push(
    `<footer>Generado por el agente de QA · umbral de bloqueo <code>${esc(meta.failOn)}</code> · ${data.requestLog.length} requests en ${(meta.durationMs / 1000).toFixed(1)} s</footer>`,
  );
  h.push("</main></body></html>");
  return h.join("\n");
}
