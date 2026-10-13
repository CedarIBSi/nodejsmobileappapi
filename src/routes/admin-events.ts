import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { query, transaction } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { isAdminRole } from "../lib/entitlement.js";
import { HttpError } from "../lib/errors.js";
import { privateRoute } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

/**
 * The events console: what the Events screen shows, edited in the browser.
 *
 * Until 2026-10-13 the only way to change a summit was to edit
 * seed-data/events.json and re-run the seeder against production. This
 * router edits the same two tables (events, events_page from migration 014)
 * directly, so the public GET /v1/events - and the app - sees a change
 * within its five-minute cache. The seeder now refuses to run without
 * --force, so it cannot quietly undo what was done here.
 *
 * Admin only, like the push console: every route verifies the Firebase ID
 * token and the admin role. There is no updated_by on these tables; the
 * change is logged with the admin's user id instead.
 */
export const adminEventsRouter = Router();

const adminOnly: RequestHandler = (req, _res, next) => {
  if (!isAdminRole(req.appUser?.role)) return next(new HttpError(403, "Admin role required", "FORBIDDEN"));
  next();
};
const secured = [...privateRoute, adminOnly];

/** Lower-case words joined by single hyphens: the ids the seed file used. */
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lower-case letters, digits and hyphens only").max(120);
const httpsUrl = z.url().refine((url) => url.startsWith("https://"), "HTTPS URL required");
const line = (max: number) => z.string().trim().min(1).max(max);

const eventSchema = z.object({
  id: slug,
  title: line(200),
  summary: z.string().trim().max(1000).default(""),
  date_label: z.string().trim().max(80).default(""),
  starts_on: z.iso.date().nullable().default(null),
  city: z.string().trim().max(120).default(""),
  venue: z.string().trim().max(200).nullable().default(null),
  image_url: httpsUrl.nullable().default(null),
  is_featured: z.boolean().default(false),
  registration_email: z.email().nullable().default(null),
  is_published: z.boolean().default(true),
  sort_order: z.number().int().min(-1000).max(1000).default(0)
});
const eventUpdateSchema = eventSchema.omit({ id: true }).partial().strict();
const eventParams = z.object({ id: slug });

const statSchema = z.object({ label: line(80), value: line(40) });
const seriesSchema = z.object({
  key: slug,
  title: line(120),
  body: z.string().trim().max(600).default(""),
  items: z.array(line(200)).max(20).default([])
});
const videoSchema = z.object({
  id: slug,
  title: line(200),
  youtubeId: z.string().regex(/^[A-Za-z0-9_-]{11}$/, "An 11-character YouTube video id"),
  thumbnailUrl: httpsUrl.nullable().default(null),
  dateLabel: z.string().trim().max(40).nullable().default(null)
});
const insightSchema = z.object({
  id: slug,
  title: line(200),
  topic: z.string().trim().max(80).nullable().default(null),
  summary: z.string().trim().max(600).default("")
});
const aboutSchema = z.object({
  heading: z.string().trim().max(120).default(""),
  body: z.array(line(1000)).max(10).default([]),
  points: z.array(line(200)).max(10).default([])
});
const pageSchema = z
  .object({
    intro: z.string().trim().max(4000),
    intro_points: z.array(line(200)).max(12),
    about: aboutSchema,
    stats: z.array(statSchema).max(12),
    series: z.array(seriesSchema).max(12),
    videos: z.array(videoSchema).max(20),
    insights: z.array(insightSchema).max(20)
  })
  .partial()
  .strict();

type EventRow = {
  id: string;
  title: string;
  summary: string;
  date_label: string;
  starts_on: string | null;
  city: string;
  venue: string | null;
  image_url: string | null;
  is_featured: boolean;
  registration_email: string | null;
  is_published: boolean;
  sort_order: number;
  updated_at: string;
};

type PageRow = {
  intro: string;
  intro_points: unknown;
  about: unknown;
  stats: unknown;
  series: unknown;
  videos: unknown;
  insights: unknown;
  updated_at: string;
};

const eventColumns = `id, title, summary, date_label, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
  city, venue, image_url, is_featured, registration_email, is_published, sort_order, updated_at`;

/** Same order as the app shows, with the past and the unpublished after. */
const listSql = `
  SELECT ${eventColumns}
  FROM events
  ORDER BY (is_published AND (starts_on IS NULL OR starts_on >= CURRENT_DATE)) DESC,
           is_featured DESC, sort_order, starts_on NULLS LAST, id
`;

/** The page row as the console edits it: every jsonb column in its proper shape, however the row was written. */
function normalisePage(row: PageRow | undefined) {
  const about = row?.about && typeof row.about === "object" ? (row.about as Record<string, unknown>) : {};
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  return {
    about: {
      body: list(about.body),
      heading: typeof about.heading === "string" ? about.heading : "",
      points: list(about.points)
    },
    insights: list(row?.insights),
    intro: row?.intro ?? "",
    intro_points: list(row?.intro_points),
    series: list(row?.series),
    stats: list(row?.stats),
    updated_at: row?.updated_at ?? null,
    videos: list(row?.videos)
  };
}

