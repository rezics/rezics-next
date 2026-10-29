INSERT INTO semantic.identity_epoch_group(partition_no,terminal,observed_count,generation)
            VALUES($1,$2,0,$3) ON CONFLICT(terminal) DO UPDATE SET terminal=excluded.terminal
            RETURNING generation,pending_job;
