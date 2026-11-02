INSERT INTO semantic.definition_catalogue_retirement(route,root_digest,recorded_transaction_id)
SELECT 0,e.root_digest,:transaction_id::uuid FROM semantic.definition_catalogue_enrollment e
WHERE e.route=0 AND e.root_digest=:root::text AND e.protocol=1 AND e.state='closed'
 AND NOT EXISTS(SELECT 1 FROM semantic.definition_catalogue_head h WHERE h.route=0 AND h.root_digest=e.root_digest)
ON CONFLICT DO NOTHING RETURNING phase;
