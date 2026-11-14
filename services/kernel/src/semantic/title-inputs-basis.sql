SELECT p.partition_no AS "partitionNo",
       p.node,
       p.write_state AS "writeState",
       p.moved_to AS "movedTo",
       p.epoch,
       revision.revision::text AS "titleRevision"
FROM unnest(:partitions::integer[]) requested(partition_no)
JOIN LATERAL (
  SELECT partition_no, node, write_state, moved_to, epoch
  FROM core.partition
  WHERE partition_no = requested.partition_no
  LIMIT 1
) p ON true
JOIN semantic.title_input_home_revision revision USING (partition_no)
ORDER BY p.partition_no;
