WITH parameters AS (SELECT $1::integer p1)
INSERT INTO semantic.identity_epoch_bootstrap_basis
(partition_no,source_partition,source_generation,source_transaction_id,transaction_id,native_epoch,native_position)
SELECT (SELECT p1 FROM parameters),$2,$3,$4,c.transaction_id,c.epoch,c.position
FROM semantic.identity_epoch_native_commit c WHERE c.partition_no=(SELECT p1 FROM parameters) AND c.transaction_id=$5 AND c.purpose='bootstrap';
