SELECT substring(input_bytes FROM :offset::integer + 1 FOR :length::integer) AS chunk
FROM library.shelf_type_reservation
WHERE route = :route::integer AND account_id = :account_id::uuid AND reservation_id = :reservation_id::uuid;
