INSERT INTO semantic.identity_epoch_bootstrap_custody(partition_no,source_partition,source_generation,native_transaction_id,native_epoch,native_position,stage)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING;
