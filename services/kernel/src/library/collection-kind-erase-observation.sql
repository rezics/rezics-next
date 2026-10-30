WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,:account_id::uuid AS account_id
), selected AS MATERIALIZED (
  SELECT stored.collection_id,stored.audience FROM library.collection_kind_observation AS stored,input
  WHERE stored.route=input.route AND stored.account_id=input.account_id
  ORDER BY stored.collection_id,stored.audience LIMIT 100
)
DELETE FROM library.collection_kind_observation AS victim USING selected,input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.collection_id=selected.collection_id AND victim.audience=selected.audience
RETURNING true AS removed;
