-- Exact owner parent-frontier locators, bounded independently of assignment fanout.
WITH keys AS MATERIALIZED (
  SELECT label_id FROM library.owner_index_label_repair WHERE route=:route AND account_id=:account_id
  ORDER BY label_id LIMIT 100
)
DELETE FROM library.owner_index_label_repair victim USING keys
WHERE victim.route=:route AND victim.account_id=:account_id AND victim.label_id=keys.label_id
RETURNING true AS removed;
