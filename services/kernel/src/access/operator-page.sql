WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :operator_id::uuid AS operator_id,
         NULLIF(:after::text, '')::uuid AS after, :limit::integer AS page_limit
)
SELECT c.reservation_id AS "reservationId", c.related_account_id AS "subjectAccountId"
FROM input i JOIN access.lifecycle_coordination c ON c.route = i.route AND c.account_id = i.operator_id
WHERE c.purpose = 'operator' AND c.reservation_id > COALESCE(i.after, '00000000-0000-0000-0000-000000000000'::uuid)
ORDER BY c.reservation_id
LIMIT (SELECT page_limit FROM input);
