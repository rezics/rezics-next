WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT navigation_id FROM library.diary_navigation, input
  WHERE diary_navigation.route=input.route AND diary_navigation.account_id=input.account_id
  ORDER BY navigation_id LIMIT 8
)
DELETE FROM library.diary_navigation victim USING input,keys
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.navigation_id=keys.navigation_id
RETURNING true AS removed;
