SELECT step,version,scope_digest,progress,native_partition,native_epoch,
  native_position::text,native_transaction_id
FROM semantic.identity_epoch_ack
WHERE partition_no=$1 AND job_id=$2
  AND step=ANY(ARRAY['mapping','search-canonical-index','library-private-follow-counts']);
