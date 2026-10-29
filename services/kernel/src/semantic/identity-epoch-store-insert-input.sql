INSERT INTO semantic.identity_epoch_input(partition_no,job_id,terminal,generation,basis_version,original_count)
        SELECT $1,$2,g.terminal,g.generation,g.version,g.observed_count FROM semantic.identity_epoch_group g
        WHERE g.partition_no=$1 AND g.terminal=ANY($3::uuid[]);
