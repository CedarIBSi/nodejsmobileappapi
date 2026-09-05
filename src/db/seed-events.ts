import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, transaction } from "./pool.js";

type SeedEvent = {
  city?: string;
  dateLabel?: string;
  featured?: boolean;
  id: string;
  imageUrl?: string | null;
  registrationEmail?: string | null;
  startsOn?: string | null;
  summary?: string;
  title: string;
  venue?: string | null;
};

type SeedFile = {
  about?: unknown;
  insights?: unknown;
  intro?: string;
  series?: unknown;
  stats?: unknown;
  upcoming?: SeedEvent[];
  videos?: unknown;
};

const defaultSeedPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../seed-data/events.json"
);

/**
 * Loads the Cedar-IBSi events programme into Postgres.
 *
 * Unlike the galaxy and awards seeders there is nothing to capture first:
 * cedaribsi.events is a hand-authored static site with no CMS behind it, so
 * seed-data/events.json *is* the source of truth. Edit that file and re-run
 * this whenever the calendar changes - a new summit, a new featured event, a
 * new set of recordings.
 *
 * Events are reconciled, not appended: an event dropped from the file is
 * deleted here too, so the file always describes the whole programme. Past
 * events do not need removing - the API stops returning an event the day
 * after `startsOn`.
 *
 * Usage: npm run seed:events [-- <events.json>]
 */
async function main() {
  const [suppliedPath] = process.argv.slice(2);
  const seedPath = suppliedPath ? path.resolve(suppliedPath) : defaultSeedPath;
  const seed = JSON.parse(await fs.readFile(seedPath, "utf8")) as SeedFile;
  const upcoming = seed.upcoming ?? [];

  const missing = upcoming.filter((event) => !event.id || !event.title);
  if (missing.length) {
    throw new Error(`${missing.length} event(s) in ${seedPath} have no id or no title`);
  }

  try {
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO events_page (id, intro, about, stats, series, videos, insights, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (id) DO UPDATE
         SET intro = EXCLUDED.intro, about = EXCLUDED.about, stats = EXCLUDED.stats,
             series = EXCLUDED.series, videos = EXCLUDED.videos,
             insights = EXCLUDED.insights, updated_at = now()`,
        [
          seed.intro ?? "",
          JSON.stringify(seed.about ?? {}),
          JSON.stringify(seed.stats ?? []),
          JSON.stringify(seed.series ?? []),
          JSON.stringify(seed.videos ?? []),
          JSON.stringify(seed.insights ?? [])
        ]
      );

      for (const [index, event] of upcoming.entries()) {
        await client.query(
          `INSERT INTO events (id, title, summary, date_label, starts_on, city, venue,
                               image_url, is_featured, registration_email, is_published,
                               sort_order, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, now())
           ON CONFLICT (id) DO UPDATE
           SET title = EXCLUDED.title, summary = EXCLUDED.summary,
               date_label = EXCLUDED.date_label, starts_on = EXCLUDED.starts_on,
               city = EXCLUDED.city, venue = EXCLUDED.venue,
               image_url = EXCLUDED.image_url, is_featured = EXCLUDED.is_featured,
               registration_email = EXCLUDED.registration_email,
               is_published = EXCLUDED.is_published, sort_order = EXCLUDED.sort_order,
               updated_at = now()`,
          [
            event.id,
            event.title,
            event.summary ?? "",
            event.dateLabel ?? "",
            event.startsOn ?? null,
            event.city ?? "",
            event.venue ?? null,
            event.imageUrl ?? null,
            event.featured === true,
            event.registrationEmail ?? null,
            index
          ]
        );
      }

      const removed = await client.query(
        "DELETE FROM events WHERE NOT (id = ANY($1::text[])) RETURNING id",
        [upcoming.map((event) => event.id)]
      );

      console.log(
        `Seeded events: ${upcoming.length} event(s), ${removed.rowCount ?? 0} removed, ` +
          `page content from ${path.basename(seedPath)}`
      );
    });
  } finally {
    await pool().end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Seed failed");
  process.exit(1);
});
