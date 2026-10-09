import path from "node:path";
import { config } from "../config.js";

/**
 * The public URL of a journal cover from the bare filename the CMS stores.
 * Shared by the archive listing and the Home routes, so a cover resolves the
 * same way wherever it is drawn. A value that is not a bare filename is
 * refused rather than joined, which keeps a path in the column from reaching
 * the image host.
 */
export function journalImageUrl(imagePath: string | null): string | null {
  const filename = imagePath?.trim();
  if (!filename || path.basename(filename) !== filename) return null;
  const baseUrl = config().JOURNAL_IMAGE_BASE_URL.endsWith("/")
    ? config().JOURNAL_IMAGE_BASE_URL
    : `${config().JOURNAL_IMAGE_BASE_URL}/`;
  return new URL(encodeURIComponent(filename), baseUrl).toString();
}
