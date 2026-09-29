import { type JournalEdition, journalEditionOf } from "./catalogue.js";
import type { ArchiveAccess, EditionAccess } from "./entitlement.js";

/**
 * Which journal issues a subscriber may open.
 *
 * Two things can lock an issue: its edition is not on the reader's plan, or
 * it predates the window a monthly plan reaches back to. They are told apart
 * because the remedy differs - a different product for the first, the annual
 * plan for the second - and the app sends the reader to the right one.
 *
 * The issue date comes from the `month` and `year` the archive already
 * displays, not from `published_date`: the reader is told "September 2026" on
 * the card, so that is what the lock has to agree with. Anything else produces
 * a card that says September and then refuses to open.
 */

export type JournalLockReason = "edition" | "archive";

const monthNumbers = new Map([
  ["january", 1], ["february", 2], ["march", 3], ["april", 4],
  ["may", 5], ["june", 6], ["july", 7], ["august", 8],
  ["september", 9], ["october", 10], ["november", 11], ["december", 12]
]);

/**
 * An issue's month as `YYYY-MM`, or null when the year is unusable.
 *
 * An unreadable month falls back to December, which is the generous reading
 * within a year and still correct across years: an issue from before the
 * subscriber's joining year stays locked either way, and one from the joining
 * year itself is opened rather than withheld on the strength of a blank field.
 * (Year is reliable - the archive listing orders by `year::integer`, so a
 * non-numeric year on a published row would already be failing in production.)
 */
export function journalIssueMonth(
  month: string | null | undefined,
  year: string | null | undefined
): string | null {
  const yearNumber = Number(year?.trim());
  if (!Number.isInteger(yearNumber) || yearNumber < 1900 || yearNumber > 2200) return null;
  const monthNumber = monthNumbers.get(month?.trim().toLowerCase() ?? "") ?? 12;
  return `${String(yearNumber).padStart(4, "0")}-${String(monthNumber).padStart(2, "0")}`;
}

/**
 * The depth the reader has for this issue's edition. An issue whose edition
 * cannot be read from its metadata is opened with the deepest access the
 * reader holds on any edition: they are a paying subscriber, and bad metadata
 * is our problem, not theirs.
 */
function editionAccessFor(
  access: ArchiveAccess,
  edition: JournalEdition | null
): EditionAccess | null {
  if (edition) return access.editions[edition] ?? null;

  const held = Object.values(access.editions);
  if (held.length === 0) return null;
  if (held.some((candidate) => candidate.fullArchive)) {
    return { fullArchive: true, archiveFromMonth: null };
  }
  return held.reduce((deepest, candidate) =>
    (candidate.archiveFromMonth ?? "") < (deepest.archiveFromMonth ?? "") ? candidate : deepest
  );
}

/**
 * Why this issue is locked for this reader, or null when it opens. Both sides
 * of the window test are zero-padded `YYYY-MM`, so a string comparison is a
 * date comparison.
 */
export function journalLockReason(
  access: ArchiveAccess,
  editionType: string | null | undefined,
  month: string | null | undefined,
  year: string | null | undefined
): JournalLockReason | null {
  const editionAccess = editionAccessFor(access, journalEditionOf(editionType));
  if (!editionAccess) return "edition";
  if (editionAccess.fullArchive || !editionAccess.archiveFromMonth) return null;
  const issueMonth = journalIssueMonth(month, year);
  if (!issueMonth) return null;
  return issueMonth < editionAccess.archiveFromMonth ? "archive" : null;
}
