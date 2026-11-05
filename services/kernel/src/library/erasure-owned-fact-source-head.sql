-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT fact_source_head.account_id FROM library.fact_source_head, input
  WHERE library.fact_source_head.route=input.route AND library.fact_source_head.account_id=input.account_id
  ORDER BY fact_source_head.account_id LIMIT 100
)
DELETE FROM library.fact_source_head AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.account_id=keys.account_id
RETURNING true AS removed;
