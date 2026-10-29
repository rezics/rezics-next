INSERT INTO semantic.identity_epoch_group(partition_no,terminal,observed_count,generation,ready,owner_epoch)
      VALUES($1,$2,1,gen_random_uuid(),true,$3) RETURNING generation;
