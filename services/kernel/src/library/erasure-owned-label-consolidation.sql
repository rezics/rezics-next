-- Repeated deletion of the first remaining keyset advances without offsets.
-- A consolidation has at most sixteen child items, removed by the parent cascade.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT consolidation_id FROM library.label_consolidation, input
  WHERE library.label_consolidation.route=input.route AND library.label_consolidation.account_id=input.account_id
  ORDER BY consolidation_id LIMIT 100
)
DELETE FROM library.label_consolidation AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.consolidation_id=keys.consolidation_id
RETURNING true AS removed;
