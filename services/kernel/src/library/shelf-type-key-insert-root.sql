WITH native_input AS NOT MATERIALIZED (SELECT :route::integer AS route, :account_id::uuid AS account_id, :node_id::uuid AS node_id)
INSERT INTO library.shelf_type_root(route, account_id, digest, primary_type_id, root_node_id)
SELECT (SELECT route FROM native_input), (SELECT account_id FROM native_input), :digest::bytea, :type_id::uuid, (SELECT node_id FROM native_input)
WHERE NOT EXISTS (SELECT FROM library.shelf_type_node
  WHERE route = (SELECT route FROM native_input) AND account_id = (SELECT account_id FROM native_input) AND node_id = (SELECT node_id FROM native_input))
ON CONFLICT DO NOTHING RETURNING root_node_id;
