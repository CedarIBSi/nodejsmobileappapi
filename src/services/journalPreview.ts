import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { config } from "../config.js";

/**
 * The free preview of a journal issue: a PDF holding only its opening pages.
 *
 * Built here, on the server, and never by the app clipping a full file. A
 * preview the app enforced would still hand the whole issue to the device,
 * where a signed link or a cached download is one file-manager away from a
 * reader who has not subscribed - the same hole the signed links closed.
 *
 * Previews are written once per issue (per page count and source version)
 * under the OS temp directory and served from there afterwards. An App
 * Service restart empties it and the next request rebuilds. The source PDF
 * is loaded whole for the copy, which is the only way pdf-lib works; a
 * journal issue is tens of megabytes at most and this runs once per issue.
 */

const previewDir = path.join(os.tmpdir(), "ibsi-journal-previews");
const inFlight = new Map<string, Promise<string>>();

/** How many pages the preview holds, or 0 when previews are switched off. */
export function journalPreviewPageCount(): number {
  return config().JOURNAL_PREVIEW_PAGES;
}

async function writePreview(sourcePath: string, target: string, pages: number): Promise<void> {
  const bytes = await fs.promises.readFile(sourcePath);
  // Journal PDFs from the publisher are sometimes owner-password protected
  // against editing; that protection is not meant to stop reading the first
  // pages, and the full file is served as-is anyway.
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const count = Math.min(pages, source.getPageCount());
  const preview = await PDFDocument.create();
  const copied = await preview.copyPages(source, Array.from({ length: count }, (_, index) => index));
  for (const page of copied) preview.addPage(page);
  const title = source.getTitle();
  if (title) preview.setTitle(`${title} (preview)`);

  await fs.promises.mkdir(previewDir, { recursive: true });
  // Written beside the target and renamed into place, so a request that
  // arrives mid-write never streams a half-written file.
  const partial = `${target}.${process.pid}.${Date.now()}.part`;
  await fs.promises.writeFile(partial, await preview.save({ useObjectStreams: true }));
  await fs.promises.rename(partial, target);
}

/**
 * The path of the preview file for `sourcePath`, building it on first use.
 *
 * The cache key carries the source file's size and modification time: when
 * the publisher replaces an issue's PDF the next preview request sees a new
 * key, builds afresh, and the stale preview is left to the temp directory.
 */
export async function journalPreviewFile(
  journalId: string,
  sourcePath: string,
  pages: number
): Promise<string> {
  const stat = await fs.promises.stat(sourcePath);
  const target = path.join(
    previewDir,
    `${journalId}-p${pages}-${stat.size}-${Math.floor(stat.mtimeMs)}.pdf`
  );

  try {
    await fs.promises.access(target, fs.constants.R_OK);
    return target;
  } catch {
    // Not built yet.
  }

  const pending = inFlight.get(target);
  if (pending) return pending;

  const build = writePreview(sourcePath, target, pages)
    .then(() => target)
    .finally(() => inFlight.delete(target));
  inFlight.set(target, build);
  return build;
}
