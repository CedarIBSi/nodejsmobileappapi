import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { hasActiveEntitlement } from "../lib/entitlement.js";
import { HttpError } from "../lib/errors.js";
import { createJournalToken, verifyJournalToken } from "../lib/journal-token.js";
import { pagination, paginationSchema } from "../lib/pagination.js";
import { privateRoute } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { getJournalAbout } from "../services/journalAboutContent.js";

export const journalRouter = Router();
const journalAboutCacheSeconds = 300;

// Public: the "About the Journal" / "Why IBSi FinTech Journal" copy is
// marketing content, not gated archive content, so it does not go through
// privateRoute the way the listing below does.
journalRouter.get("/about", asyncHandler(async (_req, res) => {
  const editions = await getJournalAbout();
  res.set("Cache-Control", `public, max-age=${journalAboutCacheSeconds}`);
  res.json({ editions });
}));

type JournalRow = {
  journal_id: string;
  sr: number | null;
  title: string | null;
  issue_no: string | null;
  month: string | null;
  year: string | null;
  search_tag: string | null;
  image_path: string | null;
  redirect_page: string | null;
  published_date: string | null;
  edition_type: string | null;
};

const listSchema = paginationSchema.extend({
  year: z.coerce.number().int().min(1900).max(2200).optional(),
  edition_type: z.string().trim().min(1).max(100).optional(),
  search: z.string().trim().min(1).max(200).optional()
});
const journalParams = z.object({ journal_id: z.string().regex(/^[1-9]\d*$/) });
const viewParams = z.object({ token: z.string().min(20).max(2048) });

async function requireJournalAccess(user: NonNullable<Express.Request["appUser"]>) {
  if (!await hasActiveEntitlement(user.id, user.role)) {
    throw new HttpError(402, "An active subscription is required", "SUBSCRIPTION_REQUIRED");
  }
}

function journalImageUrl(imagePath: string | null): string | null {
  const filename = imagePath?.trim();
  if (!filename || path.basename(filename) !== filename) return null;
  const baseUrl = config().JOURNAL_IMAGE_BASE_URL.endsWith("/")
    ? config().JOURNAL_IMAGE_BASE_URL
    : `${config().JOURNAL_IMAGE_BASE_URL}/`;
  return new URL(encodeURIComponent(filename), baseUrl).toString();
}

/**
 * The years and edition types that actually exist, so the app can offer the
 * whole archive as filters. The app previously learned its options from the
 * rows it had already paged through, which meant a reader could not filter to
 * 2019 until they had scrolled back to 2019.
 *
 * Same access rule as the listing: this describes gated content.
 */
journalRouter.get("/filters", ...privateRoute, asyncHandler(async (req, res) => {
  await requireJournalAccess(req.appUser!);

  const published = "WHERE redirect_page IS NOT NULL AND btrim(redirect_page) <> ''";
  const [years, editions] = await Promise.all([
    query<{ year: string }>(
      `SELECT DISTINCT year FROM pv_ibsi_journal_data ${published}
       AND year IS NOT NULL AND btrim(year) <> ''
       ORDER BY year DESC`
    ),
    query<{ edition_type: string }>(
      `SELECT DISTINCT edition_type FROM pv_ibsi_journal_data ${published}
       AND edition_type IS NOT NULL AND btrim(edition_type) <> ''
       ORDER BY edition_type`
    )
  ]);

  res.set("Cache-Control", "private, max-age=300");
  res.json({
    editions: editions.rows.map((row) => row.edition_type),
    years: years.rows.map((row) => row.year)
  });
}));

