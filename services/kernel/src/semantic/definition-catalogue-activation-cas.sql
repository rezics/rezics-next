WITH input AS MATERIALIZED (SELECT :root::text AS p_root, :previous::nullable(text) AS p_previous),
eligible AS MATERIALIZED (
 SELECT a.root_digest,a.expected_head FROM semantic.definition_catalogue_activation a
 JOIN semantic.definition_catalogue_enrollment target ON target.route=0 AND target.root_digest=a.root_digest
 JOIN semantic.definition_catalogue_build b ON b.route=0 AND b.root_digest=a.root_digest
 WHERE a.route=0 AND a.root_digest=(SELECT p_root FROM input) AND a.activation_id=:activation_id::uuid
 -- Every captured dependency must have an exact durable withdrawal before publication.
 AND a.state='invalidating' AND target.protocol=1 AND target.state='open' AND b.state='ready'
 AND a.expected_head=:head::integer AND a.previous_root IS NOT DISTINCT FROM (SELECT p_previous FROM input)
 AND NOT EXISTS (SELECT 1 FROM semantic.definition_catalogue_frontier f WHERE f.route=0 AND f.root_digest=a.root_digest LIMIT 1)
 AND ((a.previous_root IS NULL AND a.closed_generation=0 AND a.closed_sequence=0 AND a.staged_sequence=0)
 OR EXISTS (
  SELECT 1 FROM semantic.definition_catalogue_enrollment e
  WHERE e.route=0 AND e.root_digest=a.previous_root AND e.protocol=1 AND e.state='closed'
   AND e.closed_generation=a.closed_generation AND e.generation=a.closed_generation
   AND e.closed_sequence=a.closed_sequence AND e.last_sequence=a.closed_sequence
   AND a.staged_sequence=a.closed_sequence
   AND NOT EXISTS (SELECT 1 FROM semantic.definition_catalogue_consumer c
    WHERE c.route=0 AND c.root_digest=e.root_digest AND c.state<>'invalidated' LIMIT 1)
 ))
), changed AS (
 UPDATE semantic.definition_catalogue_head h
 SET root_digest=e.root_digest,head=h.head+1,recorded_transaction_id=:transaction_id::uuid
 FROM eligible e WHERE h.route=0 AND h.head=e.expected_head AND h.root_digest IS NOT DISTINCT FROM (SELECT p_previous FROM input)
 RETURNING h.head
), activated AS (
 UPDATE semantic.definition_catalogue_activation SET native_position=native_position+1,state='active'
 WHERE route=0 AND root_digest=(SELECT p_root FROM input) AND EXISTS(SELECT 1 FROM changed) RETURNING root_digest
)
SELECT head FROM changed LIMIT 1;
