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
