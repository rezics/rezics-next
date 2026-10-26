INSERT INTO access.committed_continuation_completion
  (route, continuation_id, step, target, key, digest, receipt_id, receipt_key, receipt_digest)
VALUES (:route, :continuation_id, :step, :target, :key, :digest, :receipt_id, :receipt_key, :receipt_digest)
ON CONFLICT (route, continuation_id, step, target, key) DO NOTHING;
