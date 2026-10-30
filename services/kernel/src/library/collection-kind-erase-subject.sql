WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,:account_id::uuid AS account_id
), selected AS MATERIALIZED (
  SELECT stored.collection_id,stored.audience,stored.generation,stored.subject_id FROM library.collection_kind_subject AS stored,input
  WHERE stored.route=input.route AND stored.account_id=input.account_id
  ORDER BY stored.collection_id,stored.audience,stored.generation,stored.subject_id LIMIT 100
)
DELETE FROM library.collection_kind_subject AS victim USING selected,input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.collection_id=selected.collection_id AND victim.audience=selected.audience AND victim.generation=selected.generation AND victim.subject_id=selected.subject_id
RETURNING true AS removed;