journalRouter.get("/", ...privateRoute, validate(listSchema, "query"), asyncHandler(async (req, res) => {
  await requireJournalAccess(req.appUser!);
  const { page, limit, year, edition_type: editionType, search } = req.query as unknown as {
    page: number; limit: number; year?: number; edition_type?: string; search?: string;
  };
  const filters: string[] = ["redirect_page IS NOT NULL", "btrim(redirect_page) <> ''"];
  const values: unknown[] = [];
  if (year !== undefined) {
    values.push(String(year));
    filters.push(`year = $${values.length}`);
  }
  if (editionType) {
    values.push(editionType);
    filters.push(`edition_type = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    filters.push(`(title ILIKE $${values.length} OR issue_no ILIKE $${values.length} OR search_tag ILIKE $${values.length})`);
  }
  const where = `WHERE ${filters.join(" AND ")}`;
  const count = await query<{ count: string }>(`SELECT count(*) FROM pv_ibsi_journal_data ${where}`, values);
  values.push(limit, (page - 1) * limit);
  const result = await query<JournalRow>(
    `SELECT journal_id, sr, title, issue_no, month, year, search_tag, image_path,
            redirect_page, published_date, edition_type
     FROM pv_ibsi_journal_data ${where}
     ORDER BY year::integer DESC,
       CASE lower(month)
         WHEN 'january' THEN 1 WHEN 'february' THEN 2 WHEN 'march' THEN 3
         WHEN 'april' THEN 4 WHEN 'may' THEN 5 WHEN 'june' THEN 6
         WHEN 'july' THEN 7 WHEN 'august' THEN 8 WHEN 'september' THEN 9
         WHEN 'october' THEN 10 WHEN 'november' THEN 11 WHEN 'december' THEN 12
         ELSE 0 END DESC,
       journal_id DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  res.set("Cache-Control", "private, no-store");
  res.json({
    journals: result.rows.map(({ redirect_page: _pdfFilename, ...journal }) => ({
      ...journal,
      image_url: journalImageUrl(journal.image_path)
    })),
    pagination: pagination(page, limit, Number(count.rows[0]?.count ?? 0))
  });
}));

journalRouter.post("/:journal_id/view-link", ...privateRoute, validate(journalParams, "params"), asyncHandler(async (req, res) => {
  await requireJournalAccess(req.appUser!);
  const journalId = req.params.journal_id as string;
  const result = await query<{ journal_id: string }>(
    "SELECT journal_id FROM pv_ibsi_journal_data WHERE journal_id = $1 AND redirect_page IS NOT NULL AND btrim(redirect_page) <> ''",
    [journalId]
  );
  if (!result.rows[0]) throw new HttpError(404, "Journal not found", "JOURNAL_NOT_FOUND");

  const { token, expiresAt } = createJournalToken(journalId, req.appUser!.id);
  res.set("Cache-Control", "no-store");
  res.json({
    view_url: new URL(`/v1/journals/view/${token}`, config().APP_BASE_URL).toString(),
    expires_at: expiresAt.toISOString(),
    expires_in_seconds: config().JOURNAL_URL_TTL_SECONDS
  });
}));

journalRouter.get("/view/:token", validate(viewParams, "params"), asyncHandler(async (req, res) => {
  const { token } = req.params as { token: string };
  const { journal_id: journalId } = verifyJournalToken(token);
  const result = await query<{ redirect_page: string }>(
    "SELECT redirect_page FROM pv_ibsi_journal_data WHERE journal_id = $1",
    [journalId]
  );
  const filename = result.rows[0]?.redirect_page?.trim();
  if (!filename) throw new HttpError(404, "Journal not found", "JOURNAL_NOT_FOUND");
  if (path.basename(filename) !== filename || path.extname(filename).toLowerCase() !== ".pdf") {
    throw new HttpError(500, "Invalid journal file configuration", "INVALID_JOURNAL_FILE");
  }

  const filePath = path.resolve(config().JOURNAL_STORAGE_DIR, filename);
  const storageRoot = path.resolve(config().JOURNAL_STORAGE_DIR);
  if (path.dirname(filePath).toLowerCase() !== storageRoot.toLowerCase()) {
    throw new HttpError(500, "Invalid journal file configuration", "INVALID_JOURNAL_FILE");
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HttpError(404, "Journal PDF is not available", "JOURNAL_FILE_NOT_FOUND");
    }
    throw error;
  }
  if (!stat.isFile()) throw new HttpError(404, "Journal PDF is not available", "JOURNAL_FILE_NOT_FOUND");

  res.set({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `inline; filename="${filename.replace(/["\\\r\n]/g, "_")}"`,
    "Content-Type": "application/pdf"
  });
  const range = req.header("range");
  if (!range) {
    res.set("Content-Length", String(stat.size));
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) {
    res.set("Content-Range", `bytes */${stat.size}`).status(416).end();
    return;
  }
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      res.set("Content-Range", `bytes */${stat.size}`).status(416).end();
      return;
    }
    start = Math.max(0, stat.size - suffixLength);
    end = stat.size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : stat.size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stat.size) {
    res.set("Content-Range", `bytes */${stat.size}`).status(416).end();
    return;
  }
  end = Math.min(end, stat.size - 1);
  res.status(206).set({
    "Content-Length": String(end - start + 1),
    "Content-Range": `bytes ${start}-${end}/${stat.size}`
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}));
