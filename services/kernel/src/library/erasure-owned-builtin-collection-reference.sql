-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT profile_id, state_set_id, state_id FROM library.builtin_collection_reference, input
  WHERE library.builtin_collection_reference.route=input.route AND library.builtin_collection_reference.account_id=input.account_id
  ORDER BY profile_id, state_set_id, state_id LIMIT 100
)
DELETE FROM library.builtin_collection_reference AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.profile_id=keys.profile_id AND victim.state_set_id=keys.state_set_id AND victim.state_id=keys.state_id
RETURNING true AS removed;
