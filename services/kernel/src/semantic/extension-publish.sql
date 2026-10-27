INSERT INTO semantic.context_extension (route, context_id, digest, body, recorded_transaction_id)
VALUES (:route::integer, :context_id::uuid, :digest::text, :body::jsonb, :transaction_id::uuid)
ON CONFLICT (route, context_id, digest) DO NOTHING
RETURNING digest;
