WITH input AS MATERIALIZED (SELECT :root::text AS root,:original_key::text AS original_key,:transaction_id::uuid AS transaction_id),
position AS MATERIALIZED (
 SELECT b.root_digest,'build'::text AS phase,b.steps AS native_position FROM semantic.definition_catalogue_build b
 JOIN semantic.definition_catalogue_enrollment e ON e.route=0 AND e.root_digest=b.root_digest
 WHERE b.route=0 AND b.root_digest=(SELECT root FROM input) AND e.protocol=1 AND NOT EXISTS (SELECT 1 FROM semantic.definition_catalogue_retirement r WHERE r.route=0 AND r.root_digest=b.root_digest)
 UNION ALL
 SELECT a.root_digest,'activation'::text,a.native_position FROM semantic.definition_catalogue_activation a
 WHERE a.route=0 AND a.root_digest=(SELECT root FROM input) AND NOT EXISTS (SELECT 1 FROM semantic.definition_catalogue_retirement r WHERE r.route=0 AND r.root_digest=a.root_digest)
), saved AS (
 INSERT INTO semantic.definition_catalogue_position(route,root_digest,phase,native_position,original_key,recorded_transaction_id)
 SELECT 0,root_digest,phase,native_position,(SELECT original_key FROM input),(SELECT transaction_id FROM input) FROM position
 ON CONFLICT DO NOTHING RETURNING phase,native_position::text
) SELECT phase,native_position FROM saved;
