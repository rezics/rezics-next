SELECT home.partition_no,p.* FROM unnest(:homes::integer[]) AS home(partition_no)
JOIN LATERAL (
  SELECT epoch,write_state FROM core.partition WHERE partition_no=home.partition_no FOR SHARE
) p ON true ORDER BY home.partition_no;
