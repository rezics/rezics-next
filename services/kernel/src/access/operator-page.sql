WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :operator_id::uuid AS operator_id,
         NULLIF(:after::text, '')::uuid AS after, :limit::integer AS page_limit
)
SELECT c.reservation_id AS "reservationId", c.related_account_id AS "subjectAccountId"
FROM input i JOIN access.lifecycle_coordination c ON c.route = i.route AND c.account_id = i.operator_id
WHERE c.purpose = 'operator' AND (i.after IS NULL OR c.reservation_id > i.after)
ORDER BY c.reservation_id
LIMIT (SELECT page_limit FROM input);
