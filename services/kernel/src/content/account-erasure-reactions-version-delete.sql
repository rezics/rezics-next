WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :actor_id::uuid AS actor_id
)
DELETE FROM content.reaction_liked_version AS version
USING input i
WHERE version.route = i.route AND version.actor_account_id = i.actor_id
  AND EXISTS (
    SELECT 1 FROM access.erasure e
    WHERE e.route = i.route AND e.account_id = i.actor_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM content.reaction r
    WHERE r.route = i.route AND r.actor_account_id = i.actor_id
    LIMIT 1
  )
RETURNING version.actor_account_id;
