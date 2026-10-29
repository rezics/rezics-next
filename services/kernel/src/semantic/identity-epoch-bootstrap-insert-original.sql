INSERT INTO semantic.identity_epoch_original(partition_no,generation,original,terminal,source_partition,source_generation,present)
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(generation,original) DO UPDATE SET source_generation=excluded.source_generation,present=excluded.present;
