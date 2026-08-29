import { createApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 3000);
const { app, seedBug } = createApp();

app.listen(PORT, () => {
  console.log(`[todo-app] escuchando en http://localhost:${PORT}`);
  console.log(`[todo-app] gitSha=${process.env.GIT_SHA ?? "dev"}`);
  if (seedBug !== "none") {
    // Se loguea pero no se expone por la API: el agente de QA
    // tiene que descubrir el bug probando, no leyéndolo.
    console.warn(`[todo-app] ATENCIÓN: bug sembrado activo -> ${seedBug}`);
  }
});
