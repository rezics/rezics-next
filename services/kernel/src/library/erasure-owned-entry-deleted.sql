-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
-- Registers outlive ordinary Undo expiry and are drained only by this terminal owner phase.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT * FROM (
    (SELECT 0 AS driver, deletion_id AS key FROM library.entry_deleted, input
     WHERE library.entry_deleted.route=input.route AND library.entry_deleted.account_id=input.account_id
     ORDER BY deletion_id LIMIT 100)
    UNION ALL
    (SELECT 1 AS driver, subject_id AS key FROM library.entry_clear, input
     WHERE library.entry_clear.route=input.route AND library.entry_clear.account_id=input.account_id
     ORDER BY subject_id LIMIT 100)
  ) raw ORDER BY driver, key LIMIT 100
), deleted AS (
  DELETE FROM library.entry_deleted AS victim USING keys, input
  WHERE keys.driver=0 AND victim.route=input.route AND victim.account_id=input.account_id
    AND victim.deletion_id=keys.key
  RETURNING true AS removed
), cleared AS (
  DELETE FROM library.entry_clear AS victim USING keys, input
  WHERE keys.driver=1 AND victim.route=input.route AND victim.account_id=input.account_id
    AND victim.subject_id=keys.key
  RETURNING true AS removed
)
SELECT removed FROM deleted UNION ALL SELECT removed FROM cleared;
