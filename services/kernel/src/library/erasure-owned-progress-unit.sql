WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :parent_id::uuid AS parent_id
), keys AS MATERIALIZED (
  SELECT child.unit_id FROM library.progress_unit AS child, input
  WHERE child.route=input.route AND child.session_id=input.parent_id
    AND EXISTS (SELECT 1 FROM library.progress_session AS parent
                WHERE parent.route=input.route AND parent.account_id=input.account_id AND parent.session_id=input.parent_id)
  ORDER BY child.unit_id LIMIT 100
)
DELETE FROM library.progress_unit AS victim USING keys, input
WHERE victim.route=input.route AND victim.session_id=input.parent_id AND victim.unit_id=keys.unit_id
RETURNING true AS removed;
