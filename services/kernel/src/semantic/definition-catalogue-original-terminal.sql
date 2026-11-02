-- Only the private original receiver calls this after authentic committed receipt resolution.
UPDATE semantic.definition_catalogue_original SET state='terminal',terminal_transaction_id=:transaction_id::uuid,
 result_digest=:result_digest::bytea
WHERE route=0 AND original_key=:original_key::text AND state='spent' AND spent=admitted
RETURNING original_key;
