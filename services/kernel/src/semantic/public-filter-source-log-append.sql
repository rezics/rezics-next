INSERT INTO semantic.public_filter_privacy_log
  (partition_no, owner_epoch, position, transaction_id, cause, affected, impacts, recorded_at)
VALUES
  (:partition_no::integer, :owner_epoch::integer, :position::bigint, :transaction_id::uuid,
   :cause::text, :affected::jsonb, :impacts::jsonb, :recorded_at::timestamptz)
RETURNING position::text;
