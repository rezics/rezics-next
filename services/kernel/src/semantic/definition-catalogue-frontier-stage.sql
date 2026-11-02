WITH input AS MATERIALIZED (SELECT :root::text AS p_root, :activation_id::uuid AS p_activation_id, :previous::text AS p_previous, :generation::text::bigint AS p_generation, :through::text::bigint AS p_through, :after::text::bigint AS p_after),
admitted AS MATERIALIZED (
 SELECT previous_root,closed_generation,closed_sequence,staged_sequence
 FROM semantic.definition_catalogue_activation
 WHERE route=0 AND root_digest=(SELECT p_root FROM input) AND activation_id=(SELECT p_activation_id FROM input)
  AND state='invalidating' AND previous_root=(SELECT p_previous FROM input)
  AND closed_generation=(SELECT p_generation FROM input) AND closed_sequence=(SELECT p_through FROM input)
  AND staged_sequence=(SELECT p_after FROM input)
  AND NOT EXISTS(SELECT 1 FROM semantic.definition_catalogue_frontier WHERE route=0 AND root_digest=(SELECT p_root FROM input) LIMIT 1)
), page AS MATERIALIZED (
 SELECT id,sequence,consumer,provenance,dependency,enrollment_generation,state FROM semantic.definition_catalogue_consumer
 WHERE route=0 AND root_digest=(SELECT p_previous FROM input) AND state<>'invalidated' AND EXISTS(SELECT 1 FROM admitted)
   AND sequence>(SELECT p_after FROM input) AND sequence<=(SELECT p_through FROM input)
 ORDER BY sequence LIMIT 100
), staged AS (
 INSERT INTO semantic.definition_catalogue_frontier(route,root_digest,consumer_root,slot,consumer_id,sequence,closed_generation,consumer,provenance,dependency,enrollment_generation,consumer_state)
 SELECT 0,(SELECT p_root FROM input),(SELECT p_previous FROM input),row_number() OVER (ORDER BY sequence)::integer,id,sequence,(SELECT p_generation FROM input),consumer,provenance,dependency,enrollment_generation,state FROM page
 RETURNING sequence
)
, progressed AS (
UPDATE semantic.definition_catalogue_activation
SET native_position=native_position+1,staged_sequence=COALESCE((SELECT max(sequence) FROM staged),(SELECT p_through FROM input))
WHERE route=0 AND root_digest=(SELECT p_root FROM input) AND activation_id=(SELECT p_activation_id FROM input) AND state='invalidating' AND EXISTS(SELECT 1 FROM admitted)
RETURNING staged_sequence::text
) SELECT staged_sequence FROM progressed LIMIT 1;
