WITH input AS (SELECT :route::integer AS route,:account_id::uuid AS account_id,:run_id::uuid AS run_id,:before::boolean AS before),
 keys AS MATERIALIZED (
 (SELECT run_id,epoch,sequence FROM library.shelf_maintenance_step s
 WHERE s.route=(SELECT route FROM input) AND s.account_id=(SELECT account_id FROM input)
 AND (input_identity IS NOT NULL OR cursor<>'[]'::jsonb) AND (SELECT before FROM input)
 AND run_id<(SELECT run_id FROM input) ORDER BY run_id,epoch,sequence LIMIT 100)
 UNION ALL
 (SELECT run_id,epoch,sequence FROM library.shelf_maintenance_step s
 WHERE s.route=(SELECT route FROM input) AND s.account_id=(SELECT account_id FROM input)
 AND (input_identity IS NOT NULL OR cursor<>'[]'::jsonb) AND NOT (SELECT before FROM input)
 AND run_id>(SELECT run_id FROM input) ORDER BY run_id,epoch,sequence LIMIT 100))
 UPDATE library.shelf_maintenance_step s SET cursor='[]'::jsonb,input_identity=NULL FROM keys
 WHERE s.route=(SELECT route FROM input) AND s.account_id=(SELECT account_id FROM input)
 AND (s.run_id,s.epoch,s.sequence)=(keys.run_id,keys.epoch,keys.sequence) RETURNING true AS removed;
