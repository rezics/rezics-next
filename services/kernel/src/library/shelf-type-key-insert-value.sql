WITH native_input AS NOT MATERIALIZED (SELECT :full_type::text AS full_type)
INSERT INTO library.shelf_type_value(route, account_id, type_id, full_type, byte_length, json_byte_length)
VALUES (:route::integer, :account_id::uuid, :type_id::uuid, (SELECT full_type FROM native_input),
        octet_length((SELECT full_type FROM native_input)), octet_length(to_json((SELECT full_type FROM native_input))::text))
ON CONFLICT (route, account_id, type_id) DO NOTHING
RETURNING type_id::text AS "typeId";
