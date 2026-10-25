WITH authority AS (SELECT :at::timestamptz AS at, clock_timestamp() AS observed_at)
INSERT INTO access.operator_opening_receipt
  (route, operator_account_id, receipt_id, subject_account_id, acting_human_id,
   purpose, action, client_id, scopes, requested_by, human_authn_epoch,
   human_epoch_floor, operator_epoch_floor, subject_epoch_floor, relation_version,
   reservation_id, created_at, expires_at, transaction_id)
SELECT :route, :operator_id, :receipt_id, :subject_id, :human_id,
       :purpose, :action, :client_id, :scopes::text[], NULLIF(:requested_by::text, ''), :human_epoch,
       :human_floor, :operator_floor, :subject_floor, :version,
       :reservation_id, t.at, t.at + interval '60 seconds', :transaction_id
FROM authority t
WHERE t.observed_at < :deadline::timestamptz AND :membership_valid::tstzrange @> t.at
RETURNING expires_at::text AS "expiresAt";