adminEventsRouter.get("/", ...secured, asyncHandler(async (_req, res) => {
  const [events, page] = await Promise.all([
    query<EventRow>(listSql),
    query<PageRow>("SELECT intro, intro_points, about, stats, series, videos, insights, updated_at FROM events_page WHERE id = 1")
  ]);
  res.set("Cache-Control", "no-store");
  res.json({
    events: events.rows,
    page: normalisePage(page.rows[0]),
    today: new Date().toISOString().slice(0, 10)
  });
}));

/**
 * Partial update of the page document: send only the sections that changed.
 * Each section is validated whole, so a half-formed series entry is refused
 * rather than stored for the app to trip over.
 */
adminEventsRouter.put("/page", ...secured, validate(pageSchema), asyncHandler(async (req, res) => {
  const changes = Object.entries(req.body as Record<string, unknown>);
  if (changes.length === 0) throw new HttpError(400, "Nothing to update", "VALIDATION_ERROR");

  const assignments = changes.map(([column], index) =>
    column === "intro" ? `${column} = $${index + 1}` : `${column} = $${index + 1}::jsonb`
  );
  const values = changes.map(([column, value]) => (column === "intro" ? value : JSON.stringify(value)));

  const result = await query<PageRow>(
    `INSERT INTO events_page (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`
  ).then(() =>
    query<PageRow>(
      `UPDATE events_page SET ${assignments.join(", ")}, updated_at = now()
        WHERE id = 1
        RETURNING intro, intro_points, about, stats, series, videos, insights, updated_at`,
      values
    )
  );
  req.log.info({ adminId: req.appUser!.id, sections: changes.map(([column]) => column) }, "events page updated");
  res.json({ page: normalisePage(result.rows[0]) });
}));

/** One featured event at a time: the app has one featured slot. */
async function clearOtherFeatured(exceptId: string): Promise<void> {
  await query("UPDATE events SET is_featured = false, updated_at = now() WHERE is_featured AND id <> $1", [exceptId]);
}

adminEventsRouter.post("/events", ...secured, validate(eventSchema), asyncHandler(async (req, res) => {
  const event = req.body as z.infer<typeof eventSchema>;
  const existing = await query("SELECT 1 FROM events WHERE id = $1", [event.id]);
  if (existing.rowCount) throw new HttpError(409, `An event with id "${event.id}" already exists`, "EVENT_EXISTS");

  const result = await transaction(async (client) => {
    if (event.is_featured) {
      await client.query("UPDATE events SET is_featured = false, updated_at = now() WHERE is_featured");
    }
    return client.query<EventRow>(
      `INSERT INTO events (id, title, summary, date_label, starts_on, city, venue, image_url,
                           is_featured, registration_email, is_published, sort_order, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       RETURNING ${eventColumns}`,
      [
        event.id, event.title, event.summary, event.date_label, event.starts_on, event.city, event.venue,
        event.image_url, event.is_featured, event.registration_email, event.is_published, event.sort_order
      ]
    );
  });
  req.log.info({ adminId: req.appUser!.id, eventId: event.id }, "event created");
  res.status(201).json({ event: result.rows[0] });
}));

adminEventsRouter.put(
  "/events/:id",
  ...secured,
  validate(eventParams, "params"),
  validate(eventUpdateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    const changes = Object.entries(req.body as Record<string, unknown>);
    if (changes.length === 0) throw new HttpError(400, "Nothing to update", "VALIDATION_ERROR");

    const assignments = changes.map(([column], index) => `${column} = $${index + 1}`);
    const values = changes.map(([, value]) => value);
    values.push(id);

    if (req.body.is_featured === true) await clearOtherFeatured(id);
    const result = await query<EventRow>(
      `UPDATE events SET ${assignments.join(", ")}, updated_at = now()
        WHERE id = $${values.length}
        RETURNING ${eventColumns}`,
      values
    );
    if (!result.rows[0]) throw new HttpError(404, "Event not found", "EVENT_NOT_FOUND");
    req.log.info({ adminId: req.appUser!.id, eventId: id, fields: changes.map(([column]) => column) }, "event updated");
    res.json({ event: result.rows[0] });
  })
);

adminEventsRouter.delete("/events/:id", ...secured, validate(eventParams, "params"), asyncHandler(async (req, res) => {
  const { id } = req.params as { id: string };
  const result = await query("DELETE FROM events WHERE id = $1", [id]);
  if (!result.rowCount) throw new HttpError(404, "Event not found", "EVENT_NOT_FOUND");
  req.log.info({ adminId: req.appUser!.id, eventId: id }, "event deleted");
  res.status(204).send();
}));
