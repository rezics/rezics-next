WITH parameters AS (SELECT $1::integer p1,$2::integer p2,$3::uuid p3)
INSERT INTO semantic.identity_epoch_bootstrap_home
        (partition_no,phase,after_route,after_original,after_member,owner_epoch)
        SELECT (SELECT p1 FROM parameters),'subjects',(SELECT p2 FROM parameters),(SELECT p3 FROM parameters),(SELECT p3 FROM parameters),epoch FROM core.partition WHERE partition_no=(SELECT p1 FROM parameters) AND write_state='active'
        ON CONFLICT DO NOTHING;
