WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT o.owner_account_id FROM library.members_preparation_owner AS o, input
  WHERE o.route = input.route AND o.owner_account_id = input.account_id
    AND NOT EXISTS (SELECT 1 FROM library.members_preparation AS h
      WHERE h.route = input.route AND h.owner_account_id = input.account_id)
  ORDER BY o.owner_account_id LIMIT 100
)
DELETE FROM library.members_preparation_owner AS victim USING keys, input
WHERE victim.route = input.route AND victim.owner_account_id = input.account_id
  AND victim.owner_account_id = keys.owner_account_id
RETURNING true AS removed;
