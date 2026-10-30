INSERT INTO semantic.identity_epoch_group(partition_no,terminal,observed_count,generation,owner_epoch)
            VALUES($1,$2,0,gen_random_uuid(),$3) ON CONFLICT(partition_no,terminal) DO UPDATE SET terminal=excluded.terminal,owner_epoch=coalesce(semantic.identity_epoch_group.owner_epoch,excluded.owner_epoch)
            RETURNING generation,pending_job,owner_epoch,published_epoch;
