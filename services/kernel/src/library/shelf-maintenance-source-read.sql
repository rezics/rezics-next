SELECT subject_id AS "subjectId",incarnation_id AS "incarnationId",transaction_id AS "transactionId",source_id AS "sourceId",
 source_partition AS "sourcePartition",source_epoch AS "sourceEpoch",source_position AS "sourcePosition",identity,origin_identity AS "originIdentity",
 reservation_id AS "reservationId",type_id AS "typeId" FROM library.shelf_maintenance_source WHERE route=:route::integer AND account_id=:account_id::uuid AND run_id=:run_id::uuid AND subject_id=:subject_id::uuid;
