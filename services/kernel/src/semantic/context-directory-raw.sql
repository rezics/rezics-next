SELECT context_id::text AS id,search_key AS key,language,source_version::text AS version,source_epoch
FROM semantic.context_directory_entry
WHERE route=0 AND state=:state::text AND language='' AND context_id>:after_id::uuid
ORDER BY context_id
LIMIT 100;
