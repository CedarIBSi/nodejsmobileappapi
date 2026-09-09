import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { toSingleLine } from "../lib/html-text.js";
import { pagination, paginationSchema } from "../lib/pagination.js";
import {
  anonymousReaderId,
  createWhitepaperToken,
  verifyWhitepaperToken
} from "../lib/whitepaper-token.js";
import { resolveOptionalUser } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

export const whitepaperRouter = Router();

type WhitepaperRow = {
  sr_no: number;
  title: string | null;
  teaser: string | null;
  search_tag: string | null;
  image_path: string | null;
  redirect_page: string | null;
  year: number | null;
  published_date: string | null;
  category: string | null;
};

/**
 * A paper is servable only when the CMS has marked it live and a PDF filename
 * is recorded. live_status is free text, so it is trimmed and case folded: the
 * current rows read 'Live', and a stray 'live' should not retire a paper.
 * Legacy rows predate the column and hold NULL, which counts as not live.
 * Kept as one fragment so the list and the viewer can never disagree about
 * which papers exist.
 */
const servableFilter = `lower(btrim(live_status)) = 'live'
  AND redirect_page IS NOT NULL AND btrim(redirect_page) <> ''`;

const listSchema = paginationSchema.extend({
  year: z.coerce.number().int().min(1900).max(2200).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  search: z.string().trim().min(1).max(200).optional()
});
const whitepaperParams = z.object({ whitepaper_id: z.string().regex(/^[1-9]\d*$/) });
const viewParams = z.object({ token: z.string().min(20).max(2048) });

function whitepaperImageUrl(imagePath: string | null): string | null {
  const filename = imagePath?.trim();
  if (!filename || path.basename(filename) !== filename) return null;
  const baseUrl = config().WHITEPAPER_IMAGE_BASE_URL.endsWith("/")
    ? config().WHITEPAPER_IMAGE_BASE_URL
    : `${config().WHITEPAPER_IMAGE_BASE_URL}/`;
  return new URL(encodeURIComponent(filename), baseUrl).toString();
}

/**
 * Resolves the on-disk PDF. Every paper sits directly in WHITEPAPER_STORAGE_DIR
 * regardless of category, so `category` is a listing facet only and never
 * reaches the filesystem - which is what keeps the `?category=../research-reports`
 * traversal in the website's whitepaper.jsp from having an equivalent here.
 * The filename must be a bare `.pdf` name exactly as stored, and the resolved
 * path must land directly in the root.
 */
function resolveWhitepaperPath(filename: string): string {
  if (path.basename(filename) !== filename || path.extname(filename).toLowerCase() !== ".pdf") {
    throw new HttpError(500, "Invalid white paper file configuration", "INVALID_WHITEPAPER_FILE");
  }
  const storageRoot = path.resolve(config().WHITEPAPER_STORAGE_DIR);
  const filePath = path.resolve(storageRoot, filename);
  if (path.dirname(filePath).toLowerCase() !== storageRoot.toLowerCase()) {
    throw new HttpError(500, "Invalid white paper file configuration", "INVALID_WHITEPAPER_FILE");
  }
  return filePath;
}

/**
 * White papers are free. The listing and the view-link mint used to sit behind
 * privateRoute plus an entitlement check; both are gone, so a caller with no
 * account reads the same library.
 *
 * resolveOptionalUser stays so a signed-in reader is still identified - it is
 * what stamps the view token below - but nothing here requires it to resolve.
 */
whitepaperRouter.get("/", resolveOptionalUser, validate(listSchema, "query"), asyncHandler(async (req, res) => {
  const { page, limit, year, category, search } = req.query as unknown as {
    page: number; limit: number; year?: number; category?: string; search?: string;
  };
  const filters: string[] = [servableFilter];
  const values: unknown[] = [];
  if (year !== undefined) {
    values.push(year);
    filters.push(`year = $${values.length}`);
  }
  if (category) {
    values.push(category);
    filters.push(`lower(btrim(category)) = lower(btrim($${values.length}))`);
  }
  if (search) {
    values.push(`%${search}%`);
    filters.push(`(title ILIKE $${values.length} OR teaser ILIKE $${values.length} OR search_tag ILIKE $${values.length})`);
  }
  const where = `WHERE ${filters.join(" AND ")}`;
  const count = await query<{ count: string }>(`SELECT count(*) FROM db_white_paper_data ${where}`, values);
  values.push(limit, (page - 1) * limit);
  const result = await query<WhitepaperRow>(
    `SELECT sr_no, title, teaser, search_tag, image_path, redirect_page,
            year, published_date, category
     FROM db_white_paper_data ${where}
     -- published_date is text but every row holds an ISO YYYY-MM-DD value, so
     -- it sorts chronologically as-is. Comparing as text rather than casting
     -- means one malformed entry cannot make the whole listing fail.
     ORDER BY published_date DESC NULLS LAST, sr_no DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  res.set("Cache-Control", "private, no-store");
  res.json({
    whitepapers: result.rows.map(({ redirect_page: _pdfFilename, ...whitepaper }) => ({
      ...whitepaper,
      title: toSingleLine(whitepaper.title),
      teaser: toSingleLine(whitepaper.teaser),
      image_url: whitepaperImageUrl(whitepaper.image_path)
    })),
    pagination: pagination(page, limit, Number(count.rows[0]?.count ?? 0))
  });
}));

whitepaperRouter.post("/:whitepaper_id/view-link", resolveOptionalUser, validate(whitepaperParams, "params"), asyncHandler(async (req, res) => {
  const whitepaperId = req.params.whitepaper_id as string;
  const result = await query<{ sr_no: number }>(
    `SELECT sr_no FROM db_white_paper_data WHERE sr_no = $1 AND ${servableFilter}`,
    [whitepaperId]
  );
  if (!result.rows[0]) throw new HttpError(404, "White paper not found", "WHITEPAPER_NOT_FOUND");

  // Signed-out readers are legitimate callers now, so the token records who
  // asked when that is known and a fixed placeholder when it is not. The id is
  // carried for attribution only - nothing downstream authorises against it.
  const { token, expiresAt } = createWhitepaperToken(
    whitepaperId,
    req.appUser?.id ?? anonymousReaderId
  );
  res.set("Cache-Control", "no-store");
  res.json({
    view_url: new URL(`/v1/whitepapers/view/${token}`, config().APP_BASE_URL).toString(),
    expires_at: expiresAt.toISOString(),
    expires_in_seconds: config().WHITEPAPER_URL_TTL_SECONDS
  });
}));

whitepaperRouter.get("/view/:token", validate(viewParams, "params"), asyncHandler(async (req, res) => {
  const { token } = req.params as { token: string };
  const { whitepaper_id: whitepaperId } = verifyWhitepaperToken(token);
  const result = await query<{ redirect_page: string }>(
    "SELECT redirect_page FROM db_white_paper_data WHERE sr_no = $1",
    [whitepaperId]
  );
  // Several rows store the filename with a trailing space, so trim before use.
  const filename = result.rows[0]?.redirect_page?.trim();
  if (!filename) throw new HttpError(404, "White paper not found", "WHITEPAPER_NOT_FOUND");

  const filePath = resolveWhitepaperPath(filename);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HttpError(404, "White paper PDF is not available", "WHITEPAPER_FILE_NOT_FOUND");
    }
    throw error;
  }
  if (!stat.isFile()) throw new HttpError(404, "White paper PDF is not available", "WHITEPAPER_FILE_NOT_FOUND");

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
