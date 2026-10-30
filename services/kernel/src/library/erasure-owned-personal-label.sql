-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT label_id FROM library.personal_label, input
  WHERE library.personal_label.route=input.route AND library.personal_label.account_id=input.account_id
  ORDER BY label_id LIMIT 100
)
DELETE FROM library.personal_label AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.label_id=keys.label_id
RETURNING true AS removed;
