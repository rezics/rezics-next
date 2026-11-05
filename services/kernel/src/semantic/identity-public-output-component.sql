SELECT epoch, (position+1)::text AS position FROM core.partition
WHERE partition_no=$1 AND write_state='active' AND moved_to IS NULL FOR UPDATE;
