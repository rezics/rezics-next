WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
)
DELETE FROM library.progress_discovery_generation AS generation
USING input
WHERE generation.route = input.route AND generation.account_id = input.account_id
RETURNING true AS removed;
