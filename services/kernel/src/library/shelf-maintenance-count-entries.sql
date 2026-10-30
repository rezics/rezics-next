WITH input AS (SELECT :route::integer AS route,:account_id::uuid AS account_id), page AS MATERIALIZED (SELECT subject_id,state,type_id FROM library.entry WHERE route=(SELECT arg.route FROM input arg) AND account_id=(SELECT arg.account_id FROM input arg)
 AND subject_id>:after::uuid ORDER BY subject_id LIMIT 100), deltas AS (
 SELECT bucket,contributions.type_id,count(*) AS n FROM page CROSS JOIN LATERAL (
 SELECT 'all'::text AS bucket,'00000000-0000-0000-0000-000000000000'::uuid AS type_id
 UNION ALL SELECT 'all',page.type_id WHERE page.type_id IS NOT NULL
 UNION ALL SELECT page.state,'00000000-0000-0000-0000-000000000000'::uuid WHERE page.state IN ('planned','in_progress','completed','paused','dropped')
 UNION ALL SELECT page.state,page.type_id WHERE page.type_id IS NOT NULL AND page.state IN ('planned','in_progress','completed','paused','dropped')
 ) contributions GROUP BY bucket,contributions.type_id), saved AS (
 INSERT INTO library.shelf_count(route,account_id,generation_id,bucket,type_id,n)
 SELECT (SELECT arg.route FROM input arg),(SELECT arg.account_id FROM input arg),:generation::uuid,bucket,type_id,n FROM deltas ORDER BY bucket,type_id
 ON CONFLICT(route,account_id,generation_id,bucket,type_id) DO UPDATE SET n=shelf_count.n+EXCLUDED.n RETURNING type_id)
 SELECT subject_id AS id FROM page ORDER BY subject_id;
