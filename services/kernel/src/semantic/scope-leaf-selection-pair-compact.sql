-- Includes compact history even after expansion; duplicates are charged and discarded later.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id,
         :property::text AS property, :value::text AS value,
         :has_after::boolean AS has_after, :after::bigint AS after
)
SELECT erasure_key::text AS after, statement_id::text AS candidate_id, slot_id::text AS slot_id
FROM semantic.fact CROSS JOIN input
WHERE semantic.fact.route = input.route AND semantic.fact.subject_id = input.subject_id
  AND semantic.fact.property = input.property AND semantic.fact.kind = 'statement'
  AND semantic.fact.operation = 'assert'
  AND semantic.fact.body->'value'->>'type' = 'value'
  AND semantic.fact.body->'value'->>'content' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND semantic.fact.body->'value'->>'content' = input.value
  AND (NOT input.has_after OR semantic.fact.erasure_key > input.after)
ORDER BY semantic.fact.erasure_key LIMIT 1;
