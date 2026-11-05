UPDATE semantic.definition_catalogue_retirement
SET phase=:next::text,after_original=:after::text,after_sequence=:sequence::text::bigint
WHERE route=0 AND root_digest=:root::text AND phase=:expected::text
RETURNING phase;
