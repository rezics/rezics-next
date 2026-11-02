SELECT phase,after_sequence::text,after_original
FROM semantic.definition_catalogue_retirement WHERE route=0 AND root_digest=:root::text LIMIT 1 FOR UPDATE;
