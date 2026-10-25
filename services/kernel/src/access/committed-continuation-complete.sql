UPDATE access.committed_continuation
SET completions = completions || jsonb_build_array(jsonb_build_object(
  'step', :step::text, 'target', :target::text, 'key', :key::text, 'digest', :digest::text, 'receiptId', :receipt_id::text
))
WHERE route = :route AND continuation_id = :continuation_id AND expires_at > :at::timestamptz
RETURNING continuation_id AS "continuationId";
