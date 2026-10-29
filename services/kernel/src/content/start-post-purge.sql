WITH input AS NOT MATERIALIZED (SELECT :at::timestamptz AS at)
UPDATE content.post p SET purge_started_at = i.at
FROM input i
WHERE p.route = :route::integer AND p.post_id = :post_id::uuid AND p.availability = 'erased'
  AND p.purge_started_at IS NULL AND NOT p.purge_completed
  AND (p.deleted_at IS NULL OR p.deleted_at < i.at - interval '30 days')
RETURNING p.post_id;
