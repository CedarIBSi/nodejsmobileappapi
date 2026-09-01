import fs from "node:fs/promises";
import { parseGalaxyFeatures, parseGalaxyIntro } from "../lib/galaxy-content.js";
import { pool } from "./pool.js";

/**
 * Loads Galaxy screen content into Postgres from files captured separately
 * (via curl.exe or a browser - Node's own fetch is blocked by Cloudflare bot
 * protection here regardless of source IP, see WORDPRESS_BYPASS_HEADER in
 * config.ts). Re-run this whenever the website's Galaxy page copy changes.
 *
 * Usage: npm run seed:galaxy -- <wp-page.json> <wp-page.html>
 *   wp-page.json: response of GET /wp-json/wp/v2/pages?slug=ibsi-galaxy&_fields=title,content
 *   wp-page.html: the rendered page, e.g. `curl https://ibsintelligence.com/ibsi-galaxy/`
 */
async function main() {
  const [jsonPath, htmlPath] = process.argv.slice(2);
  if (!jsonPath || !htmlPath) {
    console.error("Usage: npm run seed:galaxy -- <wp-page.json> <wp-page.html>");
    process.exit(1);
  }

  const pageJson = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  const page = Array.isArray(pageJson) ? pageJson[0] : pageJson;
  if (!page) {
    throw new Error("No page object found in the JSON input");
  }

  const { body, title } = parseGalaxyIntro(page);
  const features = parseGalaxyFeatures(await fs.readFile(htmlPath, "utf8"));

  const client = await pool().connect();
  try {
    await client.query(
      `INSERT INTO galaxy_page (id, title, body, features, updated_at)
       VALUES (1, $1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE
       SET title = EXCLUDED.title, body = EXCLUDED.body, features = EXCLUDED.features, updated_at = now()`,
      [title, body, JSON.stringify(features)]
    );
    console.log(`Seeded galaxy_page: "${title}", ${features.length} feature(s)`);
  } finally {
    client.release();
    await pool().end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Seed failed");
  process.exit(1);
});
