WITH closed AS (
UPDATE semantic.definition_catalogue_enrollment
SET state='closed',generation=generation+1,closed_generation=generation+1,closed_sequence=last_sequence
WHERE route=0 AND root_digest=:root::text AND protocol=1 AND state='open' AND generation=:generation::text::bigint
RETURNING closed_generation::text,closed_sequence::text
) SELECT closed_generation,closed_sequence FROM closed LIMIT 1;
