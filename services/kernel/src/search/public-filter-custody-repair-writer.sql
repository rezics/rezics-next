SELECT writer_token,dispatch_state,closed_job,repair_locator,repair_action,repair_receipt,
  owner_epoch,incarnation,source_position,visible_position,visible_transaction_id,
  settled_position,settled_transaction_id,writer_transaction_id,writer_position
FROM search.identity_writer
WHERE partition_no=:partition_no::integer AND physical_target=:physical_target::text AND original_id=:original_id::uuid FOR SHARE;
