SELECT epoch,position::text FROM core.partition WHERE partition_no=$1 AND write_state='active';
