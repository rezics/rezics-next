SELECT context_id::text AS id,search_key AS key,language,source_version::text AS version,source_epoch
FROM semantic.context_directory_entry
WHERE route=0 AND state=:state::text
  AND search_key >= :prefix::text COLLATE "C"
  AND search_key < :prefix_end::text COLLATE "C"
  AND (search_key,context_id,language)>(:after_key::text COLLATE "C",:after_id::uuid,:after_language::text)
ORDER BY search_key,context_id,language
LIMIT 100;
