-- Native candidates include proposals, compact expansions and every historical adoption.
-- Never use projection samples or historically permitted candidates as the possible superset.
WITH input AS NOT MATERIALIZED (
  SELECT :after::uuid AS after, :has_after::boolean AS has_after
)
SELECT candidate_id::text AS after, candidate_id::text AS candidate_id, slot_id::text AS slot_id
FROM semantic.candidate CROSS JOIN input
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND property = :property::text
  AND statement->'value'->>'type' = 'value'
  AND statement->'value'->>'content' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND statement->'value'->>'content' = :value::text
  AND (NOT input.has_after OR candidate_id > input.after)
ORDER BY candidate_id LIMIT 1;
