SELECT key.original_id::text,writer.* FROM jsonb_to_recordset(:subjects::jsonb) AS key(partition_no integer,original_id uuid)
JOIN LATERAL (
  SELECT writer_token,dispatch_state,closed_job,repair_locator,repair_action,repair_receipt,
    owner_epoch,incarnation,source_position,visible_position,visible_transaction_id,
    settled_position,settled_transaction_id,writer_transaction_id,writer_position
  FROM search.identity_writer AS w
  WHERE (w.partition_no,w.physical_target,w.original_id)=(key.partition_no,:physical_target::text,key.original_id)
  FOR SHARE
) writer ON true ORDER BY key.partition_no,key.original_id;
