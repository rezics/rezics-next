/* search:identity-writer:fence */
INSERT INTO search.identity_writer
  (partition_no,physical_target,original_id,incarnation,owner_epoch,
   dispatch_state,closed_job,closed_epoch,closed_transaction_id,closed_position)
VALUES ($1,$2,$3,$4,$5,'cancelled',$6,$7,$8,$9)
ON CONFLICT (partition_no,physical_target,original_id) DO UPDATE
  SET closed_job=EXCLUDED.closed_job, closed_epoch=EXCLUDED.closed_epoch,
      closed_transaction_id=EXCLUDED.closed_transaction_id, closed_position=EXCLUDED.closed_position
  WHERE identity_writer.closed_job IS NULL AND identity_writer.owner_epoch=EXCLUDED.owner_epoch
    AND identity_writer.incarnation=EXCLUDED.incarnation
RETURNING writer_token;
