WITH advanced AS (
 UPDATE semantic.definition_catalogue_enrollment SET last_sequence=last_sequence+1
 WHERE route=0 AND root_digest=:root::text AND protocol=1 AND state='open' AND generation=:generation::text::bigint
 RETURNING root_digest,last_sequence,generation
)
, enrolled AS (
INSERT INTO semantic.definition_catalogue_consumer(route,root_digest,id,sequence,enrollment_generation,consumer,provenance,dependency)
SELECT 0,root_digest,:id::text,last_sequence,generation,:consumer::bytea,:provenance::bytea,:dependency::bytea FROM advanced
RETURNING enrollment_generation::text
) SELECT enrollment_generation FROM enrolled LIMIT 1;
