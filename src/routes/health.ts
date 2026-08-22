import { Router } from "express";
import { query } from "../db/pool.js";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ status: "ok", database: "ok", timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: "degraded", database: "unavailable", timestamp: new Date().toISOString() });
  }
});
