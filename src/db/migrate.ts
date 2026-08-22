import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

async function migrate() {
  const client = await pool().connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
    const files = (await fs.readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
    for (const filename of files) {
      const exists = await client.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [filename]);
      if (exists.rowCount) continue;
      const sql = await fs.readFile(path.join(migrationsDir, filename), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(filename) VALUES ($1)", [filename]);
        await client.query("COMMIT");
        console.log(`Applied ${filename}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    console.log("Database migrations are up to date");
  } finally {
    client.release();
    await pool().end();
  }
}

migrate().catch((error) => {
  console.error(error instanceof Error ? error.message : "Migration failed");
  process.exit(1);
});
