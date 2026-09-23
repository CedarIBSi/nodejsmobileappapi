import { query } from "../db/pool.js";

export type ResearchReportsContent = {
  body: string;
  deliverables: string[];
  intro: string;
  title: string;
};

type ResearchReportsRow = {
  body: string;
  deliverables: unknown;
  intro: string;
  title: string;
};

/**
 * Research Reports copy, read from Postgres. Loaded by
 * migrations/025_research_reports_page.sql; returns null before that has run,
 * which the route turns into a 503 rather than an empty page.
 */
export async function getResearchReportsPage(): Promise<ResearchReportsContent | null> {
  const result = await query<ResearchReportsRow>(
    "SELECT title, intro, deliverables, body FROM research_reports_page WHERE id = 1"
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    body: row.body ?? "",
    deliverables: Array.isArray(row.deliverables) ? (row.deliverables as string[]) : [],
    intro: row.intro,
    title: row.title
  };
}
