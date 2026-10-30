WITH native_input AS NOT MATERIALIZED (SELECT :route::integer AS route, :account_id::uuid AS account_id, :node_id::uuid AS node_id)
INSERT INTO library.shelf_type_node(route, account_id, node_id, parent_id, chunk)
SELECT (SELECT route FROM native_input), (SELECT account_id FROM native_input), (SELECT node_id FROM native_input), :parent_id::uuid, :chunk::bytea
WHERE NOT EXISTS (SELECT FROM library.shelf_type_root
  WHERE route = (SELECT route FROM native_input) AND account_id = (SELECT account_id FROM native_input) AND root_node_id = (SELECT node_id FROM native_input))
ON CONFLICT DO NOTHING;
