import { Router } from "express";

const GIT_SHA = process.env.GIT_SHA ?? "dev";
const APP_VERSION = process.env.APP_VERSION ?? "1.0.0";
const STARTED_AT = new Date().toISOString();

export function healthRouter(): Router {
  const router = Router();

  // Liveness: el proceso está vivo.
  router.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Readiness: el proceso puede atender tráfico. Sin dependencias externas
  // acá son equivalentes, pero se mantienen separados porque el pipeline
  // espera sobre readyz y un healthcheck de contenedor sobre healthz.
  router.get("/readyz", (_req, res) => {
    res.json({ status: "ready" });
  });

  // El pipeline verifica que el SHA desplegado sea el que se buildeó.
  // Deliberadamente NO expone SEED_BUG: el agente de QA tiene que
  // encontrar los bugs probando, no leyéndolos de un endpoint.
  router.get("/version", (_req, res) => {
    res.json({
      version: APP_VERSION,
      gitSha: GIT_SHA,
      startedAt: STARTED_AT,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  return router;
}
