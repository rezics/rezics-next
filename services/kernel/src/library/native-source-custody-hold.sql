INSERT INTO library.native_source_hold(route,capture_id,hold_id,transaction_id)
VALUES (:route,:capture_id,:hold_id,:transaction_id)
ON CONFLICT (route,capture_id,hold_id) DO UPDATE SET hold_id=EXCLUDED.hold_id
WHERE NOT library.native_source_hold.released AND library.native_source_hold.transaction_id=EXCLUDED.transaction_id
RETURNING transaction_id::text AS "transactionId",released;
