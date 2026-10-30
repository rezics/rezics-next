-- Fixed owner prefix, 100 keys including all structural pin dimensions, no payload in work arguments.
WITH keys AS MATERIALIZED (
  SELECT subject_id FROM library.owner_member_index WHERE route=:route AND account_id=:account_id
  ORDER BY subject_id LIMIT 100
)
DELETE FROM library.owner_member_index victim USING keys
WHERE victim.route=:route AND victim.account_id=:account_id AND victim.subject_id=keys.subject_id
RETURNING true AS removed;
