UPDATE library.shelf_type_reservation SET maintenance_run_id=:run_id::uuid WHERE route=:route::integer AND account_id=:account_id::uuid AND reservation_id=:reservation_id::uuid
 AND generation_id=:generation::uuid AND maintenance_run_id IS NULL RETURNING reservation_id;
