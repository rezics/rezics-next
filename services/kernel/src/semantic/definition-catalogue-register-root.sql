WITH input AS MATERIALIZED (SELECT :transaction_id::uuid AS transaction_id), registered AS (
 INSERT INTO semantic.definition_catalogue_enrollment(route,root_digest,protocol,state,recorded_transaction_id)
 SELECT 0,b.root_digest,1,'open',(SELECT transaction_id FROM input)
 FROM semantic.definition_catalogue_build b
 WHERE b.route=0 AND b.root_digest=:root::text AND b.state<>'refused'
   AND b.recorded_transaction_id=(SELECT transaction_id FROM input)
   AND NOT EXISTS (SELECT 1 FROM semantic.definition_catalogue_head h WHERE h.route=0 AND h.root_digest=b.root_digest)
 ON CONFLICT DO NOTHING
 RETURNING root_digest
) SELECT root_digest FROM registered LIMIT 1;
