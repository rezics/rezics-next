INSERT INTO access.committed_continuation_completion (route, continuation_id, step, target, key, digest, receipt_id)
VALUES (:route, :continuation_id, :step, :target, :key, :digest, :receipt_id)
ON CONFLICT (route, continuation_id, step, target, key) DO NOTHING;
