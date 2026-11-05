SELECT incarnation FROM search.public_filter_target
WHERE partition_no=:partition_no::integer AND physical_target=:physical_target::text FOR SHARE;
