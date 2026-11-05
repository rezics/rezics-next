SELECT liked.target_id AS "subjectId", COALESCE(stored.version, 0::bigint)::text AS version
FROM (SELECT :route::integer AS route, :actor_id::uuid AS actor_id) AS input
LEFT JOIN content.reaction_liked_version AS stored
  ON stored.route = input.route AND stored.actor_account_id = input.actor_id
LEFT JOIN LATERAL (
  SELECT requested.target_id
  FROM unnest(:target_ids::uuid[]) AS requested(target_id)
  CROSS JOIN LATERAL (
    SELECT reaction.target_id
    FROM content.reaction AS reaction
    WHERE reaction.route = input.route
      AND reaction.actor_account_id = input.actor_id
      AND reaction.target_kind = 'subject'
      AND reaction.kind IN ('like', 'love')
      AND reaction.target_id = requested.target_id
    LIMIT 1
  ) AS matched
) AS liked ON true;
