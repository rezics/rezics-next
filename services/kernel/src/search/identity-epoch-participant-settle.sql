/* search:identity-writer:settle */
WITH input AS (
  SELECT $1::integer AS partition_no, $2::text AS physical_target, $3::text AS incarnation,
    $4::integer AS owner_epoch, $5::uuid AS writer_token, $6::uuid AS writer_transaction_id,
    $7::bigint AS writer_position, $8::uuid[] AS ids,
    $9::uuid AS settled_transaction_id, $10::bigint AS settled_position, $11::bigint AS source_position
), settled AS (
  UPDATE search.identity_writer AS writer SET writer_token=NULL,
    settled_transaction_id=input.settled_transaction_id, settled_position=input.settled_position,
    source_position=input.source_position
  FROM input
  WHERE writer.partition_no=input.partition_no AND writer.physical_target=input.physical_target
    AND writer.incarnation=input.incarnation AND writer.owner_epoch=input.owner_epoch
    AND writer.writer_token=input.writer_token AND writer.writer_transaction_id=input.writer_transaction_id
    AND writer.writer_position=input.writer_position
    AND writer.original_id=ANY(input.ids) AND writer.closed_job IS NOT NULL
  RETURNING writer.original_id
), cleared AS (
  DELETE FROM search.identity_writer AS writer USING input
  WHERE writer.partition_no=input.partition_no AND writer.physical_target=input.physical_target
    AND writer.incarnation=input.incarnation AND writer.owner_epoch=input.owner_epoch
    AND writer.writer_token=input.writer_token AND writer.writer_transaction_id=input.writer_transaction_id
    AND writer.writer_position=input.writer_position
    AND writer.original_id=ANY(input.ids) AND writer.closed_job IS NULL
  RETURNING writer.original_id
)
SELECT original_id FROM settled UNION ALL SELECT original_id FROM cleared;
