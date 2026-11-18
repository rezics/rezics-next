SELECT home.partition_no,gate.* FROM unnest(:homes::integer[]) AS home(partition_no)
JOIN LATERAL (
  SELECT consumer,incarnation,owner_epoch,write_alias,closed_token,enrollment_generation,fence_generation
  FROM search.identity_writer_gate
  WHERE (partition_no,physical_target)=(home.partition_no,:physical_target::text) FOR SHARE
) gate ON true ORDER BY home.partition_no;
