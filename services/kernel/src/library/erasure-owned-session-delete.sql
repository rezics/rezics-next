WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :parent_id::uuid AS parent_id
)
DELETE FROM library.progress_session AS victim USING input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.session_id=input.parent_id
  AND NOT EXISTS (SELECT 1 FROM library.progress_unit WHERE route=input.route AND session_id=input.parent_id)
  AND NOT EXISTS (SELECT 1 FROM library.progress_change WHERE route=input.route AND session_id=input.parent_id)
  AND NOT EXISTS (SELECT 1 FROM library.progress_episode WHERE route=input.route AND session_id=input.parent_id)
RETURNING true AS removed;
