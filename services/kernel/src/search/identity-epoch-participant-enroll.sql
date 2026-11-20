/* search:identity-writer:enroll */
INSERT INTO search.identity_writer
  (partition_no,physical_target,original_id,incarnation,owner_epoch,
   writer_token,writer_transaction_id,writer_position)
SELECT $1,$2,id,$3,$4,$5,$6,$7 FROM unnest($8::uuid[]) AS input(id)
ON CONFLICT (partition_no,physical_target,original_id) DO UPDATE
  SET incarnation=EXCLUDED.incarnation, writer_token=EXCLUDED.writer_token,
      writer_transaction_id=EXCLUDED.writer_transaction_id, writer_position=EXCLUDED.writer_position,
      dispatch_state='enrolled'
  WHERE identity_writer.closed_job IS NULL
    AND identity_writer.owner_epoch=EXCLUDED.owner_epoch
    AND identity_writer.incarnation=EXCLUDED.incarnation
    AND (
      identity_writer.writer_token IS NULL
      OR (
        $9::boolean AND identity_writer.dispatch_state='enrolled' AND identity_writer.repair_locator IS NULL
        AND EXISTS (
          SELECT 1 FROM core.outbox AS enrollment
          WHERE enrollment.partition_no=identity_writer.partition_no
            AND enrollment.position=identity_writer.writer_position AND enrollment.event_seq=0
            AND enrollment.epoch=identity_writer.owner_epoch
            AND enrollment.type='com.rezics.search.identity_writer.changed.v1'
            AND enrollment.recorded_at <= statement_timestamp() - interval '30 seconds'
        )
      )
    )
RETURNING original_id;
