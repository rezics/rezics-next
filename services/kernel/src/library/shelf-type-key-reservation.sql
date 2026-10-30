SELECT reservation_id::text AS "reservationId", node_id::text AS "nodeId", byte_offset::text AS offset,
       octet_length(input_bytes)::text AS length, candidate_type_id::text AS "candidateId",
       fence_id::text AS "fenceId", generation_id::text AS "generationId"
FROM library.shelf_type_reservation
WHERE route = :route::integer AND account_id = :account_id::uuid AND reservation_id = :reservation_id::uuid
  AND input_bytes IS NOT NULL
FOR UPDATE;
