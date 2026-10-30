-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT subject_id, label_id FROM library.label_assignment, input
  WHERE library.label_assignment.route=input.route AND library.label_assignment.account_id=input.account_id
  ORDER BY subject_id, label_id LIMIT 100
)
DELETE FROM library.label_assignment AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.subject_id=keys.subject_id AND victim.label_id=keys.label_id
RETURNING true AS removed;
