WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no, :transaction_id::uuid AS transaction_id, :receipt::jsonb AS receipt
),
observed AS MATERIALIZED (
  SELECT p.partition_no, p.epoch, p.position
  FROM core.partition AS p CROSS JOIN input
  WHERE p.partition_no = input.partition_no AND p.write_state = 'active'
  FOR SHARE OF p
),
receipt_write AS (
  INSERT INTO core.receipt (
    partition_no, principal_kind, principal_id, command_kind, idempotency_key, request_digest,
    epoch, position, transaction_id, response
  )
  SELECT input.partition_no, input.receipt->'principal'->>'kind',
         (input.receipt->'principal'->>'id')::uuid, input.receipt->>'kind',
         input.receipt->>'key', decode(input.receipt->>'digest', 'base64'), observed.epoch, observed.position,
         input.transaction_id, input.receipt->'response'
  FROM input CROSS JOIN observed
  WHERE input.receipt IS NOT NULL
  RETURNING partition_no
)
SELECT epoch, position FROM observed;
