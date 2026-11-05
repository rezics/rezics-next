-- Fixed owner prefix, 100 keys including all structural pin dimensions, no payload in work arguments.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT subject_id FROM library.owner_member_index, input WHERE library.owner_member_index.route=input.route AND library.owner_member_index.account_id=input.account_id
  ORDER BY subject_id LIMIT 100
)
DELETE FROM library.owner_member_index victim USING keys,input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.subject_id=keys.subject_id
RETURNING true AS removed;
