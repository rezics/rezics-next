WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,:collection_id::uuid AS collection_id,:audience::text AS audience,:generation::uuid AS generation
), selected AS MATERIALIZED (
  SELECT stored.subject_id FROM library.collection_kind_subject AS stored,input
  WHERE stored.route=input.route AND stored.collection_id=input.collection_id
    AND stored.audience=input.audience AND stored.generation=input.generation
  ORDER BY stored.subject_id LIMIT 100
)
DELETE FROM library.collection_kind_subject AS victim USING selected,input
WHERE victim.route=input.route AND victim.collection_id=input.collection_id
  AND victim.audience=input.audience AND victim.generation=input.generation AND victim.subject_id=selected.subject_id
RETURNING true AS removed;
