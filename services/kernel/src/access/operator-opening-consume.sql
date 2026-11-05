WITH authority AS (SELECT :at::timestamptz AS at, clock_timestamp() AS observed_at)
UPDATE access.operator_opening_receipt r
SET consumed_at = t.at, consumed_transaction_id = :transaction_id
FROM authority t
WHERE r.route = :route AND r.operator_account_id = :operator_id AND r.receipt_id = :receipt_id
  AND r.subject_account_id = :subject_id AND r.acting_human_id = :human_id
  AND r.purpose = :purpose AND r.action = :action AND r.client_id = :client_id
  AND r.scopes = :scopes::text[] AND r.requested_by IS NOT DISTINCT FROM NULLIF(:requested_by::text, '')
  AND r.human_authn_epoch = :human_epoch AND r.human_epoch_floor = :human_floor
  AND r.operator_epoch_floor = :operator_floor AND r.subject_epoch_floor = :subject_floor
  AND r.relation_version = :version AND r.reservation_id = :reservation_id
  AND r.credential_purpose IS NULL
  AND r.consumed_at IS NULL AND t.at < r.expires_at
  AND t.observed_at < :deadline::timestamptz
  AND :membership_valid::tstzrange @> t.at
RETURNING r.expires_at::text AS "expiresAt";
