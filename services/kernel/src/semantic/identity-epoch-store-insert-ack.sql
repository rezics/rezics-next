INSERT INTO semantic.identity_epoch_ack(partition_no,job_id,step,version,scope_digest,progress,native_partition,native_epoch,native_position,native_transaction_id)
          VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9);
