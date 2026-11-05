-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT published_at, log_id FROM library.published_log, input
  WHERE library.published_log.route=input.route AND library.published_log.account_id=input.account_id
  ORDER BY published_at, log_id LIMIT 100
)
DELETE FROM library.published_log AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.published_at=keys.published_at AND victim.log_id=keys.log_id
RETURNING true AS removed;
