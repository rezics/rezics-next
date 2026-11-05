UPDATE library.shelf_maintenance_source SET reservation_id=:reservation_id::nullable(uuid),type_id=:type_id::nullable(uuid)
 WHERE route=:route::integer AND account_id=:account_id::uuid AND run_id=:run_id::uuid AND subject_id=:subject_id::uuid;
