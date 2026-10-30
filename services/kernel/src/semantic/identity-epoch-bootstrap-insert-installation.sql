INSERT INTO semantic.identity_epoch_installation(partition_no,mode,transaction_id)
SELECT partition_no,mode,$1 FROM semantic.identity_epoch_installation_cut
WHERE partition_no=0 AND semantic.identity_epoch_installation_guards()
ON CONFLICT(partition_no) DO NOTHING
RETURNING partition_no;
