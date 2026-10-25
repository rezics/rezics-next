WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :expected_head::integer AS expected_head, :digest::text AS digest, :transaction_id::uuid AS transaction_id
)
INSERT INTO presentation.profile_activation (route, head, digest, recorded_transaction_id)
SELECT input.route, input.expected_head + 1, input.digest, input.transaction_id
FROM input
WHERE COALESCE((
  SELECT head FROM presentation.profile_activation WHERE route = input.route ORDER BY head DESC LIMIT 1
), 0) = input.expected_head
ON CONFLICT (route, head) DO NOTHING
RETURNING head;
