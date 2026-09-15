import fs from "node:fs";
import { Router } from "express";
import { config } from "../config.js";
import { query } from "../db/pool.js";

export const healthRouter = Router();

/**
 * Reports whether a PDF directory is actually reachable.
 *
 * In production both are directories on a mounted blob container, and a mount
 * that is missing, renamed, or holding a stray trailing space is invisible
 * until a reader taps a journal and gets a 404 - which is exactly how the
 * Azure move broke every PDF for four days. A `stat` is cheap enough to run on
 * every call; counting files crosses the mount, so it happens only when
 * `?files=1` asks for it.
 */
async function describeStorage(dir: string, countFiles: boolean) {
  try {
    const stat = await fs.promises.stat(dir);
    if (!stat.isDirectory()) return { dir, readable: false, reason: "not a directory" };
    if (!countFiles) return { dir, readable: true };
    const entries = await fs.promises.readdir(dir);
    return { dir, readable: true, pdfs: entries.filter((entry) => entry.toLowerCase().endsWith(".pdf")).length };
  } catch (error) {
    return { dir, readable: false, reason: (error as NodeJS.ErrnoException).code ?? "unknown" };
  }
}

healthRouter.get("/", async (req, res) => {
  const countFiles = req.query.files === "1";
  // Storage is reported, never fatal: the top-level status stays driven by the
  // database alone, so an unmounted container cannot take the whole API out of
  // a load balancer's rotation while news and search still work.
  const [journals, whitepapers] = await Promise.all([
    describeStorage(config().JOURNAL_STORAGE_DIR, countFiles),
    describeStorage(config().WHITEPAPER_STORAGE_DIR, countFiles)
  ]);
  const storage = { journals, whitepapers };

  try {
    await query("SELECT 1");
    res.json({ status: "ok", database: "ok", storage, timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: "degraded", database: "unavailable", storage, timestamp: new Date().toISOString() });
  }
});
