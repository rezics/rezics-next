-- Closed projection: node names and arbitrary moved-to URLs are not evidence.
SELECT write_state, epoch FROM core.partition WHERE partition_no = :partition::integer;
