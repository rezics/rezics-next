UPDATE semantic.identity_epoch_bootstrap_home h
SET sealed_transaction_id=c.transaction_id,sealed_epoch=c.epoch,sealed_position=c.position
FROM semantic.identity_epoch_native_commit c
WHERE h.partition_no=$1 AND c.partition_no=h.partition_no AND c.transaction_id=$2
  AND h.sealed_generation IS NOT NULL AND NOT h.needs_work AND c.purpose='bootstrap'
RETURNING h.sealed_generation;
