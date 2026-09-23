import { query } from "../db/pool.js";

export type FintechLabStat = { label: string; value: string };
export type FintechLabBenefit = { bullets: string[]; title: string };

export type FintechLabContent = {
  benefits: FintechLabBenefit[];
  stats: FintechLabStat[];
  story: string;
  title: string;
};

type FintechLabRow = {
  benefits: unknown;
  stats: unknown;
  story: string;
  title: string;
};

/**
 * Cedar-IBSi FinTech Lab copy, read from Postgres. Loaded by
 * migrations/021_fintech_lab_page.sql rather than a seeder: the source is
 * cedaribsifintechlab.com, not the WordPress install the galaxy and awards
 * seeders read, so there is nothing to re-scrape. Returns null before that
 * migration has run, which the route turns into a 503 rather than an empty
 * page.
 */
export async function getFintechLabPage(): Promise<FintechLabContent | null> {
  const result = await query<FintechLabRow>(
    "SELECT title, story, stats, benefits FROM fintech_lab_page WHERE id = 1"
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    benefits: Array.isArray(row.benefits) ? (row.benefits as FintechLabBenefit[]) : [],
    stats: Array.isArray(row.stats) ? (row.stats as FintechLabStat[]) : [],
    story: row.story,
    title: row.title
  };
}
