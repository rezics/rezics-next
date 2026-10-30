WITH input AS NOT MATERIALIZED (
  SELECT :state::text AS state, :at::timestamptz AS at
)
UPDATE semantic.context AS context
SET state = input.state,
    deleted_at = CASE WHEN input.state = 'deleted' THEN input.at ELSE context.deleted_at END,
    purge_after = CASE WHEN input.state = 'deleted' THEN input.at + interval '720 hours' ELSE context.purge_after END,
    security_revision = context.security_revision + 1
FROM input
WHERE context.route = :route::integer AND context.context_id = :context_id::uuid AND context.kind = 'community'
  AND ((input.state = 'deleted' AND context.state = 'active')
    OR (input.state = 'active' AND context.state = 'deleted' AND input.at < context.purge_after))
RETURNING context.security_revision::text AS version;
