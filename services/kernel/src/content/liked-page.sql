SELECT liked.target_id AS "subjectId", liked.kind,
       COALESCE(stored.version, 0::bigint)::text AS version
FROM (SELECT :route::integer AS route, :actor_id::uuid AS actor_id) AS input
LEFT JOIN content.reaction_liked_version AS stored
  ON stored.route = input.route AND stored.actor_account_id = input.actor_id
LEFT JOIN LATERAL (
  SELECT target_id, kind
  FROM content.reaction
  WHERE route = input.route
    AND actor_account_id = input.actor_id
    AND target_kind = 'subject'
    AND kind IN ('like', 'love')
    AND target_id > :after::uuid
  ORDER BY target_id
  LIMIT :limit::integer
) AS liked ON true
ORDER BY liked.target_id;
