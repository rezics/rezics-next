-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT subject_id FROM library.builtin_state_reference_source, input
  WHERE library.builtin_state_reference_source.route=input.route AND library.builtin_state_reference_source.account_id=input.account_id
  ORDER BY subject_id LIMIT 100
)
DELETE FROM library.builtin_state_reference_source AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.subject_id=keys.subject_id
RETURNING true AS removed;
