-- Fixed owner prefix, 100 keys including all structural pin dimensions, no payload in work arguments.
WITH keys AS MATERIALIZED (
  SELECT account_id FROM library.owner_index_control WHERE route=:route AND account_id=:account_id
  ORDER BY account_id LIMIT 100
)
DELETE FROM library.owner_index_control victim USING keys
WHERE victim.route=:route AND victim.account_id=:account_id AND victim.account_id=keys.account_id
RETURNING true AS removed;
