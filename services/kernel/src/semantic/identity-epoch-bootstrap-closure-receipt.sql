SELECT h.sealed_generation,h.sealed_transaction_id,h.sealed_epoch,h.sealed_position
FROM semantic.identity_epoch_bootstrap_home h
JOIN semantic.identity_epoch_native_commit c
ON (c.partition_no,c.transaction_id,c.epoch,c.position)=(h.partition_no,h.sealed_transaction_id,h.sealed_epoch,h.sealed_position)
WHERE h.partition_no=$1 AND NOT h.needs_work AND h.sealed_generation IS NOT NULL
  AND c.purpose='bootstrap' AND h.xmin=c.xmin;
