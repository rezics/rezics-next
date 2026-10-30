SELECT route,account_id AS "accountId",run_id AS "runId",epoch,sequence,segment,kind,enqueue_attempt AS attempt FROM library.shelf_maintenance_run
 WHERE NOT cancelled AND phase<>'complete'
 AND (route,account_id,run_id)>(:after_route::integer,:after_account::uuid,:after_run::uuid)
 ORDER BY route,account_id,run_id LIMIT :page_limit::integer;
