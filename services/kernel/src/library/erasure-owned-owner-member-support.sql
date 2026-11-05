-- Fixed owner prefix, 100 keys including all structural pin dimensions, no payload in work arguments.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT subject_id,family,pin FROM library.owner_member_support, input WHERE library.owner_member_support.route=input.route AND library.owner_member_support.account_id=input.account_id
  ORDER BY subject_id,family,pin LIMIT 100
)
DELETE FROM library.owner_member_support victim USING keys,input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.subject_id=keys.subject_id AND victim.family=keys.family AND victim.pin=keys.pin
RETURNING true AS removed;
