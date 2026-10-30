-- Raw first-remaining frontier. Never filter uncommitted release out of scan exhaustion.
SELECT hold_id::text AS id, transaction_id::text AS "transactionId", released,
 xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid AS committed
FROM library.native_source_hold WHERE route=:route AND capture_id=:capture_id
ORDER BY hold_id LIMIT 80 FOR UPDATE;
