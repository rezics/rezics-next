SELECT 1 AS pending
WHERE (SELECT min(opened_at) FROM access.erasure_locator_work WHERE state = 'open') <= :workflow_until::bigint
LIMIT 1;
