SELECT reservation_id FROM library.shelf_type_reservation WHERE route=:route::integer AND account_id=:account_id::uuid AND reservation_id=:reservation_id::uuid
 AND maintenance_run_id=:run_id::uuid AND generation_id=:generation::uuid;
