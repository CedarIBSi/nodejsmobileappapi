import { query } from "../db/pool.js";
import { JournalAboutEdition, JournalAboutFeature } from "../lib/journal-about-content.js";

type JournalAboutRow = { body: string; edition: string; features: unknown; title: string };

export type JournalAboutEditions = { global: JournalAboutEdition | null; india: JournalAboutEdition | null };

export async function getJournalAbout(): Promise<JournalAboutEditions> {
  const result = await query<JournalAboutRow>(
    "SELECT edition, title, body, features FROM journal_about WHERE edition IN ('global', 'india')"
  );

  const editions: JournalAboutEditions = { global: null, india: null };
  for (const row of result.rows) {
    const edition: JournalAboutEdition = {
      body: row.body,
      features: Array.isArray(row.features) ? (row.features as JournalAboutFeature[]) : [],
      title: row.title
    };
    if (row.edition === "global") editions.global = edition;
    if (row.edition === "india") editions.india = edition;
  }
  return editions;
}
