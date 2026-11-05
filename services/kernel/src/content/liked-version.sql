SELECT COALESCE(stored.version, 0::bigint)::text AS version
FROM (SELECT :route::integer AS route, :actor_id::uuid AS actor_id) AS input
LEFT JOIN content.reaction_liked_version AS stored
  ON stored.route = input.route AND stored.actor_account_id = input.actor_id;
