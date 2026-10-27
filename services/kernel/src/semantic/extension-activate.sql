WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :context_id::uuid AS context_id, :expected_head::integer AS expected_head,
    :digest::text AS digest, :transaction_id::uuid AS transaction_id
)
INSERT INTO semantic.context_extension_activation (route, context_id, head, digest, recorded_transaction_id)
SELECT input.route, input.context_id, input.expected_head + 1, input.digest, input.transaction_id
FROM input
WHERE COALESCE((
  SELECT head FROM semantic.context_extension_activation
  WHERE route = input.route AND context_id = input.context_id ORDER BY head DESC LIMIT 1
), 0) = input.expected_head
ON CONFLICT (route, context_id, head) DO NOTHING
RETURNING head;
