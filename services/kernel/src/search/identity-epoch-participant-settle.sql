/* search:identity-writer:settle */
WITH input AS (
  SELECT $1::integer AS partition_no, $2::text AS physical_target, $3::text AS incarnation,
    $4::integer AS owner_epoch, $5::uuid AS writer_token, $6::uuid AS writer_transaction_id,
    $7::bigint AS writer_position, $8::uuid[] AS ids,
    $9::uuid AS settled_transaction_id, $10::bigint AS settled_position, $11::bigint AS source_position
)
UPDATE search.identity_writer AS writer SET writer_token=NULL,
  settled_transaction_id=input.settled_transaction_id, settled_position=input.settled_position,
  visible_transaction_id=CASE WHEN input.source_position IS NULL THEN writer.visible_transaction_id ELSE input.settled_transaction_id END,
  visible_position=CASE WHEN input.source_position IS NULL THEN writer.visible_position ELSE input.settled_position END,
  source_position=COALESCE(input.source_position,writer.source_position),
  dispatch_state=CASE WHEN input.source_position IS NULL THEN 'cancelled' ELSE 'settled' END
FROM input
WHERE writer.partition_no=input.partition_no AND writer.physical_target=input.physical_target
  AND writer.incarnation=input.incarnation AND writer.owner_epoch=input.owner_epoch
  AND writer.writer_token=input.writer_token AND writer.writer_transaction_id=input.writer_transaction_id
  AND writer.writer_position=input.writer_position AND writer.original_id=ANY(input.ids)
  AND ((input.source_position IS NULL AND writer.dispatch_state='enrolled')
    OR (input.source_position IS NOT NULL AND writer.dispatch_state='dispatched'))
RETURNING writer.original_id;
