// Validate the catalogue migration against the selected DB without committing.
// PG* credentials must be supplied by the deployment environment, never logs.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import pg from "pg";

const sql = await fs.readFile(
  new URL(
    "../migrations/040_production_subscription_catalogue.sql",
    import.meta.url,
  ),
  "utf8",
);
const pool = new pg.Pool({
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: true },
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
  max: 1,
});
let client;
try {
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '2s'");
  const before = await client.query(
    "SELECT * FROM subscription_plans WHERE code = ANY($1::text[]) ORDER BY code",
    [
      [
        "journal_india_monthly",
        "journal_india_yearly",
        "journal_global_monthly",
        "journal_global_yearly",
        "journal_all_monthly",
        "journal_all_yearly",
      ],
    ],
  );
  assert.equal(before.rowCount, 6);
  await client.query(sql);
  const after = await client.query(
    "SELECT * FROM subscription_plans WHERE id = ANY($1::uuid[]) ORDER BY code",
    [before.rows.map((row) => row.id)],
  );
  assert.equal(after.rowCount, 6);
  for (let i = 0; i < before.rows.length; i++) {
    const previous = before.rows[i];
    const changed = after.rows[i];
    for (const key of Object.keys(previous).filter(
      (key) => !["name", "apple_product_id", "google_product_id"].includes(key),
    )) {
      assert.deepEqual(
        changed[key],
        previous[key],
        `Unexpected change to ${key}`,
      );
    }
    assert.equal(changed.apple_product_id, changed.google_product_id);
    assert.ok(changed.apple_product_id.startsWith("ibsi_journal_"));
  }
  // Re-running the update must leave the same catalogue.
  await client.query(sql);
  await client.query("ROLLBACK");
  console.log(
    "Catalogue SQL validated for all six existing rows; transaction rolled back. No live mapping changed.",
  );
} catch (error) {
  if (client) await client.query("ROLLBACK").catch(() => {});
  console.error(
    error instanceof Error ? error.message : "Catalogue validation failed",
  );
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
