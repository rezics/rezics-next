WITH input AS (SELECT :workflow_until::bigint AS workflow_until)
SELECT 1 AS pending FROM access.erasure_locator_work, input
WHERE state = 'open' AND opened_at <= input.workflow_until
ORDER BY opened_at <-> input.workflow_until
LIMIT 1;
