SELECT state, type_id::text AS "typeId", chunk::text AS chunk, byte_offset::text AS offset,
       node_id::text AS "nodeId", last_receipt AS receipt, last_transaction_id::text AS "transactionId"
FROM library.type_preparation_progress
WHERE route = :route::integer AND account_id = :account_id::uuid AND preparation_id = :preparation_id::uuid;
