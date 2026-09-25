import type { ArchiveAccess } from "./entitlement.js";

/**
 * Which journal issues a windowed subscriber may open.
 *
 * The issue date comes from the `month` and `year` the archive already
 * displays, not from `published_date`: the reader is told "September 2026" on
 * the card, so that is what the lock has to agree with. Anything else produces
 * a card that says September and then refuses to open.
 */

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
 * True when this issue sits before the reader's archive window and must be
 * shown locked. An issue whose date cannot be read at all is left open: the
 * reader is a paying subscriber, and bad metadata is our problem, not theirs.
 *
 * Both sides are zero-padded `YYYY-MM`, so a string comparison is a date
 * comparison.
 */
export function isJournalLocked(
  access: ArchiveAccess,
  month: string | null | undefined,
  year: string | null | undefined
): boolean {
  if (access.fullArchive || !access.archiveFromMonth) return false;
  const issueMonth = journalIssueMonth(month, year);
  if (!issueMonth) return false;
  return issueMonth < access.archiveFromMonth;
}
