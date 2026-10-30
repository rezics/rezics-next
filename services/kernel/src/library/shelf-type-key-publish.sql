WITH native_input AS NOT MATERIALIZED (SELECT :route::integer AS route, :account_id::uuid AS account_id, :node_id::uuid AS node_id), accepted AS MATERIALIZED (
  SELECT full_type FROM library.shelf_type_reservation
  WHERE route = (SELECT route FROM native_input) AND account_id = (SELECT account_id FROM native_input) AND reservation_id = :reservation_id::uuid
    AND byte_offset = octet_length(input_bytes)
), terminal AS MATERIALIZED (
  SELECT terminal_type_id FROM library.shelf_type_node
  WHERE route = (SELECT route FROM native_input) AND account_id = (SELECT account_id FROM native_input) AND node_id = (SELECT node_id FROM native_input)
  FOR UPDATE
), inserted AS (
  INSERT INTO library.shelf_type_value(route, account_id, type_id, full_type, byte_length, json_byte_length)
  SELECT (SELECT route FROM native_input), (SELECT account_id FROM native_input), :type_id::uuid, full_type, octet_length(full_type), octet_length(to_json(full_type)::text)
  FROM accepted WHERE EXISTS (SELECT FROM terminal WHERE terminal_type_id IS NULL)
  ON CONFLICT (route, account_id, type_id) DO NOTHING RETURNING type_id
), published AS (
  UPDATE library.shelf_type_node SET terminal_type_id = inserted.type_id
  FROM inserted WHERE route = (SELECT route FROM native_input) AND account_id = (SELECT account_id FROM native_input) AND node_id = (SELECT node_id FROM native_input) AND terminal_type_id IS NULL
  RETURNING terminal_type_id
)
SELECT terminal_type_id::text AS "typeId" FROM published
UNION ALL
SELECT v.type_id::text FROM terminal AS t
JOIN library.shelf_type_value AS v ON v.route = (SELECT route FROM native_input) AND v.account_id = (SELECT account_id FROM native_input) AND v.type_id = t.terminal_type_id
WHERE v.full_type COLLATE "C" = (SELECT full_type FROM accepted) COLLATE "C";
