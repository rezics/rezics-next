/* search:identity-writer:enroll */
INSERT INTO search.identity_writer
  (partition_no,physical_target,original_id,incarnation,owner_epoch,
   writer_token,writer_transaction_id,writer_position)
SELECT $1,$2,id,$3,$4,$5,$6,$7 FROM unnest($8::uuid[]) AS input(id)
ON CONFLICT (partition_no,physical_target,original_id) DO UPDATE
  SET incarnation=EXCLUDED.incarnation, writer_token=EXCLUDED.writer_token,
      writer_transaction_id=EXCLUDED.writer_transaction_id, writer_position=EXCLUDED.writer_position,
      dispatch_state='enrolled'
  WHERE identity_writer.writer_token IS NULL AND identity_writer.closed_job IS NULL
    AND identity_writer.owner_epoch=EXCLUDED.owner_epoch
    AND identity_writer.incarnation=EXCLUDED.incarnation
RETURNING original_id;
