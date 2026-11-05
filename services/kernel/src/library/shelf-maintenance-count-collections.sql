WITH input AS (SELECT :route::integer AS route,:account_id::uuid AS account_id), page AS MATERIALIZED (SELECT collection_id,state FROM library.collection WHERE route=(SELECT arg.route FROM input arg)
 AND curator_account_id=(SELECT arg.account_id FROM input arg) AND collection_id>:after::uuid ORDER BY collection_id LIMIT 100), saved AS (
 INSERT INTO library.shelf_count(route,account_id,generation_id,bucket,type_id,n)
 SELECT (SELECT arg.route FROM input arg),(SELECT arg.account_id FROM input arg),:generation::uuid,'collections','00000000-0000-0000-0000-000000000000',count(*) FROM page WHERE state='active'
 ON CONFLICT(route,account_id,generation_id,bucket,type_id) DO UPDATE SET n=shelf_count.n+EXCLUDED.n RETURNING type_id)
 SELECT collection_id AS id FROM page ORDER BY collection_id;
