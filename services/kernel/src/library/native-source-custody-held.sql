SELECT transaction_id::text AS "transactionId",released FROM library.native_source_hold
WHERE route=:route AND capture_id=:capture_id AND hold_id=:hold_id FOR UPDATE;
