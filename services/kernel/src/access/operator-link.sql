WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id,
         :operator_id::uuid AS operator_id, :reservation_id::uuid AS reservation_id,
         NULLIF(:old_operator_id::text, '')::uuid AS old_operator_id,
         :version::bigint AS version, :transaction_id::uuid AS transaction_id,
         :deadline::timestamptz AS deadline
), counter_time AS MATERIALIZED (
  -- The account projection trigger uses exactly this command's T. The setting
  -- is transaction-local and is discarded on both commit and rollback.
  SELECT set_config('rezics.operator_at', :at::text, true)
), slot AS (
  INSERT INTO access.operator_relation_slot
    (route, subject_account_id, reservation_id, operator_account_id, terminal, transaction_id)
  SELECT route, subject_id, reservation_id, operator_id, false, transaction_id FROM input
  ON CONFLICT (route, subject_account_id, reservation_id) DO NOTHING
)
UPDATE access.account a
SET operator_account_id = i.operator_id, operator_reservation_id = i.reservation_id,
    transaction_id = i.transaction_id
FROM input i CROSS JOIN counter_time
WHERE a.route = i.route AND a.account_id = i.subject_id
  AND a.operator_account_id IS NOT DISTINCT FROM i.old_operator_id
  AND a.operator_relation_version = i.version AND clock_timestamp() < i.deadline
RETURNING a.operator_relation_version::text AS version;
