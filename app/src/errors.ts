import type { Response } from "express";

/** Forma uniforme de error en toda la API: { error: { code, message } } */
export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  const body: ApiError = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}
