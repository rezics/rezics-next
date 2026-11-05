WITH input AS (SELECT :route::integer AS route,:account_id::uuid AS account_id), keys AS MATERIALIZED (SELECT run_id,subject_id FROM library.shelf_maintenance_source WHERE route=(SELECT arg.route FROM input arg) AND account_id=(SELECT arg.account_id FROM input arg) ORDER BY run_id,subject_id LIMIT 100)
 DELETE FROM library.shelf_maintenance_source v USING keys WHERE v.route=(SELECT arg.route FROM input arg) AND v.account_id=(SELECT arg.account_id FROM input arg)
 AND (v.run_id,v.subject_id)=(keys.run_id,keys.subject_id) RETURNING true AS removed;
