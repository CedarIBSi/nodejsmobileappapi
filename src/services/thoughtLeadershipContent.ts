import { query } from "../db/pool.js";

export type ThoughtLeadershipContent = {
  body: string;
  intro: string;
  portfolio: string[];
  title: string;
};

type ThoughtLeadershipRow = {
  body: string;
  intro: string;
  portfolio: unknown;
  title: string;
};

/**
 * Thought Leadership copy, read from Postgres. Loaded by
 * migrations/024_thought_leadership_page.sql; returns null before that has
 * run, which the route turns into a 503 rather than an empty page.
 */
export async function getThoughtLeadershipPage(): Promise<ThoughtLeadershipContent | null> {
  const result = await query<ThoughtLeadershipRow>(
    "SELECT title, intro, portfolio, body FROM thought_leadership_page WHERE id = 1"
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    body: row.body ?? "",
    intro: row.intro,
    portfolio: Array.isArray(row.portfolio) ? (row.portfolio as string[]) : [],
    title: row.title
  };
}
