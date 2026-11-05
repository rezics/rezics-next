INSERT INTO library.shelf_maintenance_source(route,account_id,run_id,subject_id,incarnation_id,transaction_id,source_id,source_partition,
 source_epoch,source_position,identity,origin_identity,reservation_id,type_id)
 VALUES(:route::integer,:account_id::uuid,:run_id::uuid,:subject_id::uuid,:incarnation_id::uuid,:transaction_id::uuid,:source_id::uuid,
 :source_partition::integer,:source_epoch::integer,:source_position::bigint,:identity::jsonb,:origin_identity::jsonb,:reservation_id::nullable(uuid),:type_id::nullable(uuid));
