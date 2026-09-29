import { query } from "../db/pool.js";
import {
  type EntitlementType,
  type JournalEdition,
  journalEditions,
  journalEntitlement
} from "./catalogue.js";

export type UserRole = "user" | "employee" | "admin" | "super_admin";

/**
 * Roles that receive unlimited content without a paid subscription. All three
 * carry identical content access; the distinction exists so role management can
 * be restricted later without another migration.
 */
export const staffRoles: readonly UserRole[] = ["employee", "admin", "super_admin"];

export function isStaffRole(role?: string | null): boolean {
  return staffRoles.includes(role as UserRole);
}

/** Administrative mutations such as a mass push must not be available to employees. */
export function isAdminRole(role?: string | null): boolean {
  return role === "admin" || role === "super_admin";
}

const activeEntitlementSql = `e.user_id = $1 AND e.status = 'active'
  AND e.starts_at <= now() AND (e.ends_at IS NULL OR e.ends_at > now())`;

/**
 * The entitlement types this user holds right now. Staff hold all of them by
 * role. Every gate asks this - "may they read THIS" - rather than whether a
 * subscription exists, because since the catalogue split a subscription no
 * longer means the same thing for everyone.
 */
export async function activeEntitlements(
  userId: string,
  role?: string | null
): Promise<Set<EntitlementType>> {
  if (isStaffRole(role)) return new Set(["insights", "journal_india", "journal_global"]);

  const result = await query<{ entitlement_type: EntitlementType }>(
    `SELECT DISTINCT e.entitlement_type FROM entitlements e WHERE ${activeEntitlementSql}`,
    [userId]
  );
  return new Set(result.rows.map((row) => row.entitlement_type));
}

/** True when the user currently holds one specific entitlement, by purchase or by role. */
export async function hasEntitlement(
  userId: string,
  role: string | null | undefined,
  type: EntitlementType
): Promise<boolean> {
  if (isStaffRole(role)) return true;

  const result = await query(
    `SELECT 1 FROM entitlements e WHERE ${activeEntitlementSql} AND e.entitlement_type = $2 LIMIT 1`,
    [userId, type]
  );
  return Boolean(result.rowCount);
}

/**
 * Plan intervals that read the whole archive. Anything else is treated as a
 * windowed plan, so a shorter plan added later (quarterly, say) is gated by
 * default rather than accidentally opening twelve years of back issues; a new
 * long plan has to be named here on purpose.
 */
const fullArchiveIntervals = ["yearly", "annual"];

export type EditionAccess = {
  /** Yearly subscribers and staff read every issue of the edition ever published. */
  fullArchive: boolean;
  /**
   * First issue month a windowed subscriber may read, as `YYYY-MM`, or null
   * when the window does not apply.
   *
   * A month rather than a timestamp for two reasons. It is the promise being
   * made - subscribe on the 20th and you still get that month's edition, rather
   * than paying for a month you cannot read - and journal issues are only ever
   * dated to a month, so comparing them as `YYYY-MM` strings keeps the test
   * clear of timezone drift, where an issue and a window an hour apart either
   * side of midnight could otherwise disagree.
   */
  archiveFromMonth: string | null;
};

export type ArchiveAccess = {
  /** Whether the user may read the journal archive at all - any edition. */
  hasAccess: boolean;
  /** The editions the user holds, each with how deep into it they may read. */
  editions: Partial<Record<JournalEdition, EditionAccess>>;
};

/**
 * Which journal editions this user can read, and how deep into each archive.
 *
 * Depth is per edition: a yearly India plan beside nothing else reads all of
 * India and none of Global. The window start, where a window applies, is
 * MIN(archive_from_month) across ALL of the user's subscriptions, including
 * lapsed ones, so cancelling and resubscribing keeps the original window
 * instead of restarting it. Access itself still depends on a currently active
 * entitlement - a lapsed subscriber reads nothing, and those dates are kept
 * only so the window survives if they come back.
 */
export async function resolveArchiveAccess(
  userId: string,
  role?: string | null
): Promise<ArchiveAccess> {
  const everything: EditionAccess = { fullArchive: true, archiveFromMonth: null };
  if (isStaffRole(role)) {
    return { hasAccess: true, editions: { india: everything, global: everything } };
  }

  const result = await query<{
    entitlement_type: EntitlementType;
    full_archive: boolean;
    archive_from_month: string | null;
  }>(
    `WITH active AS (
       SELECT e.entitlement_type, lower(pl."interval") AS plan_interval
       FROM entitlements e
       JOIN subscriptions s ON s.id = e.subscription_id
       JOIN subscription_plans pl ON pl.id = s.local_plan_id
       WHERE ${activeEntitlementSql} AND e.entitlement_type IN ('journal_india', 'journal_global')
     )
     SELECT
       entitlement_type,
       bool_or(plan_interval = ANY($2)) AS full_archive,
       -- The frozen window, earliest across all of the user's subscriptions.
       -- Rows predating that column fall back to the month they first
       -- subscribed in, which is exactly how they behaved before it existed.
       -- Read in UTC rather than the server's timezone so the answer does not
       -- depend on where this runs, and so a purchase made in the small hours
       -- of the 1st lands on the earlier month - the generous side.
       (SELECT min(COALESCE(
                 archive_from_month,
                 to_char(first_subscribed_at AT TIME ZONE 'UTC', 'YYYY-MM')))
          FROM subscriptions WHERE user_id = $1) AS archive_from_month
     FROM active GROUP BY entitlement_type`,
    [userId, fullArchiveIntervals]
  );

  const editions: ArchiveAccess["editions"] = {};
  for (const edition of journalEditions) {
    const row = result.rows.find((candidate) => candidate.entitlement_type === journalEntitlement(edition));
    if (!row) continue;
    // A paying subscriber whose start date cannot be resolved is given the
    // whole archive rather than none of it: that combination means missing
    // data on our side, and the wrong way to fail is to take content from
    // someone who paid.
    editions[edition] = row.full_archive || row.archive_from_month === null
      ? everything
      : { fullArchive: false, archiveFromMonth: row.archive_from_month };
  }

  return { hasAccess: Object.keys(editions).length > 0, editions };
}
