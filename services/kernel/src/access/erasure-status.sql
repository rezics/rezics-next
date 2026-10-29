SELECT 1 AS pending FROM access.erasure_locator_work
WHERE state = 'open' AND source_at <= :at::timestamptz
LIMIT 1;
