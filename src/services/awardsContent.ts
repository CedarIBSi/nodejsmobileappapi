import { query } from "../db/pool.js";
import { AwardProgram } from "../lib/awards-content.js";

type AwardProgramRow = {
  body: string;
  link: string;
  slug: string;
  title: string;
  winners_link: string | null;
};

/**
 * Award-programme copy for the app's Awards screen, read from Postgres
 * rather than WordPress: one of the three programme pages never populates
 * WordPress's REST content field (see lib/awards-content.ts), and this
 * server's own outbound requests to WordPress are unreliable behind
 * Cloudflare bot protection regardless (see galaxyContent.ts). Content is
 * captured from a client that isn't blocked and loaded via
 * `npm run seed:awards`.
 */
export async function getAwardPrograms(): Promise<AwardProgram[]> {
  const result = await query<AwardProgramRow>(
    "SELECT slug, title, body, link, winners_link FROM award_programs ORDER BY sort_order"
  );

  return result.rows.map((row) => ({
    body: row.body,
    link: row.link,
    slug: row.slug,
    title: row.title,
    winnersLink: row.winners_link
  }));
}
