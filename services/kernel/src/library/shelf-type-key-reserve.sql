WITH native_input AS NOT MATERIALIZED (SELECT :full_type::text AS full_type)
INSERT INTO library.shelf_type_reservation
(route, account_id, reservation_id, full_type, input_bytes, digest, candidate_type_id, node_id, byte_offset, fence_id, generation_id)
VALUES (:route::integer, :account_id::uuid, :reservation_id::uuid, (SELECT full_type FROM native_input), convert_to((SELECT full_type FROM native_input), 'UTF8'),
        :digest::bytea, :candidate_type_id::uuid, :node_id::uuid, 0, :fence_id::uuid, :generation_id::uuid);
