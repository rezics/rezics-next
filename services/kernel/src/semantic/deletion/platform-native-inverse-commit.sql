INSERT INTO semantic.erasure_source_commit(partition_no,transaction_id,epoch,position)
SELECT partition_no,$2,epoch,position+1 FROM core.partition WHERE partition_no=$1 AND write_state='active'
ON CONFLICT DO NOTHING
