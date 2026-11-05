WITH held AS MATERIALIZED (
  SELECT purpose, related_account_id
  FROM access.lifecycle_coordination
  WHERE route = :route AND account_id = :account_id
  ORDER BY reservation_id LIMIT 1
)
SELECT EXISTS (SELECT 1 FROM held) AS held,
       (SELECT purpose FROM held) AS purpose,
       (SELECT related_account_id FROM held) AS "relatedAccountId";
