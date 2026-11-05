WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :parent_id::uuid AS parent_id
), keys AS MATERIALIZED (
  SELECT child.member_id FROM library.collection_member AS child, input
  WHERE child.route=input.route AND child.collection_id=input.parent_id
    AND EXISTS (SELECT 1 FROM library.collection AS parent
                WHERE parent.route=input.route AND parent.curator_account_id=input.account_id AND parent.collection_id=input.parent_id)
  ORDER BY child.member_id LIMIT 100
)
DELETE FROM library.collection_member AS victim USING keys, input
WHERE victim.route=input.route AND victim.collection_id=input.parent_id AND victim.member_id=keys.member_id
RETURNING true AS removed;
