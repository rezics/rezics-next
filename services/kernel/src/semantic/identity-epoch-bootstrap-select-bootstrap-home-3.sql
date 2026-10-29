SELECT partition_no FROM semantic.identity_epoch_bootstrap_home
    WHERE needs_work ORDER BY partition_no LIMIT 1;
