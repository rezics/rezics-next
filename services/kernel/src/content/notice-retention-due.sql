-- Each source returns at most eight witnesses in native index order. All rows
-- sharing (time, route) elect the same bounded route owner before this cursor advances.
WITH input AS NOT MATERIALIZED (SELECT :cutoff::timestamptz AS cutoff, :frontier::jsonb AS frontier), due AS (
(SELECT 'notice'::text AS kind, created_at AS at, route FROM content.notice CROSS JOIN input
 WHERE created_at < input.cutoff
   AND (created_at, route) > (coalesce((input.frontier->'notice'->>'through')::timestamptz, '-infinity'),
                          coalesce((input.frontier->'notice'->>'route')::integer, -1))
 ORDER BY created_at, route LIMIT 8)
UNION ALL
(SELECT 'finalization'::text AS kind, created_at AS at, route FROM content.notice_finalization CROSS JOIN input
 WHERE created_at < input.cutoff
   AND (created_at, route) > (coalesce((input.frontier->'finalization'->>'through')::timestamptz, '-infinity'),
                          coalesce((input.frontier->'finalization'->>'route')::integer, -1))
 ORDER BY created_at, route LIMIT 8)
UNION ALL
(SELECT 'threadWatch'::text AS kind, published_at AS at, route FROM content.thread_watch_notice_work CROSS JOIN input
 WHERE published_at < input.cutoff
   AND (published_at, route) > (coalesce((input.frontier->'threadWatch'->>'through')::timestamptz, '-infinity'),
                          coalesce((input.frontier->'threadWatch'->>'route')::integer, -1))
 ORDER BY published_at, route LIMIT 8)
UNION ALL
(SELECT 'boardWatch'::text AS kind, published_at AS at, route FROM content.board_watch_notice_work CROSS JOIN input
 WHERE published_at < input.cutoff
   AND (published_at, route) > (coalesce((input.frontier->'boardWatch'->>'through')::timestamptz, '-infinity'),
                          coalesce((input.frontier->'boardWatch'->>'route')::integer, -1))
 ORDER BY published_at, route LIMIT 8)
)
SELECT kind, at::text AS through, route FROM due ORDER BY kind, at, route;
