INSERT INTO semantic.identity_epoch_bootstrap_home
        (partition_no,phase,after_route,after_original,after_member,owner_epoch)
        SELECT $1,'subjects',$2,$3,$3,epoch FROM core.partition WHERE partition_no=$1 AND write_state='active'
        ON CONFLICT DO NOTHING;
