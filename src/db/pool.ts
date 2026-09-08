import { Pool, PoolClient, QueryResultRow } from "pg";
import { config } from "../config.js";

let instance: Pool | undefined;

export function pool(): Pool {
  if (!instance) {
    const env = config();
    const useTls = env.DATABASE_SSL || env.PGSSLMODE !== "disable";
    instance = new Pool({
      ...(env.DATABASE_URL
        ? { connectionString: env.DATABASE_URL }
        : {
            host: env.PGHOST,
            port: env.PGPORT,
            database: env.PGDATABASE,
            user: env.PGUSER,
            password: env.PGPASSWORD
          }),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // Azure PostgreSQL presents a publicly trusted certificate. Production
      // TLS must verify both the certificate chain and server hostname rather
      // than merely encrypting traffic without authenticating the server.
      ssl: useTls ? { rejectUnauthorized: true } : undefined
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
