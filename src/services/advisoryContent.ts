import { query } from "../db/pool.js";

export type AdvisoryProgramme = { items: string[]; title: string };

export type AdvisoryContent = {
  intro: string;
  programmes: AdvisoryProgramme[];
  title: string;
};

type AdvisoryRow = { intro: string; programmes: unknown; title: string };

/**
 * Advisory Services copy, read from Postgres. Same arrangement as
 * fintech_lab_page: there is no scraper behind it, the content is loaded by
 * migrations/023_advisory_page.sql. Returns null before that has run, which
 * the route turns into a 503 rather than an empty page.
 */
export async function getAdvisoryPage(): Promise<AdvisoryContent | null> {
  const result = await query<AdvisoryRow>(
    "SELECT title, intro, programmes FROM advisory_page WHERE id = 1"
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    intro: row.intro,
    programmes: Array.isArray(row.programmes) ? (row.programmes as AdvisoryProgramme[]) : [],
    title: row.title
  };
}
