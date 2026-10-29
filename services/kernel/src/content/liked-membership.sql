SELECT requested.target_id AS "subjectId"
FROM unnest(:target_ids::uuid[]) AS requested(target_id)
CROSS JOIN LATERAL (
  SELECT stored.target_id
  FROM content.reaction AS stored
  WHERE stored.route = :route::integer
    AND stored.actor_account_id = :actor_id::uuid
    AND stored.target_kind = 'subject'
    AND stored.kind IN ('like', 'love')
    AND stored.target_id = requested.target_id
  LIMIT 1
) AS liked;
