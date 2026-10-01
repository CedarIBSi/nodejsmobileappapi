import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { type JournalEdition, journalEditions } from "../lib/catalogue.js";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { type ArchiveAccess, resolveArchiveAccess } from "../lib/entitlement.js";
import { HttpError } from "../lib/errors.js";
import { journalLockReason } from "../lib/journal-archive.js";
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
  /**
   * The edition as the app's switcher names it. Filters by the same word
   * rule `journalEditionOf` locks by, so an issue can never be in a tab the
   * lock says is the other edition. `edition_type` remains the exact-string
   * filter for the free-text CMS value.
   */
  edition: z.enum(journalEditions).optional(),
  search: z.string().trim().min(1).max(200).optional()
});

/**
 * SQL for `journalEditionOf`: "india" wins when both words appear, as it
 * does in the classifier, so the two can never disagree about an issue.
 */
const editionSql: Record<JournalEdition, string> = {
  india: `edition_type ~* '\\mindia\\M'`,
  global: `edition_type ~* '\\mglobal\\M' AND edition_type !~* '\\mindia\\M'`
};
const journalParams = z.object({ journal_id: z.string().regex(/^[1-9]\d*$/) });
const viewParams = z.object({ token: z.string().min(20).max(2048) });

/**
 * Every journal endpoint needs the same answers: may this user be here at
 * all, which editions do they hold, and how far back does each reach.
 * Returning that rather than a boolean is what lets the listing mark
 * individual issues without a second lookup per row.
 */
async function requireJournalAccess(
  user: NonNullable<Express.Request["appUser"]>
): Promise<ArchiveAccess> {
  const access = await resolveArchiveAccess(user.id, user.role);
  if (!access.hasAccess) {
    throw new HttpError(402, "An active subscription is required", "SUBSCRIPTION_REQUIRED");
  }
  return access;
}

/** The window as the app shows it: full only when every held edition is full. */
function describeArchive(access: ArchiveAccess) {
  const held = Object.values(access.editions);
  const windowed = held.filter((edition) => !edition.fullArchive);
  return {
    editions: Object.keys(access.editions),
    full: windowed.length === 0,
    from_month: windowed
      .map((edition) => edition.archiveFromMonth)
      .filter((month): month is string => month !== null)
      .sort()[0] ?? null
  };
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
const filtersSchema = z.object({ edition: z.enum(journalEditions).optional() });

journalRouter.get("/filters", ...privateRoute, validate(filtersSchema, "query"), asyncHandler(async (req, res) => {
  await requireJournalAccess(req.appUser!);
  const { edition } = req.query as unknown as { edition?: JournalEdition };

  const published = "WHERE redirect_page IS NOT NULL AND btrim(redirect_page) <> ''";
  // The years of one edition when asked: the India edition began in 2024,
  // and a year picker offering 2019 under the India tab finds nothing.
  const yearScope = edition ? `AND (${editionSql[edition]})` : "";
  const [years, editions] = await Promise.all([
    query<{ year: string }>(
      `SELECT DISTINCT year FROM pv_ibsi_journal_data ${published}
       AND year IS NOT NULL AND btrim(year) <> '' ${yearScope}
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
  const access = await requireJournalAccess(req.appUser!);
  const { page, limit, year, edition_type: editionType, edition, search } = req.query as unknown as {
    page: number; limit: number; year?: number; edition_type?: string; edition?: JournalEdition; search?: string;
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
  if (edition) {
    filters.push(`(${editionSql[edition]})`);
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
    // Issues the reader cannot open stay in the listing, marked, rather than
    // being filtered out: a monthly subscriber scrolling a decade of locked
    // covers is the clearest argument for the annual plan there is, and an
    // India subscriber seeing the Global covers is the argument for the
    // bundle. `locked_reason` says which, so the app can send them to the
    // right one.
    journals: result.rows.map(({ redirect_page: _pdfFilename, ...journal }) => {
      const reason = journalLockReason(access, journal.edition_type, journal.month, journal.year);
      return {
        ...journal,
        image_url: journalImageUrl(journal.image_path),
        locked: reason !== null,
        locked_reason: reason
      };
    }),
    archive: describeArchive(access),
    pagination: pagination(page, limit, Number(count.rows[0]?.count ?? 0))
  });
}));

journalRouter.post("/:journal_id/view-link", ...privateRoute, validate(journalParams, "params"), asyncHandler(async (req, res) => {
  const access = await requireJournalAccess(req.appUser!);
  const journalId = req.params.journal_id as string;
  const result = await query<{
    journal_id: string;
    month: string | null;
    year: string | null;
    edition_type: string | null;
  }>(
    "SELECT journal_id, month, year, edition_type FROM pv_ibsi_journal_data WHERE journal_id = $1 AND redirect_page IS NOT NULL AND btrim(redirect_page) <> ''",
    [journalId]
  );
  const journal = result.rows[0];
  if (!journal) throw new HttpError(404, "Journal not found", "JOURNAL_NOT_FOUND");

  // Edition and archive window are both enforced here, at the point the
  // signed URL is minted, and not only in the listing above. The listing is
  // presentation; this is the grant. A client that skipped the list and
  // posted an id straight here would otherwise walk out with a working link
  // to an issue outside its plan.
  const reason = journalLockReason(access, journal.edition_type, journal.month, journal.year);
  if (reason === "edition") {
    throw new HttpError(
      403,
      "This edition is not included with your plan",
      "EDITION_UPGRADE_REQUIRED"
    );
  }
  if (reason === "archive") {
    throw new HttpError(
      403,
      "This edition is included with the annual plan",
      "ARCHIVE_UPGRADE_REQUIRED"
    );
  }

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
