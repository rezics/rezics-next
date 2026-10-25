WITH input AS (
  SELECT :delta::integer AS delta, :route::integer AS route, :subject_id::uuid AS subject_id
)
UPDATE semantic.subject AS s
SET current_facts = s.current_facts + input.delta
FROM input
WHERE s.route = input.route AND s.subject_id = input.subject_id
  AND s.current_facts + input.delta BETWEEN 0 AND 512
RETURNING s.current_facts;
