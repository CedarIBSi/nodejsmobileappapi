import fs from "node:fs/promises";
import { parseJournalAboutEdition } from "../lib/journal-about-content.js";
import { pool } from "./pool.js";

async function main() {
  const [globalHtmlPath, indiaHtmlPath] = process.argv.slice(2);
  if (!globalHtmlPath || !indiaHtmlPath) {
    console.error("Usage: npm run seed:journal-about -- <global-journal.html> <india-journal.html>");
    process.exit(1);
  }

  const editions: Array<{ edition: "global" | "india"; htmlPath: string }> = [
    { edition: "global", htmlPath: globalHtmlPath },
    { edition: "india", htmlPath: indiaHtmlPath }
  ];

  const client = await pool().connect();
  try {
    for (const { edition, htmlPath } of editions) {
      const { body, features, title } = parseJournalAboutEdition(await fs.readFile(htmlPath, "utf8"));
      await client.query(
        `INSERT INTO journal_about (edition, title, body, features, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (edition) DO UPDATE
         SET title = EXCLUDED.title, body = EXCLUDED.body, features = EXCLUDED.features, updated_at = now()`,
        [edition, title, body, JSON.stringify(features)]
      );
      console.log(`Seeded journal_about[${edition}]: ${features.length} feature(s), ${body.length} body chars`);
    }
  } finally {
    client.release();
    await pool().end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Seed failed");
  process.exit(1);
});
