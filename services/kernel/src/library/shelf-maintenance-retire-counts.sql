WITH input AS (SELECT :route::integer AS route,:account_id::uuid AS account_id,:generation::uuid AS generation,:before::boolean AS before),
 keys AS MATERIALIZED (
 (SELECT generation_id,bucket,type_id FROM library.shelf_count v WHERE v.route=(SELECT route FROM input) AND v.account_id=(SELECT account_id FROM input)
 AND (SELECT before FROM input) AND generation_id<(SELECT generation FROM input) ORDER BY generation_id,bucket,type_id LIMIT 100)
 UNION ALL
 (SELECT generation_id,bucket,type_id FROM library.shelf_count v WHERE v.route=(SELECT route FROM input) AND v.account_id=(SELECT account_id FROM input)
 AND NOT (SELECT before FROM input) AND generation_id>(SELECT generation FROM input) ORDER BY generation_id,bucket,type_id LIMIT 100))
 DELETE FROM library.shelf_count v USING keys WHERE v.route=(SELECT route FROM input) AND v.account_id=(SELECT account_id FROM input)
 AND (v.generation_id,v.bucket,v.type_id)=(keys.generation_id,keys.bucket,keys.type_id) RETURNING true AS removed;
