SELECT p.partition_no,p.epoch,p.position,p.write_state
FROM unnest($1::integer[]) requested(partition_no)
JOIN LATERAL (SELECT * FROM core.partition WHERE partition_no=requested.partition_no LIMIT 1) p ON true;
