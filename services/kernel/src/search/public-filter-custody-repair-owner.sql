SELECT epoch,write_state,position FROM core.partition
WHERE partition_no=:partition_no::integer FOR SHARE;
