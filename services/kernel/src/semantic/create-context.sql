INSERT INTO semantic.context (route, context_id, kind, labels, recorded_transaction_id)
VALUES (:route::integer, :context_id::uuid, 'community', :labels::jsonb, :transaction_id::uuid);
