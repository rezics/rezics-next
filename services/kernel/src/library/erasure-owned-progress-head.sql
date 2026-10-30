-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT subject_id FROM library.progress_head, input
  WHERE library.progress_head.route=input.route AND library.progress_head.account_id=input.account_id
  ORDER BY subject_id LIMIT 100
)
DELETE FROM library.progress_head AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.subject_id=keys.subject_id
RETURNING true AS removed;
