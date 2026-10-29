WITH parameters AS (SELECT $1::integer p1,$2::uuid p2,$3::uuid[] p3)
INSERT INTO semantic.identity_epoch_input(partition_no,job_id,terminal,generation,basis_version,original_count,control_partition,owner_epoch)
        SELECT (SELECT p1 FROM parameters),(SELECT p2 FROM parameters),g.terminal,g.generation,g.version,g.observed_count,g.partition_no,g.owner_epoch FROM semantic.identity_epoch_group g
        WHERE g.partition_no=(SELECT p1 FROM parameters) AND g.terminal=ANY((SELECT p3 FROM parameters)::uuid[]);
