import { Pool, PoolClient, QueryResultRow } from "pg";
import { config } from "../config.js";

let instance: Pool | undefined;

export function pool(): Pool {
  if (!instance) {
    instance = new Pool({
      connectionString: config().DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: config().DATABASE_SSL ? { rejectUnauthorized: false } : undefined
    });
  }
  return instance;
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  return pool().query<T>(text, values);
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
