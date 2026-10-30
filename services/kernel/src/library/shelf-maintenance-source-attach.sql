UPDATE library.entry SET type_id=:type_id::uuid,type_source_id=:source_id::uuid,type_source_partition=:source_partition::integer,
 type_source_epoch=:source_epoch::integer,type_source_position=:source_position::bigint WHERE route=:route::integer AND account_id=:account_id::uuid AND subject_id=:subject_id::uuid
 AND incarnation_id=:incarnation_id::uuid AND transaction_id=:transaction_id::uuid RETURNING subject_id;
