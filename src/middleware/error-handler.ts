import type { ErrorRequestHandler, RequestHandler } from "express";
import { HttpError } from "../lib/errors.js";

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Endpoint not found" } });
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const status = error instanceof HttpError ? error.status : Number(error.status) || 500;
  const code = error instanceof HttpError ? error.code : error.code || "INTERNAL_ERROR";
  if (status >= 500) req.log.error({ err: error }, "Request failed");
  else req.log.warn({ code, message: error.message }, "Request rejected");
  res.status(status).json({
    error: {
      code,
      message: status >= 500 ? "Internal server error" : error.message,
      ...(error.details ? { details: error.details } : {})
    }
  });
};
