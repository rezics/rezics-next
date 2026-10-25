INSERT INTO semantic.definition_release (route, digest, body, recorded_transaction_id)
VALUES (:route::integer, :digest::text, :body::jsonb, :transaction_id::uuid)
ON CONFLICT (route, digest) DO NOTHING
RETURNING digest;
