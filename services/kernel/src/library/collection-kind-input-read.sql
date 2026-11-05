-- The origin/observation/consumer locks are already held by the native admission.
-- The ordered primary key permits only two exact predecessor/current records.
SELECT input_id AS "inputId", observation_version::text AS version, predecessor, body,
       native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned() AS committed
FROM library.collection_kind_raw_input
WHERE route=:route::integer AND origin_id=:origin_id::text
  AND preparation_id=:preparation_id::uuid
ORDER BY observation_version DESC
LIMIT 2 FOR UPDATE;
