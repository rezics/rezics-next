-- receipt.key is the current versioned HMAC storage token, never caller text.
WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no, :events::jsonb AS events, :transaction_id::uuid AS transaction_id,
         :basis::jsonb AS basis, :receipt::jsonb AS receipt
),
fence AS (
  UPDATE core.partition
  SET position = position + 1
  FROM input
  WHERE core.partition.partition_no = input.partition_no AND write_state = 'active'
  RETURNING core.partition.partition_no, core.partition.epoch, core.partition.position
),
append AS (
  INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
  SELECT input.partition_no, fence.position, event.ordinality - 1, jsonb_array_length(input.events), fence.epoch,
         (event.value->>'id')::uuid, event.value->>'type', event.value->>'subject', event.value->'data'
  FROM input CROSS JOIN fence
  CROSS JOIN LATERAL jsonb_array_elements(input.events) WITH ORDINALITY AS event(value, ordinality)
  RETURNING partition_no
),
basis_write AS (
  INSERT INTO editorial.write_basis (
    partition_no, transaction_id, epoch, position, principal_kind, principal_id, client_id, requested_by
  )
  SELECT input.partition_no, input.transaction_id, fence.epoch, fence.position,
         input.basis->'principal'->>'kind', (input.basis->'principal'->>'id')::uuid,
         input.basis->>'clientId', input.basis->>'requestedBy'
  FROM input CROSS JOIN fence
  WHERE input.basis IS NOT NULL
  RETURNING partition_no
),
receipt_write AS (
  INSERT INTO core.receipt (
    partition_no, principal_kind, principal_id, command_kind, idempotency_key, request_digest,
    epoch, position, transaction_id, response
  )
  SELECT input.partition_no, input.receipt->'principal'->>'kind',
         (input.receipt->'principal'->>'id')::uuid, input.receipt->>'kind',
         input.receipt->>'key', decode(input.receipt->>'digest', 'base64'), fence.epoch, fence.position,
         input.transaction_id, input.receipt->'response'
  FROM input CROSS JOIN fence
  WHERE input.receipt IS NOT NULL
  RETURNING partition_no
)
SELECT epoch, position FROM fence;
