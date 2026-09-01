import fs from "node:fs/promises";
import path from "node:path";
import {
  AwardProgram,
  parseAwardProgramFromAccordionHtml,
  parseAwardProgramFromHtml,
  parseAwardProgramFromRest
} from "../lib/awards-content.js";
import { pool } from "./pool.js";

/**
 * Order also becomes each row's sort_order, so the app screen lists
 * programmes in this order regardless of insert order.
 */
const slugOrder = [
  "ibsi-global-fintech-innovation-awards",
  "ibsi-digital-banking-awards",
  "ibsi-annual-middle-east-banking-excellence-awards-2026",
  "sales-league-table"
];

/**
 * Only consulted when a slug's REST content comes back empty. Each of these
 * pages is built from a different custom PHP template, so each needs its own
 * scrape shape - see the corresponding parse function in awards-content.ts.
 */
const htmlFallbackParsers: Record<
  string,
  (html: string, link: string, slug: string, title: string) => AwardProgram
> = {
  "ibsi-global-fintech-innovation-awards": parseAwardProgramFromHtml,
  "sales-league-table": parseAwardProgramFromAccordionHtml
};

async function readJsonIfExists(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Loads award-programme content into Postgres from files captured
 * separately (via curl.exe or a browser - Node's own fetch is blocked by
 * Cloudflare bot protection here regardless of source IP, see
 * WORDPRESS_BYPASS_HEADER in config.ts). Re-run whenever a programme page's
 * copy changes, or a new award season replaces one of the slugs above.
 *
 * For each slug in slugOrder, expects a file named "<slug>.json" in the
 * given directory - the response of
 *   GET /wp-json/wp/v2/pages?slug=<slug>&_fields=title,content,link
 * and, only for a page whose content field comes back empty (currently GFIA
 * and Sales League Table - see htmlFallbackParsers), a matching "<slug>.html"
 * - the rendered page, e.g. `curl https://ibsintelligence.com/<slug>/`.
 *
 * Usage: npm run seed:awards -- <dir-of-captured-files>
 */
async function main() {
  const [dir] = process.argv.slice(2);
  if (!dir) {
    console.error("Usage: npm run seed:awards -- <dir-of-captured-files>");
    process.exit(1);
  }

  const client = await pool().connect();
  try {
    for (const [index, slug] of slugOrder.entries()) {
      const pageJson = await readJsonIfExists(path.join(dir, `${slug}.json`));
      const page = Array.isArray(pageJson) ? pageJson[0] : pageJson;

      if (!page) {
        console.warn(`Skipping ${slug}: no ${slug}.json found in ${dir}`);
        continue;
      }

      let program: AwardProgram | null = parseAwardProgramFromRest(page, slug);

      if (!program) {
        console.warn(`Skipping ${slug}: ${slug}.json had no page link`);
        continue;
      }

      const parseHtml = htmlFallbackParsers[slug];
      if (!program.body && parseHtml) {
        const html = await readTextIfExists(path.join(dir, `${slug}.html`));
        if (html) {
          program = parseHtml(html, program.link, slug, program.title);
        }
      }

      await client.query(
        `INSERT INTO award_programs (slug, title, body, link, winners_link, sort_order, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (slug) DO UPDATE
         SET title = EXCLUDED.title, body = EXCLUDED.body, link = EXCLUDED.link,
             winners_link = EXCLUDED.winners_link, sort_order = EXCLUDED.sort_order, updated_at = now()`,
        [program.slug, program.title, program.body, program.link, program.winnersLink, index]
      );

      console.log(
        `Seeded award_programs[${slug}]: ${program.body.length} body chars, winners=${program.winnersLink ?? "none"}`
      );
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
