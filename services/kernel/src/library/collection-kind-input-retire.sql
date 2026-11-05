-- Only the locked predecessor, after exact readback of the successor in this transaction.
DELETE FROM library.collection_kind_raw_input
WHERE route=:route::integer AND origin_id=:origin_id::text
  AND input_id=:input_id::text;
