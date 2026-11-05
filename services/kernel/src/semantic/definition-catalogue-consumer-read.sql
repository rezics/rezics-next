SELECT consumer,provenance,dependency,enrollment_generation::text,state FROM semantic.definition_catalogue_consumer
WHERE route=0 AND root_digest=:root::text AND id=:id::text LIMIT 1;
