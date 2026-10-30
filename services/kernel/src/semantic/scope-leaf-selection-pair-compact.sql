-- Includes compact history even after expansion; duplicates are charged and discarded later.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id,
         :property::text AS property, :value::text AS value, :after::bigint AS after
)
SELECT erasure_key::text AS after, statement_id::text AS candidate_id, slot_id::text AS slot_id
FROM semantic.fact CROSS JOIN input
WHERE route = input.route AND subject_id = input.subject_id AND property = input.property
  AND kind = 'statement' AND operation = 'assert'
  AND body->'value'->>'type' = 'value'
  AND body->'value'->>'content' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND body->'value'->>'content' = input.value
  AND (input.after IS NULL OR erasure_key > input.after)
ORDER BY erasure_key LIMIT 1;
