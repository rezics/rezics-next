-- Each source returns at most eight witnesses in native index order. All rows
-- sharing (time, route) elect the same bounded route owner before this cursor advances.
WITH input AS NOT MATERIALIZED (SELECT :cutoff::timestamptz AS cutoff, :frontier::jsonb AS frontier), due AS (
(SELECT 'post'::text AS kind, deleted_at AS at, route FROM content.post CROSS JOIN input
 WHERE deleted_at < input.cutoff - interval '30 days' AND NOT purge_completed
   AND (deleted_at, route) > (coalesce((input.frontier->'post'->>'through')::timestamptz, '-infinity'),
                          coalesce((input.frontier->'post'->>'route')::integer, -1))
 ORDER BY deleted_at, route LIMIT 8)
UNION ALL
(SELECT 'eligible'::text AS kind, created_at AS at, route FROM content.media CROSS JOIN input
 WHERE created_at <= input.cutoff - interval '24 hours' AND claimed_at IS NULL AND NOT erased AND NOT collection_pending
   AND (created_at, route) > (coalesce((input.frontier->'eligible'->>'through')::timestamptz, '-infinity'),
                          coalesce((input.frontier->'eligible'->>'route')::integer, -1))
 ORDER BY created_at, route LIMIT 8)
UNION ALL
(SELECT 'pending'::text AS kind, '-infinity'::timestamptz AS at, route FROM content.media CROSS JOIN input
 WHERE collection_pending AND route > coalesce((input.frontier->'pending'->>'route')::integer, -1)
 ORDER BY route LIMIT 8)
)
SELECT kind, at::text AS through, route FROM due ORDER BY kind, at, route;
