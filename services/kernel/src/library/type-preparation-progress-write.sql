WITH native_input AS NOT MATERIALIZED (SELECT :state::text AS state)
INSERT INTO library.type_preparation_progress
(route, account_id, preparation_id, state, type_id, chunk, byte_offset, node_id, enqueue_pending, last_receipt, last_transaction_id)
VALUES (:route::integer, :account_id::uuid, :preparation_id::uuid, (SELECT state FROM native_input), :type_id::nullable(uuid),
 :chunk::bigint, :offset::bigint, :node_id::nullable(uuid), (SELECT state FROM native_input) = 'pending', :receipt::jsonb, :transaction_id::uuid)
ON CONFLICT (route, account_id, preparation_id) DO UPDATE
SET state = EXCLUDED.state, type_id = EXCLUDED.type_id, chunk = EXCLUDED.chunk, byte_offset = EXCLUDED.byte_offset,
 node_id = EXCLUDED.node_id, enqueue_pending = EXCLUDED.enqueue_pending, last_receipt = EXCLUDED.last_receipt,
 last_transaction_id = EXCLUDED.last_transaction_id, updated_at = statement_timestamp();
