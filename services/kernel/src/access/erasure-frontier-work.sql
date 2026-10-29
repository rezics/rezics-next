SELECT 1 AS pending FROM access.erasure_locator_work
WHERE state = 'open' AND opened_at <= :workflow_until::bigint
ORDER BY opened_at <-> :workflow_until::bigint
LIMIT 1;
