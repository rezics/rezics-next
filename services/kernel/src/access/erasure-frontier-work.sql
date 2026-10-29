SELECT 1 AS pending FROM access.erasure_locator_work
WHERE state = 'open' AND opened_at <= :at::bigint
LIMIT 1;
