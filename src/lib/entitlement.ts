import { query } from "../db/pool.js";

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

/**
 * True when the user currently holds premium access, either from a staff role or
 * an active entitlement. Mirrors the test used by the article meter.
 */
export async function hasActiveEntitlement(
  userId: string,
  role?: string | null
): Promise<boolean> {
  if (isStaffRole(role)) return true;

  const result = await query(
    `SELECT 1 FROM entitlements
     WHERE user_id = $1 AND status = 'active'
       AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
     LIMIT 1`,
    [userId]
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

export type ArchiveAccess = {
  /** Whether the user may read the journal archive at all. */
  hasAccess: boolean;
  /** Yearly subscribers and staff read every issue ever published. */
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

/**
 * How deep into the journal archive this user can read.
 *
 * The window start is MIN(first_subscribed_at) across ALL of the user's
 * subscriptions, including lapsed ones, so cancelling and resubscribing keeps
 * the original window instead of restarting it. Access itself still depends on
 * a currently active entitlement - a lapsed subscriber reads nothing, and those
 * dates are kept only so the window survives if they come back.
 */
export async function resolveArchiveAccess(
  userId: string,
  role?: string | null
): Promise<ArchiveAccess> {
  if (isStaffRole(role)) return { hasAccess: true, fullArchive: true, archiveFromMonth: null };

  const result = await query<{
    has_access: boolean;
    full_archive: boolean;
    archive_from_month: string | null;
  }>(
    `WITH active AS (
       SELECT lower(pl."interval") AS plan_interval
       FROM entitlements e
       JOIN subscriptions s ON s.id = e.subscription_id
       JOIN subscription_plans pl ON pl.id = s.local_plan_id
       WHERE e.user_id = $1 AND e.status = 'active'
         AND e.starts_at <= now() AND (e.ends_at IS NULL OR e.ends_at > now())
     )
     SELECT
       EXISTS (SELECT 1 FROM active) AS has_access,
       EXISTS (SELECT 1 FROM active WHERE plan_interval = ANY($2)) AS full_archive,
       -- Read in UTC rather than the server's timezone so the answer does not
       -- depend on where this runs, and so a purchase made in the small hours
       -- of the 1st lands on the earlier month - the generous side.
       (SELECT to_char(min(first_subscribed_at) AT TIME ZONE 'UTC', 'YYYY-MM')
          FROM subscriptions WHERE user_id = $1) AS archive_from_month`,
    [userId, fullArchiveIntervals]
  );

  const row = result.rows[0];
  if (!row?.has_access) return { hasAccess: false, fullArchive: false, archiveFromMonth: null };
  if (row.full_archive) return { hasAccess: true, fullArchive: true, archiveFromMonth: null };

  // A paying subscriber whose start date cannot be resolved is given the whole
  // archive rather than none of it: that combination means missing data on our
  // side, and the wrong way to fail is to take content from someone who paid.
  return {
    hasAccess: true,
    fullArchive: row.archive_from_month === null,
    archiveFromMonth: row.archive_from_month
  };
}
