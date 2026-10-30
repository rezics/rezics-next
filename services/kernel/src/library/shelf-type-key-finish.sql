DELETE FROM library.shelf_type_reservation
WHERE route = :route::integer AND account_id = :account_id::uuid AND reservation_id = :reservation_id::uuid;
