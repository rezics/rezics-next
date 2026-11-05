-- Exact owner parent-frontier locators, bounded independently of assignment fanout.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT label_id FROM library.owner_index_label_repair, input WHERE library.owner_index_label_repair.route=input.route AND library.owner_index_label_repair.account_id=input.account_id
  ORDER BY label_id LIMIT 100
)
DELETE FROM library.owner_index_label_repair victim USING keys,input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.label_id=keys.label_id
RETURNING true AS removed;
