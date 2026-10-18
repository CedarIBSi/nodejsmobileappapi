-- Read-only: replace USER@example.com before running in pgAdmin to inspect an
-- account's purchase period and entitlement dates. Never returns store
-- purchase tokens or transaction identifiers.
WITH target(email) AS (VALUES ('USER@example.com'))
SELECT now() AS checked_at, u.id AS user_id, u.email, u.role,
       s.id AS subscription_id, s.provider, s.status AS subscription_status,
       s.current_start, s.current_end,
       p.code AS plan_code, p.name AS plan_name,
       e.entitlement_type, e.status AS entitlement_status, e.starts_at, e.ends_at,
       (e.status = 'active' AND e.starts_at <= now()
        AND (e.ends_at IS NULL OR e.ends_at > now())) AS entitlement_live
FROM app_users u
JOIN target t ON lower(btrim(u.email)) = lower(btrim(t.email))
LEFT JOIN subscriptions s ON s.user_id = u.id
LEFT JOIN subscription_plans p ON p.id = s.local_plan_id
LEFT JOIN entitlements e ON e.subscription_id = s.id AND e.user_id = u.id
ORDER BY s.created_at DESC, e.entitlement_type;
