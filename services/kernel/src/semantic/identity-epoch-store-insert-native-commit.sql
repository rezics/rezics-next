INSERT INTO semantic.identity_epoch_native_commit
      (partition_no,transaction_id,epoch,position,purpose)
      SELECT partition_no,$2,epoch,position+1,$3 FROM core.partition
      WHERE partition_no=$1 AND write_state='active' FOR UPDATE RETURNING transaction_id;
