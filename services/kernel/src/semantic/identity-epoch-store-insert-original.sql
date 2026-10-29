INSERT INTO semantic.identity_epoch_original(partition_no,generation,original,terminal,source_partition,source_generation,present)
      VALUES($1,$2,$3,$3,$1,0,true);
