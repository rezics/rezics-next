-- Includes compact history even after expansion; duplicates are charged and discarded later.
SELECT erasure_key::text AS after, statement_id::text AS candidate_id, slot_id::text AS slot_id
FROM semantic.fact
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND property = :property::text
  AND kind = 'statement' AND operation = 'assert'
  AND body->'value'->>'type' = 'value'
  AND body->'value'->>'content' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND body->'value'->>'content' = :value::text
  AND (:after::bigint IS NULL OR erasure_key > :after::bigint)
ORDER BY erasure_key LIMIT 1;
