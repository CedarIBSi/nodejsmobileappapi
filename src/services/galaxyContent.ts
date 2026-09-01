import { query } from "../db/pool.js";
import { GalaxyContent, GalaxyFeature } from "../lib/galaxy-content.js";

type GalaxyRow = { body: string; features: unknown; title: string };

/**
 * Reads Galaxy screen copy from Postgres rather than WordPress: this
 * server's outbound requests to WordPress are blocked by Cloudflare bot
 * protection, unaffected by IP allowlisting (TLS fingerprinting). Content is
 * captured from a client that isn't blocked and loaded via
 * `npm run seed:galaxy`. Returns null when that has never been run.
 */
export async function getGalaxyPage(): Promise<GalaxyContent | null> {
  const result = await query<GalaxyRow>(
    "SELECT title, body, features FROM galaxy_page WHERE id = 1"
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    body: row.body,
    features: Array.isArray(row.features) ? (row.features as GalaxyFeature[]) : [],
    title: row.title
  };
}
