/* search:identity-writer:settle */
UPDATE search.identity_writer SET writer_token=NULL,
  settled_transaction_id=$9, settled_position=$10,
  visible_transaction_id=CASE WHEN $11::bigint IS NULL THEN visible_transaction_id ELSE $9 END,
  visible_position=CASE WHEN $11::bigint IS NULL THEN visible_position ELSE $10 END,
  source_position=COALESCE($11::bigint,source_position),
  dispatch_state=CASE WHEN $11::bigint IS NULL THEN 'cancelled' ELSE 'settled' END
WHERE partition_no=$1 AND physical_target=$2 AND incarnation=$3 AND owner_epoch=$4
  AND writer_token=$5 AND writer_transaction_id=$6 AND writer_position=$7
  AND original_id=ANY($8::uuid[])
  AND (($11::bigint IS NULL AND dispatch_state='enrolled')
    OR ($11::bigint IS NOT NULL AND dispatch_state='dispatched'))
RETURNING original_id;
