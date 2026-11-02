INSERT INTO search.identity_receiving_native_operation
 (partition_no,plan_id,operation_id,hold_id,state,writer_token,writer_transaction_id,writer_position,
 dispatch_transaction_id,writer_locator)
VALUES ($1,$2,$3,$4,'dispatched',$5,$6,$7,$8,$9) RETURNING operation_id;
