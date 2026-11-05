SELECT original_key,state FROM semantic.definition_catalogue_original
WHERE route=0 AND root_digest=:root::text AND original_key>:after::text
ORDER BY original_key LIMIT 1 FOR UPDATE;
