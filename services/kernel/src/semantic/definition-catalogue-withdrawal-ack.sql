WITH captured AS MATERIALIZED (
 SELECT f.* FROM semantic.definition_catalogue_frontier f
 JOIN semantic.definition_catalogue_activation a ON a.route=f.route AND a.root_digest=f.root_digest
 WHERE f.route=0 AND f.root_digest=:root::text AND f.slot=:slot::integer
 AND a.activation_id=:activation_id::uuid AND a.state='invalidating' AND a.previous_root=:previous::text
 AND f.consumer_id=:id::text AND f.sequence=:sequence::text::bigint AND f.closed_generation=:generation::text::bigint
 AND f.consumer=:consumer::bytea AND f.provenance=:provenance::bytea AND f.dependency=:dependency::bytea
 AND f.enrollment_generation=:enrollment_generation::text::bigint
), invalidated AS (
 UPDATE semantic.definition_catalogue_consumer c SET state='invalidated',invalidated_generation=f.closed_generation,
 invalidation_receipt=:receipt::bytea,owner_generation=:owner::text,restore_generation=:restore::text
 FROM captured f WHERE c.route=0 AND c.root_digest=:previous::text AND c.id=f.consumer_id
 AND c.sequence=f.sequence AND c.enrollment_generation=f.enrollment_generation AND c.state=f.consumer_state
 AND c.consumer=f.consumer AND c.provenance=f.provenance AND c.dependency=f.dependency
 RETURNING c.id
), consumed AS (
 DELETE FROM semantic.definition_catalogue_frontier f WHERE f.route=0 AND f.root_digest=:root::text
 AND f.slot=:slot::integer AND f.consumer_id IN (SELECT id FROM invalidated) RETURNING f.consumer_id
)
SELECT consumer_id FROM consumed LIMIT 1;
