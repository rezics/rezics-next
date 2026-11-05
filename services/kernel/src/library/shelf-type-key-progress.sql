WITH native_input AS NOT MATERIALIZED (SELECT :next_offset::bigint AS next_offset, :previous_offset::bigint AS previous_offset)
UPDATE library.shelf_type_reservation
SET node_id = :node_id::uuid, byte_offset = (SELECT next_offset FROM native_input)
WHERE route = :route::integer AND account_id = :account_id::uuid AND reservation_id = :reservation_id::uuid
  AND byte_offset = (SELECT previous_offset FROM native_input) AND (SELECT next_offset FROM native_input) >= (SELECT previous_offset FROM native_input)
RETURNING reservation_id;
