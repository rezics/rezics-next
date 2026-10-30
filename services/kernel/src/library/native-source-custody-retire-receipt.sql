SELECT transaction_id::text AS "transactionId" FROM library.native_source_receipt
WHERE route=:route AND capture_id=:capture_id FOR UPDATE;
