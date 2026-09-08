import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "../src/config.js";

const tables = [
  "app_users",
  "subscription_plans",
  "subscriptions",
  "entitlements",
  "push_tokens",
  "news_reading_history",
  "saved_news_articles",
  "news_article_access",
  "store_events",
  "pv_ibsi_journal_data",
  "db_white_paper_data",
  "galaxy_page",
  "journal_about",
  "award_programs",
  "house_ads",
  "events_page",
  "events"
] as const;

const jsonColumns: Record<string, readonly string[]> = {
  store_events: ["payload_json"],
  galaxy_page: ["features"],
  journal_about: ["features"],
  events_page: ["about", "stats", "series", "videos", "insights"]
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function count(client: PoolClient, table: string): Promise<number> {
  const result = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${quoteIdentifier(table)}`);
  return Number(result.rows[0].count);
}

async function insertRows(client: PoolClient, table: string, rows: QueryResultRow[]): Promise<void> {
  for (const row of rows) {
    const columns = Object.keys(row);
    const names = columns.map(quoteIdentifier).join(", ");
    const parameters = columns.map((_, index) => `$${index + 1}`).join(", ");
    const overriding = table === "pv_ibsi_journal_data" ? " OVERRIDING SYSTEM VALUE" : "";
    await client.query(
      `INSERT INTO ${quoteIdentifier(table)} (${names})${overriding} VALUES (${parameters})`,
      columns.map((column) => {
        const value = row[column];
        if (jsonColumns[table]?.includes(column) && value !== null && typeof value !== "string") {
          return JSON.stringify(value);
        }
        return value;
      })
    );
  }
}

async function resetSequences(client: PoolClient): Promise<void> {
  const result = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
        AND (column_default LIKE 'nextval(%' OR is_identity = 'YES')`,
    [tables]
  );
  for (const { table_name: table, column_name: column } of result.rows) {
    const relation = `public.${quoteIdentifier(table)}`;
    const sequence = await client.query<{ name: string | null }>(
      "SELECT pg_get_serial_sequence($1, $2) AS name",
      [relation, column]
    );
    if (!sequence.rows[0]?.name) continue;
    await client.query(
      `SELECT setval($1::regclass,
         COALESCE((SELECT max(${quoteIdentifier(column)}) FROM ${quoteIdentifier(table)}), 1),
         EXISTS (SELECT 1 FROM ${quoteIdentifier(table)}))`,
      [sequence.rows[0].name]
    );
  }
}

async function main(): Promise<void> {
  const targetPassword = process.env.TARGET_DATABASE_PASSWORD;
  if (!targetPassword) throw new Error("TARGET_DATABASE_PASSWORD is required");
  if (!process.argv.includes("--execute")) throw new Error("Pass --execute to confirm the Azure data import");

  const source = new Pool({ connectionString: config().DATABASE_URL, max: 1 });
  const target = new Pool({
    host: process.env.TARGET_DATABASE_HOST ?? "psql-ibsi-prod.postgres.database.azure.com",
    port: 5432,
    database: process.env.TARGET_DATABASE_NAME ?? "ibsi_app",
    user: process.env.TARGET_DATABASE_USER ?? "ibsiadmin",
    password: targetPassword,
    max: 1,
    ssl: { rejectUnauthorized: true }
  });
  const sourceClient = await source.connect();
  const targetClient = await target.connect();
  try {
    const targetActivity: number[] = [];
    for (const table of ["app_users", "subscriptions", "entitlements"]) {
      targetActivity.push(await count(targetClient, table));
    }
    if (targetActivity.some((value) => value !== 0)) {
      throw new Error("Azure already contains users, subscriptions, or entitlements; import refused");
    }

    await targetClient.query("BEGIN");
    try {
      await targetClient.query(`TRUNCATE ${tables.map(quoteIdentifier).join(", ")} RESTART IDENTITY CASCADE`);
      for (const table of tables) {
        const sourceRows = await sourceClient.query(`SELECT * FROM ${quoteIdentifier(table)}`);
        // Legacy databases allowed role to remain NULL. The current schema is
        // intentionally fail-closed and requires an explicit role; normalize
        // only missing values to the least-privileged role during migration.
        const rows = table === "app_users"
          ? sourceRows.rows.map((row) => ({ ...row, role: row.role ?? "user" }))
          : sourceRows.rows;
        await insertRows(targetClient, table, rows);
        const targetCount = await count(targetClient, table);
        if (targetCount !== sourceRows.rowCount) {
          throw new Error(`${table}: source=${sourceRows.rowCount}, target=${targetCount}`);
        }
        console.log(`${table}: ${targetCount}`);
      }
      await resetSequences(targetClient);
      await targetClient.query("COMMIT");
      console.log("Azure data import committed successfully");
    } catch (error) {
      await targetClient.query("ROLLBACK");
      throw error;
    }
  } finally {
    sourceClient.release();
    targetClient.release();
    await source.end();
    await target.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Data migration failed");
  process.exit(1);
});
