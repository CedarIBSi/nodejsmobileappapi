import type { RequestHandler } from "express";
import type { ZodType } from "zod";

export function validate(schema: ZodType, source: "body" | "query" | "params" = "body"): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(Object.assign(new Error("Invalid request"), {
        status: 400,
        code: "VALIDATION_ERROR",
        details: result.error.flatten()
      }));
      return;
    }
    Object.defineProperty(req, source, { value: result.data, writable: true });
    next();
  };
}
