import { journalEditionOf, type JournalEdition } from "../lib/catalogue.js";
import { journalImageUrl } from "../lib/journal-image.js";
import { query } from "../db/pool.js";

/**
 * One journal issue as Home shows it: cover, title and when, never the PDF.
 * Public by design. A cover and a title sell the Journal to a reader without
 * a subscription; the issue itself still goes through the private listing
 * and the signed view link.
 */
export type LatestJournal = {
  edition: JournalEdition | null;
  edition_type: string | null;
  image_url: string | null;
  issue_no: string | null;
  journal_id: string;
  month: string | null;
  published_date: string | null;
  title: string | null;
  year: string | null;
};

type LatestJournalRow = {
  edition_type: string | null;
  image_path: string | null;
  issue_no: string | null;
  journal_id: string;
  month: string | null;
  published_date: string | null;
  title: string | null;
  year: string | null;
};

/** Same ordering as the archive listing, so "latest" means the same thing on both. */
const latestOrderSql = `ORDER BY year::integer DESC,
  CASE lower(month)
    WHEN 'january' THEN 1 WHEN 'february' THEN 2 WHEN 'march' THEN 3
    WHEN 'april' THEN 4 WHEN 'may' THEN 5 WHEN 'june' THEN 6
    WHEN 'july' THEN 7 WHEN 'august' THEN 8 WHEN 'september' THEN 9
    WHEN 'october' THEN 10 WHEN 'november' THEN 11 WHEN 'december' THEN 12
    ELSE 0 END DESC,
  journal_id DESC`;

/**
 * The newest issue of each edition, India then Global, from the same
 * published rows the archive lists. The edition is classified from the
 * free-text `edition_type` by the one rule the locks use, so an issue can
 * never be the latest of an edition the archive would file elsewhere.
 */
export async function listLatestJournals(): Promise<LatestJournal[]> {
  const result = await query<LatestJournalRow>(
    `SELECT journal_id, title, issue_no, month, year, image_path, published_date, edition_type
     FROM pv_ibsi_journal_data
     WHERE redirect_page IS NOT NULL AND btrim(redirect_page) <> ''
     ${latestOrderSql}
     LIMIT 40`
  );

  const latest = new Map<JournalEdition, LatestJournal>();
  for (const row of result.rows) {
    const edition = journalEditionOf(row.edition_type);
    if (!edition || latest.has(edition)) continue;
    latest.set(edition, {
      edition,
      edition_type: row.edition_type,
      image_url: journalImageUrl(row.image_path),
      issue_no: row.issue_no,
      journal_id: String(row.journal_id),
      month: row.month,
      published_date: row.published_date,
      title: row.title,
      year: row.year
    });
  }

  return (["india", "global"] as const).flatMap((edition) => {
    const issue = latest.get(edition);
    return issue ? [issue] : [];
  });
}
